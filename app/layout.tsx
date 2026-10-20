import type {Metadata, Viewport} from 'next'
import type {ReactNode} from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'yup — download any video',
  description:
    'Download videos from YouTube, X/Twitter, Instagram, Threads, TikTok and 1,800+ other sites. Paste a link, pick a resolution or mp3, done.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    {media: '(prefers-color-scheme: light)', color: '#ffffff'},
    {media: '(prefers-color-scheme: dark)', color: '#18181b'},
  ],
}

// apply the saved theme before first paint so there's no light/dark flash
const THEME_SCRIPT = `try{var t=localStorage.getItem('yup:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html: THEME_SCRIPT}} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app router: this layout is the whole site */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  )
}
