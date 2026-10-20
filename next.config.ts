import type {NextConfig} from 'next'

// The api routes shell out to yt-dlp (downloaded into ./bin at build time)
// and ffmpeg (from ffmpeg-static). Neither is imported as code, so tell the
// file tracer to ship both binaries with those functions.
const BINARIES = ['./bin/yt-dlp', './node_modules/ffmpeg-static/ffmpeg']

const config: NextConfig = {
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/info': BINARIES,
    '/api/download': BINARIES,
  },
  poweredByHeader: false,
  // keep `next dev` from writing extra files into the repo
  agentRules: false,
}

export default config
