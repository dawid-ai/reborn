// electron-updater serves GitHub release notes as HTML from the releases
// feed. The studio shows them as plain text, so this flattens the HTML: list
// items become bullet lines and common entities are decoded.

type ReleaseNoteInfo = { version: string; note: string | null }

/** Converts an HTML fragment to readable plain text. */
export function stripHtml(html: string): string {
  return (
    html
      // Raw newlines and <br> are wrapping, not structure: GitHub renders
      // hard-wrapped source lines as <br>. Structure comes from block tags.
      .replace(/\s+/g, ' ')
      .replace(/<\s*br\s*\/?>/gi, ' ')
      .replace(/<\s*hr\s*\/?>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '• ')
      .replace(/<\/\s*(p|div|h[1-6]|ul|ol|li)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&amp;/g, '&')
      .replace(/ {2,}/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** electron-updater's `releaseNotes` is a string, a list per version, or null. */
export function notesToText(notes: string | ReleaseNoteInfo[] | null | undefined): string {
  if (!notes) return ''
  if (typeof notes === 'string') return stripHtml(notes)
  return notes
    .map((n) => (n.note ? stripHtml(n.note) : ''))
    .filter(Boolean)
    .join('\n\n')
}
