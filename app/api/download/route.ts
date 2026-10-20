import {contentDisposition, describeError} from '@/lib/http'
import {normalizeUrl} from '@/lib/platforms'
import {startDownload} from '@/lib/ytdlp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// the whole file streams through this function — give it as long as the plan allows
export const maxDuration = 300

/**
 * Streams the file as an attachment, so the browser's own download manager
 * shows progress. The page can't see that response, so a short-lived cookie
 * named after the page's token reports back "started" or the error message.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const url = normalizeUrl(params.get('url') ?? '')
  const choice = params.get('choice') ?? ''
  const token = params.get('token') ?? ''
  const cookieName = /^[a-z0-9]{6,40}$/i.test(token) ? `yoinks_dl_${token}` : undefined
  const signal = (value: string): Record<string, string> =>
    cookieName ? {'Set-Cookie': `${cookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=600; SameSite=Lax`} : {}

  if (!url) return failure('Paste a link that starts with http:// or https://', 400, signal)

  try {
    const download = await startDownload(url, choice, request.signal)
    const headers: Record<string, string> = {
      'Content-Type': download.contentType,
      'Content-Disposition': contentDisposition(download.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...signal('ok'),
    }
    if (download.contentLength) headers['Content-Length'] = String(download.contentLength)
    return new Response(download.stream, {headers})
  } catch (error) {
    const {message, status} = describeError(error)
    if (status >= 500) console.error('[download]', url, choice, error)
    return failure(message, status, signal)
  }
}

function failure(message: string, status: number, signal: (value: string) => Record<string, string>): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...signal(`error:${message}`)},
  })
}
