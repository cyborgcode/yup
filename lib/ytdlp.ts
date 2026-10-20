import {spawn, type ChildProcess, type StdioOptions} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {constants as fsConstants, createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import ffmpegStatic from 'ffmpeg-static'
import {selectorFor, type RawFormat} from './choices'
import {safeFilename} from './format'
import {assertPublicUrl, BlockedUrlError} from './net-guard'

const WORK_DIR = path.join(os.tmpdir(), 'yoinks')
const INFO_DIR = path.join(WORK_DIR, 'info')
const JOB_DIR = path.join(WORK_DIR, 'jobs')
const BIN_DIR = path.join(WORK_DIR, 'bin')
/** yt-dlp writes hls/dash fragments next to its output — for `-o -` that's its cwd. */
const FRAG_DIR = path.join(WORK_DIR, 'frag')
/** Probe results are reused by the download that usually follows within a minute. */
const INFO_TTL_MS = 10 * 60 * 1000
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

/** An error whose message is safe and useful to show to whoever pasted the link. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- binaries

type Binary = {path: string; extraArgs: string[]}

let ytDlpPromise: Promise<Binary> | undefined
let ffmpegPromise: Promise<string> | undefined

export function getYtDlp(): Promise<Binary> {
  ytDlpPromise ??= locateYtDlp().catch(error => {
    ytDlpPromise = undefined
    throw error
  })
  return ytDlpPromise
}

export function getFfmpeg(): Promise<string> {
  ffmpegPromise ??= locateFfmpeg().catch(error => {
    ffmpegPromise = undefined
    throw error
  })
  return ffmpegPromise
}

/**
 * Resolve a usable yt-dlp: an explicit YTDLP_PATH, the copy bundled into the
 * function at build time, a system install, then the standalone release
 * binary downloaded into /tmp as a last resort.
 */
async function locateYtDlp(): Promise<Binary> {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(process.cwd(), 'bin', 'yt-dlp'),
    'yt-dlp',
    path.join(BIN_DIR, 'yt-dlp'),
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    const usable = await ensureExecutable(candidate)
    const version = usable && (await versionOf(usable, '--version'))
    if (usable && version) return {path: usable, extraArgs: jsRuntimeArgs(version)}
  }

  const target = path.join(BIN_DIR, 'yt-dlp')
  const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
  const response = await fetch(`${RELEASE_BASE}/${asset}`)
  if (!response.ok || !response.body) throw new Error(`Could not download yt-dlp (HTTP ${response.status}).`)
  await fs.mkdir(BIN_DIR, {recursive: true})
  const tmp = `${target}.${process.pid}.download`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp))
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, target)
  const version = await versionOf(target, '--version')
  if (!version) throw new Error('Downloaded yt-dlp does not run on this machine.')
  return {path: target, extraArgs: jsRuntimeArgs(version)}
}

/**
 * YouTube needs a JavaScript runtime to solve its player challenges. yt-dlp
 * only enables deno by default, but the node running this server works too.
 */
function jsRuntimeArgs(version: string): string[] {
  return version >= '2025.11' ? ['--js-runtimes', `node:${process.execPath}`] : []
}

async function locateFfmpeg(): Promise<string> {
  const candidates = [process.env.FFMPEG_PATH, ffmpegStatic, 'ffmpeg'].filter((c): c is string => Boolean(c))
  for (const candidate of candidates) {
    const usable = await ensureExecutable(candidate)
    if (usable && (await versionOf(usable, '-version'))) return usable
  }
  throw new Error('ffmpeg is not available on this server.')
}

/**
 * Bare command names are looked up on PATH as-is. Files that lost their
 * executable bit on the way into a read-only bundle get copied to /tmp.
 */
async function ensureExecutable(candidate: string): Promise<string | undefined> {
  if (!candidate.includes(path.sep)) return candidate
  try {
    await fs.access(candidate, fsConstants.X_OK)
    return candidate
  } catch {
    try {
      await fs.access(candidate, fsConstants.R_OK)
    } catch {
      return undefined
    }
  }
  const copy = path.join(BIN_DIR, path.basename(candidate))
  await fs.mkdir(BIN_DIR, {recursive: true})
  await fs.copyFile(candidate, copy)
  await fs.chmod(copy, 0o755)
  return copy
}

