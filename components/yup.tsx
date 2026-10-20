'use client'

import {useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent} from 'react'
import {useSearchParams} from 'next/navigation'
import type {Choice} from '@/lib/choices'
import {formatDuration} from '@/lib/format'
import {normalizeUrl, type Platform} from '@/lib/platforms'
import {Logo} from './logo'

type Info = {
  url: string
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  platform: Platform
  choices: Choice[]
}

type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'}
  | {name: 'picking'; info: Info}
  | {name: 'downloading'; info: Info; choice: Choice; token: string; started: boolean}
  | {name: 'error'; message: string; info?: Info}

const TAGLINE = 'any video. paste. yup. done.'
const PLATFORMS = 'youtube · x · instagram · threads · tiktok · +1800 more'
const HISTORY_KEY = 'yup:history'
const THEME_KEY = 'yup:theme'
const THEMES = ['auto', 'light', 'dark'] as const
type ThemeMode = (typeof THEMES)[number]
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** The server streams for at most 300s; if nothing came back by then, it never will. */
const DOWNLOAD_SIGNAL_TIMEOUT_MS = 5 * 60 * 1000

const choiceLabel = (c: Choice) => [c.label, c.ext, c.size && `~${c.size}`].filter(Boolean).join(' · ')

function storage<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function loadHistory(): string[] {
  return storage(() => {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  }, [])
}

function saveHistory(url: string) {
  storage(() => localStorage.setItem(HISTORY_KEY, JSON.stringify([url, ...loadHistory().filter(u => u !== url)].slice(0, 20))), undefined)
}

function readSignal(token: string): string | undefined {
  const name = `yup_dl_${token}=`
  const raw = document.cookie.split('; ').find(c => c.startsWith(name))
  if (!raw) return undefined
  document.cookie = `yup_dl_${token}=; Path=/; Max-Age=0; SameSite=Lax`
  return decodeURIComponent(raw.slice(name.length))
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20)
}

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER.length), 80)
    return () => clearInterval(id)
  }, [active])
  return SPINNER[frame]!
}

