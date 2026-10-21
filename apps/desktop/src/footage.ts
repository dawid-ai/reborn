import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type FootageCandidate, type FootageSearchRequest, type FootageSearchResult, studio } from '@reborn/studio-core'
import type { SecretBox } from './agent'
import { writeAtomic } from './project-dir'

// Stock footage search and download for the Video view. All network access
// for footage happens here, in the main process: only the providers' hosts
// are reachable (redirects included), responses are type- and size-checked,
// and API keys stay in the OS credential store.

type Provider = studio.FootageProvider
type LicenceKind = studio.LicenceKind

/** Hosts footage requests may reach, including every redirect hop. */
export const FOOTAGE_HOSTS = [/^api\.pexels\.com$/, /^(images|videos)\.pexels\.com$/, /^(www\.)?pixabay\.com$/, /^cdn\.pixabay\.com$/, /^commons\.wikimedia\.org$/, /^upload\.wikimedia\.org$/, /^archive\.org$/, /^ia\d+\.us\.archive\.org$/, /^[a-z0-9-]+\.us\.archive\.org$/]

export const isFootageHost = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && FOOTAGE_HOSTS.some((host) => host.test(parsed.hostname))
  } catch {
    return false
  }
}

const THUMBNAIL_BYTES = 140_000
const PER_PROVIDER = 8

export interface FootageServiceOptions {
  directory: string
  secrets: SecretBox
  version: string
  fetchImpl?: typeof fetch
  /** Milliseconds to wait before retry n (1-based); tests pass zero. */
  backoff?: (attempt: number) => number
}

export class FootageService {
  private readonly keyFile: string
  private readonly fetchImpl: typeof fetch
  private readonly backoff: (attempt: number) => number

  constructor(private readonly options: FootageServiceOptions) {
    this.keyFile = join(options.directory, 'footage-keys.bin')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.backoff = options.backoff ?? ((attempt) => 800 * 2 ** (attempt - 1))
  }

  private async keys(): Promise<Partial<Record<'pexels' | 'pixabay', string>>> {
    if (!existsSync(this.keyFile)) return {}
    try {
      return JSON.parse(this.options.secrets.decryptString(await readFile(this.keyFile))) as Partial<Record<'pexels' | 'pixabay', string>>
    } catch {
      return {}
    }
  }

  async keyStatus(): Promise<{ pexels: boolean; pixabay: boolean }> {
    const keys = await this.keys()
    return { pexels: Boolean(keys.pexels), pixabay: Boolean(keys.pixabay) }
  }

  async setKeys(patch: { pexels?: string | null; pixabay?: string | null }): Promise<{ pexels: boolean; pixabay: boolean }> {
    if (!this.options.secrets.isEncryptionAvailable()) throw new Error('The OS credential store is unavailable, so keys cannot be stored safely.')
    const keys = await this.keys()
    for (const name of ['pexels', 'pixabay'] as const) {
      const value = patch[name]
      if (value === null) delete keys[name]
      else if (typeof value === 'string' && value.trim()) keys[name] = value.trim()
    }
    await writeAtomic(this.keyFile, this.options.secrets.encryptString(JSON.stringify(keys)))
    return this.keyStatus()
  }