function versionOf(cmd: string, flag: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn(cmd, [flag], {stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000})
    } catch {
      resolve(undefined)
      return
    }
    child.stdout?.on('data', chunk => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve(code === 0 ? out.trim().split('\n')[0] : undefined))
  })
}

let cookiesPath: Promise<string | undefined> | undefined

/** YTDLP_COOKIES holds a Netscape cookies.txt (raw or base64) for sites that want a login. */
function getCookiesFile(): Promise<string | undefined> {
  cookiesPath ??= (async () => {
    const raw = process.env.YTDLP_COOKIES?.trim()
    if (!raw) return undefined
    const text = raw.includes('\t') ? raw : Buffer.from(raw, 'base64').toString('utf8')
    const file = path.join(WORK_DIR, 'cookies.txt')
    await fs.mkdir(WORK_DIR, {recursive: true})
    await fs.writeFile(file, text.endsWith('\n') ? text : `${text}\n`, {mode: 0o600})
    return file
  })()
  return cookiesPath
}

async function baseArgs(bin: Binary): Promise<string[]> {
  const args = [
    '--no-playlist',
    '--playlist-items',
    '1',
    '--no-warnings',
    '--no-progress',
    '--cache-dir',
    path.join(WORK_DIR, 'cache'),
    ...bin.extraArgs,
  ]
  // lets yt-dlp merge its default selection and remux hls on its own
  const ffmpeg = await getFfmpeg().catch(() => undefined)
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY)
  const cookies = await getCookiesFile()
  if (cookies) args.push('--cookies', cookies)
  return args
}

// ---------------------------------------------------------------- processes

type Proc = {child: ChildProcess; exited: Promise<void>}

function run(cmd: string, args: string[], stdio: StdioOptions, label: 'yt-dlp' | 'ffmpeg', cwd = WORK_DIR): Proc {
  const child = spawn(cmd, args, {stdio, cwd})
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192)
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // ffmpeg exits 0 even when the input broke off mid-way ("partial file")
      if (code === 0 && label === 'ffmpeg' && FFMPEG_INPUT_ERRORS.test(stderr)) reject(new Error(cleanFfmpegError(stderr)))
      else if (code === 0) resolve()
      else if (signal) reject(new Error(`${label} was stopped (${signal}).`))
      else reject(new Error((label === 'yt-dlp' ? cleanYtDlpError(stderr) : cleanFfmpegError(stderr)) || `${label} exited with code ${code}.`))
    })
  })
  exited.catch(() => {})
  return {child, exited}
}

