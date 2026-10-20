import {formatBytes} from './format'

/** The subset of yt-dlp's -J output the picker needs. */
export type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type Choice = {
  /** Opaque id the client sends back — the server maps it to a format selector. */
  id: string
  kind: 'video' | 'audio'
  ext: 'mp4' | 'mp3'
  label: string
  size?: string
}

const MAX_VIDEO_CHOICES = 8

const hasVideo = (f: RawFormat) => Boolean(f.vcodec && f.vcodec !== 'none')
const hasAudio = (f: RawFormat) => Boolean(f.acodec && f.acodec !== 'none')

export function buildChoices(formats: RawFormat[] = []): Choice[] {
  const choices: Choice[] = []

  const audioOnly = formats.filter(f => hasAudio(f) && !hasVideo(f))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => hasVideo(f) && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]!
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (hasAudio(best) ? 0 : (audioSize ?? 0))
    choices.push({
      id: `v${height}`,
      kind: 'video',
      ext: 'mp4',
      label: `${height}p`,
      size: size > 0 ? formatBytes(size) : undefined,
    })
  }

  // no heights to list: offer "best" unless this is clearly audio-only
  // (some sites report no codecs at all, so "no audio either" counts as video)
  if (choices.length === 0 && (formats.some(hasVideo) || !formats.some(hasAudio))) {
    choices.push({id: 'best', kind: 'video', ext: 'mp4', label: 'best available'})
  }

  choices.push({
    id: 'mp3',
    kind: 'audio',
    ext: 'mp3',
    label: 'audio only',
    size: audioSize ? formatBytes(audioSize) : undefined,
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

/**
 * Map a choice id to a yt-dlp format selector. Within a resolution, prefer
 * h264 + aac: it merges into an mp4 that plays everywhere (QuickTime, iOS,
 * Windows' Photos app) — VP9/AV1 only win when nothing else exists.
 */
export function selectorFor(id: string): string | undefined {
  if (id === 'mp3') return 'ba/b'
  if (id === 'best') return 'bv*[vcodec^=avc]+ba[acodec^=mp4a]/bv*+ba/b'
  const height = /^v(\d{2,4})$/.exec(id)?.[1]
  if (!height) return undefined
  const h = Number(height)
  return [
    `bv*[height=${h}][vcodec^=avc]+ba[acodec^=mp4a]`,
    `b[height=${h}][ext=mp4]`,
    `bv*[height=${h}]+ba`,
    `b[height=${h}]`,
    `bv*[height<=${h}]+ba`,
    `b[height<=${h}]`,
    'b',
  ].join('/')
}
