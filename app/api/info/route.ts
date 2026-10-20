import {buildChoices} from '@/lib/choices'
import {describeError, json} from '@/lib/http'
import {detectPlatform, normalizeUrl} from '@/lib/platforms'
import {probe} from '@/lib/ytdlp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const url = normalizeUrl(new URL(request.url).searchParams.get('url') ?? '')
  if (!url) return json({error: 'Paste a link that starts with http:// or https://'}, 400)

  try {
    const info = await probe(url, request.signal)
    const formats = info.formats?.length ? info.formats : info.url ? [info] : []
    return json({
      url,
      title: info.title || 'untitled',
      uploader: info.uploader || info.channel || undefined,
      duration: info.duration || undefined,
      thumbnail: info.thumbnail?.startsWith('https://') ? info.thumbnail : undefined,
      platform: detectPlatform(info.webpage_url || url),
      choices: buildChoices(formats),
    })
  } catch (error) {
    const {message, status} = describeError(error)
    if (status >= 500) console.error('[info]', url, error)
    return json({error: message}, status)
  }
}
