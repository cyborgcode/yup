import assert from 'node:assert/strict'
import {test} from 'node:test'
import {buildChoices, selectorFor, type RawFormat} from './choices'

const youtubeLike: RawFormat[] = [
  {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 3_000_000},
  {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 3_400_000},
  {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4000, filesize: 80_000_000},
  {format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, tbr: 2600, filesize: 60_000_000},
  {format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, tbr: 600, filesize: 11_000_000},
]

test('lists one choice per height, tallest first, then mp3', () => {
  const choices = buildChoices(youtubeLike)
  assert.deepEqual(
    choices.map(c => c.id),
    ['v1080', 'v360', 'mp3'],
  )
  assert.equal(choices.at(-1)?.kind, 'audio')
})

test('estimates merged size from the best video + best audio', () => {
  const [v1080] = buildChoices(youtubeLike)
  // 80 MB of h264 plus the 3.4 MB opus track (highest abr)
  assert.equal(v1080?.size, '80 MB')
})

test('offers "best" when no format reports a height', () => {
  const choices = buildChoices([{format_id: 'http-1', ext: 'mp4'}])
  assert.deepEqual(
    choices.map(c => c.id),
    ['best', 'mp3'],
  )
})

test('audio-only sources get just the mp3 option', () => {
  const choices = buildChoices([{format_id: 'a', ext: 'mp3', vcodec: 'none', acodec: 'mp3'}])
  assert.deepEqual(
    choices.map(c => c.id),
    ['mp3'],
  )
})

test('selectors only come from known ids', () => {
  assert.match(selectorFor('v720') ?? '', /^bv\*\[height=720\]\[vcodec\^=avc\]\+ba\[acodec\^=mp4a\]\//)
  assert.equal(selectorFor('mp3'), 'ba/b')
  assert.equal(selectorFor('v720; rm -rf /'), undefined)
  assert.equal(selectorFor('bestvideo'), undefined)
})