async function runYtDlpJson(args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<VideoInfo> {
  const bin = await getYtDlp()
  const fullArgs = [...(await baseArgs(bin)), ...args]
  await fs.mkdir(WORK_DIR, {recursive: true})
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin.path, fullArgs, {stdio: ['ignore', 'pipe', 'pipe'], cwd: WORK_DIR, signal, timeout: timeoutMs})
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    child.on('error', error => reject(signal?.aborted ? new UserFacingError('Cancelled.', 499) : error))
    child.on('close', (code, killSignal) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else if (killSignal && !signal?.aborted) reject(new UserFacingError('That site took too long to answer. Try again in a bit.', 504))
      else reject(friendlyError(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}.`))
    })
  })

  let parsed: VideoInfo
  try {
    parsed = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new UserFacingError('Could not read the video info for that link.', 502)
  }
  // playlists, carousels and multi-video posts: yoink the first item
  if (parsed._type === 'playlist') {
    const first = parsed.entries?.find(Boolean)
    if (!first) throw new UserFacingError('That link has no videos in it.')
    return first
  }
  return parsed
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}

const FFMPEG_INPUT_ERRORS = /Error during demuxing|partial file|Invalid data found when processing input/i

function cleanFfmpegError(stderr: string): string {
  return stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
}

function friendlyError(message: string): UserFacingError {
  if (/not a bot|confirm you.re not|sign in to confirm/i.test(message)) {
    return new UserFacingError(
      'YouTube is asking this server to prove it’s not a bot. Try again later — or the site owner can set YTDLP_COOKIES / YTDLP_PROXY.',
      503,
    )
  }
  if (/unsupported url/i.test(message)) return new UserFacingError('That site isn’t supported (yet).')
  if (/HTTP Error 404|not found/i.test(message)) return new UserFacingError('Nothing found at that link — is it public?', 404)
  if (/login|log in|sign in|private|age/i.test(message)) {
    return new UserFacingError(`${message.replace(/\s*Use --cookies.*$/i, '').trim()} — only public videos can be yoinked.`, 403)
  }
  return new UserFacingError(message.replace(/\s*Use --cookies.*$/i, '').trim() || 'yt-dlp couldn’t read that link.', 502)
}

// ---------------------------------------------------------------- probing

export type VideoInfo = RawFormat & {
  _type?: string
  entries?: VideoInfo[]
  title?: string
  uploader?: string
  channel?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
  requested_formats?: ResolvedFormat[]
} & Partial<ResolvedFormat>

type ResolvedFormat = RawFormat & {
  url: string
  protocol?: string
  http_headers?: Record<string, string>
  cookies?: string
  downloader_options?: {http_chunk_size?: number}
}

const cacheKey = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 32)

async function cachedInfoPath(url: string): Promise<string | undefined> {
  const file = path.join(INFO_DIR, `${cacheKey(url)}.json`)
  try {
    const stat = await fs.stat(file)
    return Date.now() - stat.mtimeMs < INFO_TTL_MS ? file : undefined
  } catch {
    return undefined
  }
}

async function writeJson(dir: string, name: string, data: unknown): Promise<string> {
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, name)
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data))
  await fs.rename(tmp, file)
  return file
}

/** /tmp is small and shared by every request on a warm instance — keep it tidy. */
async function pruneOld(dir: string, maxAgeMs: number): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  await Promise.allSettled(
    names.map(async name => {
      const file = path.join(dir, name)
      const stat = await fs.stat(file)
      if (now - stat.mtimeMs > maxAgeMs) await fs.rm(file, {force: true})
    }),
  )
}

export async function probe(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  await guardUrl(url)
  const cached = await cachedInfoPath(url)
  if (cached) {
    try {
      // a runtime cache file in /tmp, not something to bundle
      return JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ cached, 'utf8')) as VideoInfo
    } catch {
      // fall through to a fresh probe
    }
  }
  const info = await runYtDlpJson(['-J', '--', url], signal, 55_000)
  void pruneOld(INFO_DIR, INFO_TTL_MS)
  await writeJson(INFO_DIR, `${cacheKey(url)}.json`, info)
  return info
}

async function guardUrl(url: string): Promise<void> {
  try {
    await assertPublicUrl(url)
  } catch (error) {
    if (error instanceof BlockedUrlError) throw new UserFacingError(error.message, 400)
    throw error
  }
}

// ---------------------------------------------------------------- downloading

export type Download = {
  stream: ReadableStream<Uint8Array>
  filename: string
  contentType: string
  contentLength?: number
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
}

/** Video codecs and audio codecs an mp4 can carry as-is. */
const MP4_AUDIO = /^(mp4a|aac|opus|mp3|ac-3|ec-3|flac|alac)/i

/** Resolve the chosen format and start streaming it. Resolves once the first bytes are ready. */
export async function startDownload(url: string, choiceId: string, signal: AbortSignal): Promise<Download> {
  const selector = selectorFor(choiceId)
  if (!selector) throw new UserFacingError('Unknown download option.', 400)
  await guardUrl(url)

  const cached = await cachedInfoPath(url)
  if (cached) {
    try {
      return await attempt(url, choiceId, selector, cached, signal)
    } catch (error) {
      if (signal.aborted) throw error
      // stale or ip-bound media urls from the cached probe — re-extract once
    }
  }
  return attempt(url, choiceId, selector, undefined, signal)
}

async function attempt(
  url: string,
  choiceId: string,
  selector: string,
  cachedInfo: string | undefined,
  signal: AbortSignal,
): Promise<Download> {
  const source = cachedInfo ? ['--load-info-json', cachedInfo] : ['--', url]
  const info = await runYtDlpJson(['-J', '-f', selector, ...source], signal, 60_000)
  const formats: ResolvedFormat[] = info.requested_formats?.length
    ? info.requested_formats
    : info.url
      ? [info as ResolvedFormat]
      : []
  if (formats.length === 0) throw new UserFacingError('No downloadable format found for that link.')

  // the resolved info drives the yt-dlp processes that fetch each format
  await fs.mkdir(JOB_DIR, {recursive: true})
  void pruneOld(JOB_DIR, 30 * 60 * 1000)
  const jobFile = await writeJson(JOB_DIR, `${randomUUID()}.json`, info)
  const job = new Job(signal, () => fs.rm(jobFile, {force: true}))
  const title = info.title || 'yoink'

  try {
    let output: {readable: Readable; ext: string; contentLength?: number}
    if (choiceId === 'mp3') {
      output = await transcodeMp3(job, jobFile, formats[0]!)
    } else if (formats.length > 1) {
      output = await mergeToMp4(job, jobFile, formats[0]!, formats[1]!)
    } else {
      output = await single(job, jobFile, formats[0]!)
    }
    const stream = await job.toWebStream(output.readable)
    return {
      stream,
      filename: safeFilename(title, output.ext),
      contentType: CONTENT_TYPES[output.ext] ?? 'application/octet-stream',
      contentLength: output.contentLength,
    }
  } catch (error) {
    job.kill()
    throw error
  }
}

/** A plain http(s) url we can fetch ourselves: same ip as the probe, no cookies or proxy to carry over. */
function isDirect(f: ResolvedFormat): boolean {
  return (f.protocol === 'https' || f.protocol === 'http') && !f.cookies && !process.env.YTDLP_PROXY
}

async function single(job: Job, jobFile: string, f: ResolvedFormat) {
  const ext = f.ext && f.ext !== 'unknown_video' ? f.ext : 'mp4'
  if (isDirect(f)) {
    const {readable, length} = await httpStream(f, job.signal)
    return {readable, ext, contentLength: length}
  }
  if (f.protocol === 'https' || f.protocol === 'http') {
    return {readable: await job.ytDlpStdout(jobFile, f.format_id), ext}
  }
  // hls / dash: yt-dlp hands over an mpeg-ts or fragment stream — remux it
  // into a real mp4 so the file matches its name
  const ffmpeg = await getFfmpeg()
  const proc = job.spawn(
    ffmpeg,
    [...FFMPEG_START, ...pipeInput(3), '-map', '0:v?', '-map', '0:a?', '-c', 'copy', ...adtsFix(f), ...FRAGMENTED_MP4],
    ['ignore', 'pipe', 'pipe', 'pipe'],
    'ffmpeg',
  )
  await job.feed(jobFile, f.format_id, proc.child.stdio[3] as NodeJS.WritableStream)
  return {readable: proc.child.stdout!, ext: 'mp4'}
}

async function mergeToMp4(job: Job, jobFile: string, video: ResolvedFormat, audio: ResolvedFormat) {
  const ffmpeg = await getFfmpeg()
  const inputs = [await inputFor(video, 3), await inputFor(audio, 4)]
  const audioCodec =
    audio.acodec && audio.acodec !== 'none' && !MP4_AUDIO.test(audio.acodec) ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy', ...adtsFix(audio)]
  const proc = job.spawn(
    ffmpeg,
    [
      ...FFMPEG_START,
      ...inputs.flatMap(i => i.args),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      ...audioCodec,
      ...FRAGMENTED_MP4,
    ],
    ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    'ffmpeg',
  )
  await Promise.all(
    inputs.map(i => (i.pipeFd ? job.feed(jobFile, i.format.format_id, proc.child.stdio[i.pipeFd] as NodeJS.WritableStream) : undefined)),
  )
  return {readable: proc.child.stdout!, ext: 'mp4'}
}

async function transcodeMp3(job: Job, jobFile: string, audio: ResolvedFormat) {
  const ffmpeg = await getFfmpeg()
  const input = await inputFor(audio, 3)
  const proc = job.spawn(
    ffmpeg,
    [...FFMPEG_START, ...input.args, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '0', '-f', 'mp3', 'pipe:1'],
    ['ignore', 'pipe', 'pipe', 'pipe'],
    'ffmpeg',
  )
  if (input.pipeFd) await job.feed(jobFile, audio.format_id, proc.child.stdio[input.pipeFd] as NodeJS.WritableStream)
  return {readable: proc.child.stdout!, ext: 'mp3'}
}

const FFMPEG_START = ['-hide_banner', '-loglevel', 'error', '-nostdin']
const PRIME_BYTES = 256 * 1024
// fragmented mp4 can be written front-to-back into a pipe — a regular mp4
// needs to seek back and patch its header once it knows the length
const FRAGMENTED_MP4 = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1']

/**
 * AAC out of an hls (mpeg-ts) stream carries ADTS headers that mp4 can't
 * hold. The filter rewrites those and passes already-clean AAC through
 * untouched, but it rejects other codecs — so only add it for AAC.
 */
function adtsFix(f: ResolvedFormat): string[] {
  const aac = !f.acodec ? f.protocol?.startsWith('m3u8') : /^(mp4a|aac)/i.test(f.acodec)
  return aac ? ['-bsf:a', 'aac_adtstoasc'] : []
}

function pipeInput(fd: number): string[] {
  return ['-protocol_whitelist', 'pipe', '-i', `pipe:${fd}`]
}

/**
 * ffmpeg reads plain http(s) urls itself (it can seek, so even mp4s with the
 * index at the end work). Everything else — chunked YouTube streams, hls,
 * cookies, a proxy — goes through yt-dlp into a pipe.
 */
async function inputFor(f: ResolvedFormat, fd: number): Promise<{args: string[]; pipeFd?: number; format: ResolvedFormat}> {
  if (isDirect(f) && !f.downloader_options?.http_chunk_size) {
    await assertPublicUrl(f.url)
    const headers = Object.entries(f.http_headers ?? {})
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('')
    return {
      format: f,
      args: [
        '-protocol_whitelist',
        'http,https,tcp,tls',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
        ...(headers ? ['-headers', headers] : []),
        '-i',
        f.url,
      ],
    }
  }
  return {format: f, args: pipeInput(fd), pipeFd: fd}
}

/** Stream an http(s) media url, following redirects only to public hosts. YouTube wants ranged chunks. */
async function httpStream(f: ResolvedFormat, signal: AbortSignal): Promise<{readable: Readable; length?: number}> {
  const headers = f.http_headers ?? {}
  const chunkSize = f.downloader_options?.http_chunk_size
  if (!chunkSize) {
    const response = await guardedFetch(f.url, headers, signal)
    const length = Number(response.headers.get('content-length')) || undefined
    return {readable: Readable.fromWeb(response.body as never), length}
  }

  const first = await guardedFetch(f.url, {...headers, Range: `bytes=0-${chunkSize - 1}`}, signal)
  const total = Number(/\/(\d+)$/.exec(first.headers.get('content-range') ?? '')?.[1]) || undefined
  if (first.status !== 206 || !total) {
    // server ignored the range: it is sending the whole file anyway
    const length = Number(first.headers.get('content-length')) || undefined
    return {readable: Readable.fromWeb(first.body as never), length}
  }

  async function* chunks() {
    yield* Readable.fromWeb(first.body as never)
    for (let start = chunkSize!; start < total!; start += chunkSize!) {
      const end = Math.min(start + chunkSize! - 1, total! - 1)
      const response = await guardedFetch(f.url, {...headers, Range: `bytes=${start}-${end}`}, signal)
      yield* Readable.fromWeb(response.body as never)
    }
  }
  return {readable: Readable.from(chunks(), {objectMode: false}), length: total}
}

async function guardedFetch(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = url
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current)
    const response = await fetch(current, {headers, signal, redirect: 'manual'})
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel()
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`The site refused the download (HTTP ${response.status}).`)
    }
    return response
  }
  throw new Error('Too many redirects.')
}

/**
 * Owns every process and request behind one download, so a cancelled or
 * failed download never leaves yt-dlp or ffmpeg running in the background.
 */
class Job {
  private readonly procs: Proc[] = []
  private readonly scratchDirs: string[] = []
  private readonly controller = new AbortController()
  private failure: Error | undefined
  private failed: Promise<never>
  private rejectFailed!: (error: Error) => void
  private cleaned = false

  constructor(
    outer: AbortSignal,
    private readonly cleanup: () => Promise<unknown>,
  ) {
    this.failed = new Promise<never>((_, reject) => (this.rejectFailed = reject))
    this.failed.catch(() => {})
    outer.addEventListener('abort', () => this.kill(), {once: true})
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  spawn(cmd: string, args: string[], stdio: StdioOptions, label: 'yt-dlp' | 'ffmpeg', cwd?: string): Proc {
    const proc = run(cmd, args, stdio, label, cwd)
    this.procs.push(proc)
    proc.exited.catch(error => this.fail(error))
    // a closed pipe on the consumer side is reported through exit codes instead
    for (const stream of proc.child.stdio) stream?.on('error', () => {})
    return proc
  }

  /** A yt-dlp process writing one format's bytes to stdout. */
  async ytDlpStdout(jobFile: string, formatId: string): Promise<Readable> {
    const bin = await getYtDlp()
    const args = [...(await baseArgs(bin)), '--load-info-json', jobFile, '-f', formatId, '--no-part', '-o', '-']
    // its own cwd, or the video and audio processes clobber each other's
    // fragment files (both would be named "-.part-Frag1")
    const scratch = path.join(FRAG_DIR, randomUUID())
    await fs.mkdir(scratch, {recursive: true})
    this.scratchDirs.push(scratch)
    return this.spawn(bin.path, args, ['ignore', 'pipe', 'pipe'], 'yt-dlp', scratch).child.stdout!
  }

  /** Pipe one format (via yt-dlp) into a writable — typically one of ffmpeg's extra input fds. */
  async feed(jobFile: string, formatId: string, target: NodeJS.WritableStream): Promise<void> {
    const stdout = await this.ytDlpStdout(jobFile, formatId)
    stdout.pipe(target as NodeJS.WritableStream & import('node:stream').Writable)
  }

  fail(error: Error) {
    if (this.failure) return
    this.failure = error
    this.rejectFailed(error)
    this.kill()
  }

  kill() {
    this.controller.abort()
    for (const {child} of this.procs) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    void this.finish()
  }

  private async finish() {
    if (this.cleaned) return
    this.cleaned = true
    await Promise.allSettled([this.cleanup(), ...this.scratchDirs.map(dir => fs.rm(dir, {recursive: true, force: true}))])
  }

  /**
   * Waits for the first bytes (so a failure can still become a proper error
   * response), then streams the rest with backpressure.
   */
  async toWebStream(readable: Readable): Promise<ReadableStream<Uint8Array>> {
    readable.on('error', error => this.fail(error))
    const iterator = readable[Symbol.asyncIterator]() as AsyncIterator<Buffer>

    // muxers write their header before reading any input, so the first chunk
    // proves nothing — hold back a few hundred KB (or the whole file, if it's
    // smaller) so most failures still turn into a proper error response
    const primed: Buffer[] = []
    let primedBytes = 0
    let ended = false
    while (primedBytes < PRIME_BYTES) {
      const next = await Promise.race([iterator.next(), this.failed])
      if (next.done) {
        ended = true
        break
      }
      primed.push(next.value)
      primedBytes += next.value.byteLength
    }
    if (ended) {
      await Promise.race([Promise.all(this.procs.map(p => p.exited)), this.failed])
      if (primedBytes === 0) throw new UserFacingError('The download came back empty.', 502)
    }

    let pending: Buffer | undefined = primed.length ? Buffer.concat(primed) : undefined
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          if (pending) {
            controller.enqueue(new Uint8Array(pending.buffer, pending.byteOffset, pending.byteLength))
            pending = undefined
            if (ended) {
              void this.finish()
              controller.close()
            }
            return
          }
          const next = await Promise.race([iterator.next(), this.failed])
          if (next.done) {
            await Promise.race([Promise.all(this.procs.map(p => p.exited)), this.failed])
            void this.finish()
            controller.close()
          } else {
            controller.enqueue(new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength))
          }
        } catch (error) {
          this.kill()
          controller.error(error)
        }
      },
      cancel: () => this.kill(),
    })
  }
}
