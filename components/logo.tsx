import type {CSSProperties} from 'react'

// same block art as the terminal app — each character is a 1×2 grid of
// half-cells: █ fills both, ▀ the top, ▄ the bottom, ▓ is a lighter shade
const ART = [
  '▓ ▓ █▀█ ▀█▀ █▀▄█ █ █ █▀▀',
  '▀█▀ █ ▓  ▓  █  ▓ ▓▀▄ ▀▀▓',
  ' ▀  ▀▀▀ ▀▀▀ ▀  ▀ ▀ ▀ ▀▀▀',
]
const COLS = [...ART[0]!].length
const CELL = 10
const INTRO_SPREAD_MS = 550
const TILT = 2 // columns of lean per row — the shimmer slants like /

type Cell = {x: number; y: number; h: number; shade: boolean; delay: number; sweep: number}

// deterministic "random" so server and client render the same delays
function jitter(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

const CELLS: Cell[] = ART.flatMap((line, row) =>
  [...line].flatMap((ch, col): Cell[] => {
    const i = row * COLS + col
    const base = {x: col * CELL, shade: ch === '▓', delay: Math.round(jitter(i) * INTRO_SPREAD_MS), sweep: (col + (ART.length - 1 - row) * TILT) * 28}
    if (ch === '█' || ch === '▓') return [{...base, y: row * CELL * 2, h: CELL * 2}]
    if (ch === '▀') return [{...base, y: row * CELL * 2, h: CELL}]
    if (ch === '▄') return [{...base, y: row * CELL * 2 + CELL, h: CELL}]
    return []
  }),
)

export function Logo({onClick}: {onClick?: () => void}) {
  return (
    <button type="button" className="logo" onClick={onClick} aria-label="yoinks — home" title="home">
      <svg viewBox={`0 0 ${COLS * CELL} ${ART.length * CELL * 2}`} role="img" aria-hidden="true">
        {CELLS.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={CELL}
            height={cell.h}
            className={cell.shade ? 'cell shade' : 'cell'}
            style={{'--d': `${cell.delay}ms`, '--s': `${cell.sweep}ms`} as CSSProperties}
          />
        ))}
      </svg>
    </button>
  )
}