  /** Searches each provider the request names; one failing provider doesn't stop the others. */
  async search(request: FootageSearchRequest): Promise<FootageSearchResult> {
    const query = String(request.query ?? '').trim().slice(0, 100)
    if (!query) throw new Error('Enter what to search for.')
    const keys = await this.keys()
    const limit = Math.min(20, Math.max(1, request.perProvider ?? PER_PROVIDER))
    const candidates: FootageCandidate[] = []
    const errors: FootageSearchResult['errors'] = []
    await Promise.all(
      request.providers.map(async (provider) => {
        try {
          const found = await this.searchProvider(provider, query, limit, keys)
          candidates.push(...found.filter((c) => studio.licenceAllowed(c.licence, request.licences)))
        } catch (error) {
          errors.push({ provider, message: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
    // Thumbnails come through here too, so the page never reaches the providers.
    await Promise.all(candidates.map(async (c) => (c.thumbnail = c.thumbnail ? await this.thumbnail(c.thumbnail).catch(() => '') : '')))
    return { candidates, errors }
  }

  /** Downloads a clip within the byte limit and returns its bytes and type. */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: ArrayBuffer; mimeType: string }> {
    const response = await this.get(url, { accept: /^video\//, signal })
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > maxBytes) throw new Error(`The clip is ${(length / 1e6).toFixed(0)} MB, over the ${(maxBytes / 1e6).toFixed(0)} MB left in the brief's download limit.`)
    const data = await readLimited(response, maxBytes)
    return { data, mimeType: (response.headers.get('content-type') ?? 'video/mp4').split(';')[0].trim() }
  }

  // ---------------------------------------------------------------------------

  private async searchProvider(provider: Provider, query: string, limit: number, keys: Partial<Record<'pexels' | 'pixabay', string>>): Promise<FootageCandidate[]> {
    switch (provider) {
      case 'pexels': {
        if (!keys.pexels) throw new Error('Add a Pexels API key in the footage settings.')
        const body = await this.json(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${limit}`, { authorization: keys.pexels })
        return parsePexels(body, query)
      }
      case 'pixabay': {
        if (!keys.pixabay) throw new Error('Add a Pixabay API key in the footage settings.')
        const body = await this.json(`https://pixabay.com/api/videos/?key=${encodeURIComponent(keys.pixabay)}&q=${encodeURIComponent(query)}&per_page=${Math.max(3, limit)}&safesearch=true`)
        return parsePixabay(body, query)
      }
      case 'wikimedia': {
        const params = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: `${query} filetype:video`, gsrlimit: String(limit), prop: 'videoinfo', viprop: 'url|size|mime|extmetadata|derivatives', viurlwidth: '320', origin: '*' })
        return parseWikimedia(await this.json(`https://commons.wikimedia.org/w/api.php?${params}`), query)
      }
      case 'archive': {
        const q = `(${query}) AND mediatype:(movies) AND licenseurl:(*publicdomain*)`
        const params = new URLSearchParams({ q, rows: String(limit), output: 'json' })
        for (const field of ['identifier', 'title', 'creator', 'licenseurl']) params.append('fl[]', field)
        const search = (await this.json(`https://archive.org/advancedsearch.php?${params}`)) as { response?: { docs?: ArchiveDoc[] } }
        const docs = search.response?.docs ?? []
        const found = await Promise.all(docs.map(async (doc) => parseArchive(doc, (await this.json(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`).catch(() => null)) as ArchiveMetadata | null, query)))
        return found.filter((c): c is FootageCandidate => c !== null)
      }
    }
  }

  private async thumbnail(url: string): Promise<string> {
    const response = await this.get(url, { accept: /^image\// })
    const data = await readLimited(response, THUMBNAIL_BYTES)
    const type = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
    return `data:${type};base64,${Buffer.from(data).toString('base64')}`
  }

  private async json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.get(url, { accept: /json/, headers })
    return JSON.parse(new TextDecoder().decode(await readLimited(response, 5_000_000)))
  }

  /**
   * GET with the allow-list checked on every hop, a polite User-Agent, a
   * content-type check (an HTML error page is not a video), and retries with
   * backoff on rate limits and server errors.
   */
  private async get(url: string, options: { accept: RegExp; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      let current = url
      let response: Response | null = null
      for (let hop = 0; hop < 6; hop += 1) {
        if (!isFootageHost(current)) throw new Error(`Footage can only come from the footage providers; ${new URL(current).hostname} is not one.`)
        response = await this.fetchImpl(current, { redirect: 'manual', signal: options.signal, headers: { 'user-agent': `RE-BORN/${this.options.version} (music video maker)`, ...(options.headers ?? {}) } })
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          current = new URL(location, current).toString()
          continue
        }
        break
      }
      if (!response) throw new Error('No response.')
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, this.backoff(attempt)))
        continue
      }
      if (response.status === 401 || response.status === 403) throw new Error('The provider rejected the request. Check the API key.')
      if (!response.ok) throw new Error(`The provider answered ${response.status}.`)
      const type = response.headers.get('content-type') ?? ''
      if (!options.accept.test(type)) throw new Error(`Expected ${options.accept.source.replace(/[\\^/]/g, '')} but got ${type || 'an unknown type'}.`)
      return response
    }
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      // Not awaited: a teed stream only settles its cancel when both branches cancel.
      void reader.cancel().catch(() => undefined)
      throw new Error(`The download is over the ${(maxBytes / 1e6).toFixed(1)} MB limit.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out.buffer
}

// Provider responses -----------------------------------------------------------

/** Picks the file closest to 1080p, never above 1440p, so downloads stay reasonable. */
function pickFile<T extends { width: number; height: number }>(files: T[]): T | null {
  const usable = files.filter((f) => f.width > 0 && Math.min(f.width, f.height) <= 1440)
  if (!usable.length) return null
  return usable.sort((a, z) => Math.abs(Math.min(a.width, a.height) - 1080) - Math.abs(Math.min(z.width, z.height) - 1080))[0]
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

export function licenceFromName(name: string): LicenceKind {
  const n = name.toLowerCase()
  if (/\bnc\b|\bnd\b|noncommercial|noderiv/.test(n)) return 'other'
  if (/cc0|cc-zero|creative commons zero/.test(n)) return 'cc0'
  if (/public domain|^pd\b|pd-/.test(n)) return 'pd'
  if (/by-sa|by sa/.test(n)) return 'cc-by-sa'
  if (/cc by|cc-by/.test(n)) return 'cc-by'
  return 'other'
}

interface PexelsVideo {
  id: number
  url: string
  image: string
  duration: number
  width: number
  height: number
  user?: { name?: string }
  video_files?: { file_type?: string; width: number; height: number; link: string }[]
}

export function parsePexels(body: unknown, query: string): FootageCandidate[] {
  const videos = ((body as { videos?: PexelsVideo[] })?.videos ?? []).filter(Boolean)
  return videos.flatMap((video) => {
    const file = pickFile((video.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && isFootageHost(f.link)))
    if (!file) return []
    const thumbnail = video.image ? `${video.image.split('?')[0]}?auto=compress&cs=tinysrgb&w=320` : ''
    return [{ provider: 'pexels' as const, sourceId: String(video.id), title: titleFromPage(video.url) || `Pexels video ${video.id}`, page: video.url, author: video.user?.name ?? '', licence: 'pexels' as const, licenceName: 'Pexels License', licenceUrl: 'https://www.pexels.com/license/', thumbnail, url: file.link, width: file.width, height: file.height, duration: video.duration, query }]
  })
}

const titleFromPage = (url: string) => {
  const slug = /\/video\/([a-z0-9-]+?)-?\d*\/?$/i.exec(url ?? '')?.[1] ?? ''
  return slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

interface PixabayHit {
  id: number
  pageURL: string
  tags?: string
  duration: number
  user?: string
  videos?: Record<string, { url: string; width: number; height: number; thumbnail?: string }>
}

export function parsePixabay(body: unknown, query: string): FootageCandidate[] {
  const hits = (body as { hits?: PixabayHit[] })?.hits ?? []
  return hits.flatMap((hit) => {
    const files = Object.values(hit.videos ?? {}).filter((f) => f?.url?.startsWith('https://'))
    const file = pickFile(files)
    if (!file) return []
    return [{ provider: 'pixabay' as const, sourceId: String(hit.id), title: hit.tags ? hit.tags.split(',').map((tag) => tag.trim()).slice(0, 3).join(', ') : `Pixabay video ${hit.id}`, page: hit.pageURL, author: hit.user ?? '', licence: 'pixabay' as const, licenceName: 'Pixabay Content License', licenceUrl: 'https://pixabay.com/service/license-summary/', thumbnail: hit.videos?.medium?.thumbnail ?? hit.videos?.small?.thumbnail ?? '', url: file.url, width: file.width, height: file.height, duration: hit.duration, query }]
  })
}

interface WikimediaPage {
  title: string
  videoinfo?: {
    url: string
    thumburl?: string
    descriptionurl: string
    width: number
    height: number
    duration?: number
    mime: string
    extmetadata?: Record<string, { value?: string }>
    derivatives?: { src: string; type: string; width: number; height: number }[]
  }[]
}

export function parseWikimedia(body: unknown, query: string): FootageCandidate[] {
  const pages = Object.values((body as { query?: { pages?: Record<string, WikimediaPage> } })?.query?.pages ?? {})
  return pages.flatMap((page) => {
    const info = page.videoinfo?.[0]
    if (!info) return []
    // Theora and other old formats don't decode in the app; transcoded WebM and MP4 do.
    const options = [...(info.derivatives ?? []).filter((d) => /webm|mp4/.test(d.type) && !/theora/.test(d.type)).map((d) => ({ url: d.src, width: d.width, height: d.height })), ...(/video\/(webm|mp4)/.test(info.mime) ? [{ url: info.url, width: info.width, height: info.height }] : [])]
    const file = pickFile(options.filter((o) => o.url?.startsWith('https://')))
    if (!file) return []
    const meta = info.extmetadata ?? {}
    const licenceName = stripTags(meta.LicenseShortName?.value ?? 'Unknown licence')
    return [
      {
        provider: 'wikimedia' as const,
        sourceId: page.title,
        title: page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
        page: info.descriptionurl,
        author: stripTags(meta.Artist?.value ?? ''),
        licence: licenceFromName(licenceName),
        licenceName,
        licenceUrl: meta.LicenseUrl?.value ?? '',
        thumbnail: info.thumburl ?? '',
        url: file.url,
        width: file.width,
        height: file.height,
        duration: info.duration ?? 0,
        query,
      },
    ]
  })
}

interface ArchiveDoc {
  identifier: string
  title?: string
  creator?: string | string[]
  licenseurl?: string
}

interface ArchiveMetadata {
  server?: string
  dir?: string
  files?: { name: string; format?: string; width?: string; height?: string; length?: string }[]
}

export function parseArchive(doc: ArchiveDoc, metadata: ArchiveMetadata | null, query: string): FootageCandidate | null {
  const files = (metadata?.files ?? []).filter((f) => /\.mp4$/i.test(f.name) && /h\.264|mpeg4/i.test(f.format ?? ''))
  const file = files.sort((a, z) => Number(z.height ?? 0) - Number(a.height ?? 0)).find((f) => Number(f.height ?? 0) <= 1080) ?? files[0]
  if (!file) return null
  const licence = /publicdomain\/zero/.test(doc.licenseurl ?? '') ? 'cc0' : 'pd'
  const duration = String(file.length ?? '').includes(':') ? String(file.length).split(':').reduce((sum, part) => sum * 60 + Number(part), 0) : Number(file.length ?? 0)
  return {
    provider: 'archive',
    sourceId: doc.identifier,
    title: doc.title ?? doc.identifier,
    page: `https://archive.org/details/${doc.identifier}`,
    author: Array.isArray(doc.creator) ? doc.creator.join(', ') : (doc.creator ?? ''),
    licence,
    licenceName: licence === 'cc0' ? 'CC0' : 'Public domain',
    licenceUrl: doc.licenseurl ?? '',
    thumbnail: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
    url: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
    width: Number(file.width ?? 0) || 640,
    height: Number(file.height ?? 0) || 480,
    duration,
    query,
  }
}
