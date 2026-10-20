// Runs before `next build` (npm's prebuild hook). Downloads the standalone
// yt-dlp binary into ./bin so it ships inside the Vercel function bundle —
// no Python needed at runtime. Every deploy picks up the latest release,
// which matters: sites change and yt-dlp ships fixes constantly.
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN_DIR = path.join(ROOT, 'bin')
const TARGET = path.join(BIN_DIR, 'yt-dlp')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

// Vercel builds and runs functions on linux x64. Locally (e.g. on a Mac) the
// bundled binary is never used — lib/ytdlp.ts prefers a system yt-dlp.
if (process.platform !== 'linux') {
  console.log(`[fetch-yt-dlp] skipping on ${process.platform}; the server will use a system yt-dlp or fetch one at runtime`)
  process.exit(0)
}

const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'

const fresh = await fs
  .stat(TARGET)
  .then(stat => Date.now() - stat.mtimeMs < 6 * 60 * 60 * 1000)
  .catch(() => false)
if (fresh && !process.env.VERCEL) {
  console.log('[fetch-yt-dlp] bin/yt-dlp is recent, keeping it')
  process.exit(0)
}

console.log(`[fetch-yt-dlp] downloading ${asset}…`)
const response = await fetch(`${RELEASE_BASE}/${asset}`)
if (!response.ok || !response.body) {
  console.error(`[fetch-yt-dlp] download failed: HTTP ${response.status}`)
  process.exit(1)
}

await fs.mkdir(BIN_DIR, {recursive: true})
const tmp = `${TARGET}.download`
await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp))
await fs.chmod(tmp, 0o755)
await fs.rename(tmp, TARGET)
const {size} = await fs.stat(TARGET)
console.log(`[fetch-yt-dlp] saved bin/yt-dlp (${(size / 1024 / 1024).toFixed(1)} MB)`)
