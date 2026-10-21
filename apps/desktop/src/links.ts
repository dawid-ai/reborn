// Hosts the renderer may open in the default browser, for credit and
// documentation links. Every other window request is denied.
const EXTERNAL_HOSTS = new Set(['github.com'])

/** Whether a renderer link may open in the default browser. */
export function isExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && EXTERNAL_HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password
  } catch {
    return false
  }
}