export function Yup() {
  const params = useSearchParams()
  const [phase, setPhase] = useState<Phase>({name: 'input'})
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const [theme, setTheme] = useState<ThemeMode>('auto')
  const inputRef = useRef<HTMLInputElement>(null)
  const probeAbort = useRef<AbortController | null>(null)
  const historyIndex = useRef(-1)
  const spinner = useSpinner(phase.name === 'probing' || (phase.name === 'downloading' && !phase.started))

  useEffect(() => {
    const saved = storage(() => localStorage.getItem(THEME_KEY), null)
    if (saved === 'light' || saved === 'dark') setTheme(saved)
  }, [])

  const cycleTheme = useCallback(() => {
    setTheme(current => {
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!
      if (next === 'auto') delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = next
      storage(() => localStorage.setItem(THEME_KEY, next), undefined)
      return next
    })
  }, [])

  const goHome = useCallback((warning?: string) => {
    probeAbort.current?.abort()
    setPhase({name: 'input', warning})
    historyIndex.current = -1
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const runProbe = useCallback(async (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }
    setValue(url)
    saveHistory(url)
    probeAbort.current?.abort()
    const controller = new AbortController()
    probeAbort.current = controller
    setPhase({name: 'probing'})
    try {
      const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`, {signal: controller.signal})
      const body = (await response.json().catch(() => ({error: `the server answered ${response.status}`}))) as Info & {error?: string}
      if (!response.ok || body.error) throw new Error(body.error ?? `the server answered ${response.status}`)
      setSelected(0)
      setPhase({name: 'picking', info: body})
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
    }
  }, [])

  const startDownload = useCallback((info: Info, choice: Choice) => {
    const token = randomToken()
    const query = new URLSearchParams({url: info.url, choice: choice.id, token})
    const link = document.createElement('a')
    link.href = `/api/download?${query}`
    link.download = ''
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setPhase({name: 'downloading', info, choice, token, started: false})
  }, [])

  // the download response is invisible to the page — the server reports back
  // through a cookie named after this download's token
  useEffect(() => {
    if (phase.name !== 'downloading' || phase.started) return
    const startedAt = Date.now()
    const id = setInterval(() => {
      const signal = readSignal(phase.token)
      if (signal === 'ok') {
        setPhase({...phase, started: true})
      } else if (signal?.startsWith('error:')) {
        setPhase({name: 'error', message: signal.slice('error:'.length), info: phase.info})
      } else if (Date.now() - startedAt > DOWNLOAD_SIGNAL_TIMEOUT_MS) {
        setPhase({name: 'error', message: 'that took too long — try a smaller resolution', info: phase.info})
      }
    }, 400)
    return () => clearInterval(id)
  }, [phase])

  // ?url=… deep links (and bookmarklets) go straight to the format picker
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current) return
    deepLinked.current = true
    const fromQuery = params.get('url')
    if (fromQuery) {
      setValue(fromQuery)
      void runProbe(fromQuery)
    } else {
      inputRef.current?.focus()
    }
  }, [params, runProbe])

  // terminal-style keys for everything past the input box
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (phase.name === 'probing' && event.key === 'Escape') {
        goHome()
      } else if (phase.name === 'picking') {
        const count = phase.info.choices.length
        if (event.key === 'ArrowDown' || event.key === 'j') {
          event.preventDefault()
          setSelected(s => (s + 1) % count)
        } else if (event.key === 'ArrowUp' || event.key === 'k') {
          event.preventDefault()
          setSelected(s => (s - 1 + count) % count)
        } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count) {
          startDownload(phase.info, phase.info.choices[Number(event.key) - 1]!)
        } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault()
          startDownload(phase.info, phase.info.choices[selected]!)
        } else if (event.key === 'Escape') {
          goHome()
        }
      } else if (phase.name === 'downloading') {
        if (event.key === 'Escape') setPhase({name: 'picking', info: phase.info})
        else if (event.key === 'Enter' && phase.started && !(event.target instanceof HTMLButtonElement)) goHome()
      } else if (phase.name === 'error') {
        if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
          if (phase.info) setPhase({name: 'picking', info: phase.info})
          else void runProbe(value)
        } else if (event.key === 'Escape') {
          goHome()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, selected, value, goHome, runProbe, startDownload])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void runProbe(value)
  }

  function onInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const history = loadHistory()
    if (history.length === 0) return
    event.preventDefault()
    const next =
      event.key === 'ArrowUp' ? Math.min(historyIndex.current + 1, history.length - 1) : Math.max(historyIndex.current - 1, -1)
    historyIndex.current = next
    setValue(next === -1 ? '' : history[next]!)
  }

  const hints: Array<[string, string, (() => void)?]> =
    phase.name === 'input'
      ? [
          ['↵', 'yup', () => void runProbe(value)],
          ['↑', 'history'],
        ]
      : phase.name === 'probing'
        ? [['esc', 'cancel', () => goHome()]]
        : phase.name === 'picking'
          ? [
              ['↑↓', 'choose'],
              ['↵', 'grab', () => startDownload(phase.info, phase.info.choices[selected]!)],
              ['esc', 'back', () => goHome()],
            ]
          : phase.name === 'downloading'
            ? [['esc', 'formats', () => setPhase({name: 'picking', info: phase.info})], ...(phase.started ? [['↵', 'grab another', () => goHome()] as [string, string, () => void]] : [])]
            : [
                ['↵', 'try again', () => (phase.info ? setPhase({name: 'picking', info: phase.info}) : void runProbe(value))],
                ['esc', 'home', () => goHome()],
              ]

  return (
    <main className="screen">
      <header className="masthead">
        <Logo onClick={() => goHome()} />
        <p className="tagline">{TAGLINE}</p>
        <p className="platforms">{PLATFORMS}</p>
      </header>

      <section className="stage" aria-live="polite">
        {(phase.name === 'input' || phase.name === 'probing' || (phase.name === 'error' && !phase.info)) && (
          <form className="paste" onSubmit={onSubmit}>
            <fieldset className="frame" disabled={phase.name === 'probing'}>
              <legend>Paste a link</legend>
              <span className="prompt" aria-hidden="true">
                ❯
              </span>
              <input
                ref={inputRef}
                type="url"
                inputMode="url"
                name="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="https://youtube.com/watch?v=…"
                aria-label="Video link"
                value={value}
                onChange={e => {
                  setValue(e.target.value)
                  historyIndex.current = -1
                }}
                onKeyDown={onInputKey}
              />
            </fieldset>
            <button type="submit" className="go-button" disabled={phase.name === 'probing'}>
              yup
            </button>
          </form>
        )}

        {phase.name === 'input' && phase.warning && <p className="note warn">{phase.warning}</p>}
        {phase.name === 'probing' && (
          <p className="note">
            <span className="spin">{spinner}</span> sniffing out formats…
          </p>
        )}

        {(phase.name === 'picking' || phase.name === 'downloading' || (phase.name === 'error' && phase.info)) && (
          <div className="picker">
            <VideoCard info={(phase as {info: Info}).info} />
            {phase.name === 'picking' && (
              <fieldset className="frame list">
                <legend>Download</legend>
                <ul role="listbox" aria-label="Formats">
                  {phase.info.choices.map((choice, i) => (
                    <li key={choice.id} role="option" aria-selected={i === selected}>
                      <button
                        type="button"
                        className={i === selected ? 'choice selected' : 'choice'}
                        onMouseEnter={() => setSelected(i)}
                        onFocus={() => setSelected(i)}
                        onClick={() => startDownload(phase.info, choice)}
                      >
                        <span className="caret" aria-hidden="true">
                          {i === selected ? '❯' : ' '}
                        </span>
                        <span className="glyph" aria-hidden="true">
                          {choice.kind === 'audio' ? '♪' : '▶'}
                        </span>
                        {choiceLabel(choice)}
                      </button>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            {phase.name === 'downloading' && (
              <fieldset className="frame status">
                <legend>{phase.started ? 'Got it' : 'Grabbing'}</legend>
                {phase.started ? (
                  <>
                    <p>
                      <span className="ok">✓</span> on its way — your browser is saving{' '}
                      <strong>{choiceLabel(phase.choice)}</strong>.
                    </p>
                    <p className="dim">check your downloads. big files keep streaming in the background.</p>
                    <button type="button" className="again" onClick={() => goHome()}>
                      ↵ grab another
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      <span className="spin">{spinner}</span> fetching <strong>{choiceLabel(phase.choice)}</strong>…
                    </p>
                    <p className="dim">the download starts as soon as the first bytes arrive.</p>
                  </>
                )}
              </fieldset>
            )}
            {phase.name === 'error' && <ErrorBox message={phase.message} />}
          </div>
        )}

        {phase.name === 'error' && !phase.info && <ErrorBox message={phase.message} />}
      </section>

      <footer className="hints">
        <nav aria-label="Shortcuts">
          {hints.map(([key, label, action]) =>
            action ? (
              <button key={label} type="button" className="hint" onClick={action}>
                <kbd>{key}</kbd> {label}
              </button>
            ) : (
              <span key={label} className="hint">
                <kbd>{key}</kbd> {label}
              </span>
            ),
          )}
          <button type="button" className="hint" onClick={cycleTheme} title="cycle theme: auto → light → dark">
            <kbd>◐</kbd> {theme}
          </button>
        </nav>
        <p className="fine-print">
          personal archiving only — download what you have the right to keep, and be excellent to creators. based on{' '}
          <a href="https://github.com/pablostanley/yoinks">yoinks</a> by Pablo Stanley, powered by{' '}
          <a href="https://github.com/yt-dlp/yt-dlp">yt-dlp</a>.
        </p>
      </footer>
    </main>
  )
}

function VideoCard({info}: {info: Info}) {
  const [thumbOk, setThumbOk] = useState(true)
  const meta = [info.platform.label, info.duration ? formatDuration(info.duration) : '', info.uploader].filter(Boolean)
  return (
    <article className="video">
      {info.thumbnail && thumbOk && (
        // eslint-disable-next-line @next/next/no-img-element -- remote thumbnails from any of 1800 hosts
        <img src={info.thumbnail} alt="" referrerPolicy="no-referrer" onError={() => setThumbOk(false)} />
      )}
      <h1>{info.title}</h1>
      <p className="meta">▸ {meta.join(' · ')}</p>
    </article>
  )
}

function ErrorBox({message}: {message: string}) {
  return (
    <fieldset className="frame error">
      <legend>Couldn’t grab that</legend>
      <p>{message}</p>
    </fieldset>
  )
}
