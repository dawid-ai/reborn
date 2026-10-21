import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FootageService, isFootageHost, licenceFromName, parseArchive, parsePexels, parsePixabay, parseWikimedia } from './footage'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-footage-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const secrets = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text, 'utf8'), decryptString: (data: Buffer) => data.toString('utf8') }

type Route = (url: string, init?: RequestInit) => Response
function fakeFetch(routes: Record<string, Route | Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })
    const route = routes[key]
    return typeof route === 'function' ? route(url, init) : route.clone()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const image = () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } })

describe('provider responses', () => {
  it('reads Pexels videos and picks a file near 1080p', () => {
    const [clip] = parsePexels(
      {
        videos: [
          {
            id: 7,
            url: 'https://www.pexels.com/video/lightning-over-the-sea-7/',
            image: 'https://images.pexels.com/videos/7/pic.jpeg?x=1',
            duration: 14,
            user: { name: 'Ana' },
            video_files: [
              { file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/7/4k.mp4' },
              { file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/video-files/7/hd.mp4' },
              { file_type: 'video/mp4', width: 1280, height: 720, link: 'https://player.vimeo.com/external/7.mp4' },
            ],
          },
        ],
      },
      'lightning',
    )
    expect(clip).toMatchObject({ provider: 'pexels', sourceId: '7', title: 'Lightning over the sea', author: 'Ana', licence: 'pexels', url: 'https://videos.pexels.com/video-files/7/hd.mp4', width: 1920 })
    expect(clip.thumbnail).toBe('https://images.pexels.com/videos/7/pic.jpeg?auto=compress&cs=tinysrgb&w=320')
  })

  it('reads Pixabay hits', () => {
    const [clip] = parsePixabay({ hits: [{ id: 3, pageURL: 'https://pixabay.com/videos/id-3/', tags: 'storm, clouds, sky, weather', duration: 20, user: 'Ben', videos: { large: { url: 'https://cdn.pixabay.com/video/3/large.mp4', width: 1920, height: 1080 }, medium: { url: 'https://cdn.pixabay.com/video/3/medium.mp4', width: 1280, height: 720, thumbnail: 'https://cdn.pixabay.com/video/3/thumb.jpg' } } }] }, 'storm')
    expect(clip).toMatchObject({ provider: 'pixabay', title: 'storm, clouds, sky', licence: 'pixabay', url: 'https://cdn.pixabay.com/video/3/large.mp4', thumbnail: 'https://cdn.pixabay.com/video/3/thumb.jpg' })
  })

  it('reads Wikimedia Commons licences and prefers transcoded WebM over Theora', () => {
    const [clip] = parseWikimedia(
      {
        query: {
          pages: {
            1: {
              title: 'File:Lava flow.ogv',
              videoinfo: [
                {
                  url: 'https://upload.wikimedia.org/x/Lava_flow.ogv',
                  mime: 'application/ogg',
                  width: 1920,
                  height: 1080,
                  duration: 33,
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lava_flow.ogv',
                  thumburl: 'https://upload.wikimedia.org/thumb.jpg',
                  extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Carla</a>' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } },
                  derivatives: [
                    { src: 'https://upload.wikimedia.org/x/Lava_flow.ogv.480p.ogv', type: 'video/ogg; codecs="theora, vorbis"', width: 854, height: 480 },
                    { src: 'https://upload.wikimedia.org/x/Lava_flow.ogv.1080p.vp9.webm', type: 'video/webm; codecs="vp9, opus"', width: 1920, height: 1080 },
                  ],
                },
              ],
            },
          },
        },
      },
      'lava',
    )
    expect(clip).toMatchObject({ title: 'Lava flow', author: 'Carla', licence: 'cc-by-sa', licenceName: 'CC BY-SA 4.0', url: 'https://upload.wikimedia.org/x/Lava_flow.ogv.1080p.vp9.webm', duration: 33 })
  })

  it('reads Internet Archive items with an H.264 file', () => {
    const clip = parseArchive({ identifier: 'old_film', title: 'Old film', licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/' }, { files: [{ name: 'old_film.ogv', format: 'Ogg Video' }, { name: 'old_film.mp4', format: 'h.264', width: '640', height: '480', length: '01:30' }] }, 'old film')
    expect(clip).toMatchObject({ licence: 'pd', url: 'https://archive.org/download/old_film/old_film.mp4', duration: 90, width: 640 })
  })

  it('maps licence names, refusing NC and ND', () => {
    expect(['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-NC 4.0', 'CC BY-ND 2.0', 'GFDL'].map(licenceFromName)).toEqual(['cc0', 'pd', 'cc-by', 'cc-by-sa', 'other', 'other', 'other'])
  })
})

describe('footage service', () => {
  const service = (fetchImpl: typeof fetch) => new FootageService({ directory: root, secrets, version: 'test', fetchImpl, backoff: () => 0 })

  it('only reaches the providers, redirects included', async () => {
    expect(isFootageHost('https://upload.wikimedia.org/a.webm')).toBe(true)
    expect(isFootageHost('http://upload.wikimedia.org/a.webm')).toBe(false)
    expect(isFootageHost('https://evil.example.com/a.mp4')).toBe(false)
    const { fetchImpl, calls } = fakeFetch({ 'https://archive.org/download/x/x.mp4': new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.mp4' } }) })
    await expect(service(fetchImpl).download('https://archive.org/download/x/x.mp4', 1e6)).rejects.toThrow(/evil.example.com is not one/)
    expect(calls).toEqual(['https://archive.org/download/x/x.mp4'])
  })

  it('follows allowed redirects, checks the type, and enforces the size limit', async () => {
    const { fetchImpl } = fakeFetch({
      'https://archive.org/download/a/a.mp4': new Response(null, { status: 302, headers: { location: 'https://ia800.us.archive.org/a.mp4' } }),
      'https://ia800.us.archive.org/a.mp4': new Response(new Uint8Array(10), { headers: { 'content-type': 'video/mp4' } }),
      'https://archive.org/download/html': new Response('<html>rate limited</html>', { headers: { 'content-type': 'text/html' } }),
      'https://archive.org/download/big': new Response(new Uint8Array(100), { headers: { 'content-type': 'video/mp4' } }),
    })
    const ok = await service(fetchImpl).download('https://archive.org/download/a/a.mp4', 1000)
    expect(ok).toMatchObject({ mimeType: 'video/mp4' })
    expect(ok.data.byteLength).toBe(10)
    await expect(service(fetchImpl).download('https://archive.org/download/html', 1000)).rejects.toThrow(/Expected video/)
    await expect(service(fetchImpl).download('https://archive.org/download/big', 50)).rejects.toThrow(/over the/)
  })

  it('retries rate limits, then gives up', async () => {
    let tries = 0
    const { fetchImpl } = fakeFetch({ 'https://cdn.pixabay.com/x.mp4': () => (++tries < 3 ? new Response('', { status: 429 }) : new Response(new Uint8Array(4), { headers: { 'content-type': 'video/mp4' } })) })
    await expect(service(fetchImpl).download('https://cdn.pixabay.com/x.mp4', 100)).resolves.toMatchObject({ mimeType: 'video/mp4' })
    expect(tries).toBe(3)
  })

  it('searches providers, drops licences the policy excludes, and fetches thumbnails itself', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://commons.wikimedia.org/w/api.php': json({
        query: {
          pages: {
            1: { title: 'File:A.webm', videoinfo: [{ url: 'https://upload.wikimedia.org/A.webm', mime: 'video/webm', width: 1280, height: 720, descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.webm', thumburl: 'https://upload.wikimedia.org/a.jpg', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
            2: { title: 'File:B.webm', videoinfo: [{ url: 'https://upload.wikimedia.org/B.webm', mime: 'video/webm', width: 1280, height: 720, descriptionurl: 'https://commons.wikimedia.org/wiki/File:B.webm', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }] },
          },
        },
      }),
      'https://upload.wikimedia.org/a.jpg': image(),
    })
    const result = await service(fetchImpl).search({ query: 'lava', providers: ['wikimedia', 'pexels'], licences: 'safe' })
    expect(result.candidates.map((c) => c.title)).toEqual(['A'])
    expect(result.candidates[0].thumbnail).toBe('data:image/jpeg;base64,/9j/')
    expect(result.errors).toEqual([{ provider: 'pexels', message: 'Add a Pexels API key in the footage settings.' }])
    expect(calls.every((url) => isFootageHost(url))).toBe(true)
  })

  it('stores API keys encrypted and reports which are set', async () => {
    const s = service(fakeFetch({}).fetchImpl)
    expect(await s.keyStatus()).toEqual({ pexels: false, pixabay: false })
    expect(await s.setKeys({ pexels: 'abc' })).toEqual({ pexels: true, pixabay: false })
    expect(await s.setKeys({ pexels: null, pixabay: 'xyz' })).toEqual({ pexels: false, pixabay: true })
  })
})
