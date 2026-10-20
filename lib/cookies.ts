/**
 * Turn whatever ended up in YTDLP_COOKIES into a Netscape cookies.txt that
 * yt-dlp accepts. People paste the file raw, raw with its tabs flattened to
 * spaces by a settings form, or base64-encoded (with or without line breaks).
 * Returns undefined when nothing usable is in there.
 */
export function normalizeCookies(input: string | undefined): string | undefined {
  const raw = input?.trim()
  if (!raw) return undefined

  const text = looksLikeCookieFile(raw) ? raw : decodeBase64(raw)
  if (!text) return undefined

  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => (line.startsWith('#') || line.includes('\t') ? line : restoreTabs(line)))
  const cookies = lines.filter(line => line.split('\t').length >= 7)
  if (cookies.length === 0) return undefined

  // yt-dlp refuses files without the Netscape header
  const header = lines[0]?.startsWith('# Netscape HTTP Cookie File') || lines[0]?.startsWith('# HTTP Cookie File') ? [] : ['# Netscape HTTP Cookie File']
  return `${[...header, ...lines].join('\n').trim()}\n`
}

function looksLikeCookieFile(text: string): boolean {
  return text.startsWith('#') || text.includes('\t') || /^\.?[a-z0-9.-]+\.[a-z]{2,}\s+(TRUE|FALSE)\s/im.test(text)
}

function decodeBase64(text: string): string | undefined {
  const compact = text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return undefined
  const decoded = Buffer.from(compact, 'base64').toString('utf8')
  return looksLikeCookieFile(decoded) ? decoded : undefined
}

/** domain, include-subdomains, path, secure, expiry, name, value — the value may itself contain spaces. */
function restoreTabs(line: string): string {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 7 || !/^(TRUE|FALSE)$/i.test(fields[1]!)) return line
  return [...fields.slice(0, 6), fields.slice(6).join(' ')].join('\t')
}
