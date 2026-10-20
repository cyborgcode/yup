# yup

Paste a link, pick a resolution (or audio-only mp3), and the file downloads
straight to your device. Works with YouTube, X/Twitter, Instagram, Threads,
TikTok and the 1,800+ other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp)
supports — no popups, no fake download buttons, no sketchy redirects.

Based on [yoinks](https://github.com/pablostanley/yoinks), the terminal app,
rebuilt for the browser and Vercel.

## How it works

- `GET /api/info?url=…` runs `yt-dlp -J` and returns the title, thumbnail and
  the list of resolutions.
- `GET /api/download?url=…&choice=…` resolves the chosen format and **streams**
  the file back as an attachment, so the browser's own download manager shows
  progress. Nothing is stored on the server.
  - single files are proxied as-is (with `Content-Length`, so you get a real
    progress bar)
  - separate video + audio streams (YouTube, Vimeo, Reddit, …) are merged on
    the fly by ffmpeg into a fragmented mp4
  - hls/dash streams are remuxed into mp4; "audio only" is transcoded to mp3
- yt-dlp's standalone binary is downloaded at build time
  (`scripts/fetch-yt-dlp.mjs`, run as `prebuild`) and bundled into the
  functions together with ffmpeg from `ffmpeg-static`, so every deploy ships
  the latest yt-dlp.
- Links that resolve to private, loopback or link-local addresses are refused,
  and ffmpeg is only allowed to read http(s) and pipes.

## Deploy on Vercel

1. Import this repository in Vercel (framework preset: Next.js — no settings
   to change).
2. Deploy. That's it.

Downloads stream through the function, so a download can last at most as long
as the function's max duration: 300 s, set in
`app/api/download/route.ts`. On the Pro plan you can raise `maxDuration` to
800 for very long videos.

### Optional environment variables

| Variable        | What it does                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `YTDLP_PROXY`   | Proxy for all yt-dlp traffic, e.g. `http://user:pass@host:port`. Useful when a site blocks datacenter IPs.     |
| `YTDLP_COOKIES` | A Netscape `cookies.txt` (raw or base64) for sites that want a logged-in session. Use a throwaway account.    |
| `YTDLP_PATH`    | Use a specific yt-dlp binary instead of the bundled one.                                                      |
| `FFMPEG_PATH`   | Use a specific ffmpeg binary instead of `ffmpeg-static`.                                                       |

### YouTube: give the server a throwaway login

YouTube answers every cloud server (Vercel included) with "Sign in to confirm
you're not a bot", whatever client yt-dlp pretends to be. A logged-in
session gets past it:

1. Create a **new Google account just for this** — never your main one;
   YouTube may eventually flag it.
2. On a computer, open a private/incognito window and sign in to YouTube with
   that account.
3. In the same tab, go to <https://www.youtube.com/robots.txt> — with only that
   page open, YouTube won't rotate the cookies you're about to export.
4. Export the youtube.com cookies as `cookies.txt` with an extension that saves
   locally (e.g. "Get cookies.txt LOCALLY"; allow it in private windows).
   See yt-dlp's [guide](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).
5. Close the private window without signing out (signing out kills the
   cookies).
6. In Vercel: project → Settings → Environment Variables → add
   `YTDLP_COOKIES`, paste the whole file (raw or base64 both work), select
   **Production**, and mark it **Sensitive**.
7. Redeploy.

When YouTube links start failing with "the site owner needs to refresh its
cookies", repeat steps 2–7.

### Good to know

- **YouTube vs. cloud IPs.** YouTube often answers requests from datacenter
  IPs (Vercel included) with "Sign in to confirm you're not a bot". The site
  shows a clear message when that happens; setting `YTDLP_PROXY` (a
  residential proxy) or `YTDLP_COOKIES` usually fixes it.
- **Bandwidth.** Every byte of every download passes through your functions,
  which counts against your Vercel usage. Keep an eye on it if the site gets
  popular, and consider [Vercel's rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).

## Development

```sh
npm install
npm run dev          # http://localhost:3000 (uses yt-dlp from ./bin, your PATH, or downloads one)
npm test
npm run typecheck
npm run build
```

To test against media served from your own machine, start the dev server with
`YUP_ALLOW_PRIVATE_URLS=1` — it lifts the private-address block in
development only and is ignored by production builds.

## A note on fair use

This is a personal-archiving tool. Downloading content may violate a
platform's terms of service — only download what you have the right to keep,
and be excellent to creators.

## License

[MIT](LICENSE) — based on [yoinks](https://github.com/pablostanley/yoinks) by
Pablo Stanley.
