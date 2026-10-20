import {UserFacingError} from './ytdlp'

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers},
  })
}

/** The message and status to show for any error thrown while yoinking. */
export function describeError(error: unknown): {message: string; status: number} {
  if (error instanceof UserFacingError) return {message: error.message, status: error.status}
  const message = error instanceof Error && error.message ? error.message : 'Something went wrong.'
  return {message: message.length > 240 ? `${message.slice(0, 239)}…` : message, status: 500}
}

/** RFC 6266 attachment header with an ascii fallback for old clients. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
