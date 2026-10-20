import assert from 'node:assert/strict'
import {test} from 'node:test'
import {safeFilename} from './format'
import {normalizeUrl} from './platforms'

test('safeFilename strips path and control characters but keeps unicode', () => {
  assert.equal(safeFilename('a/b\\c: "d"?', 'mp4'), 'a b c d.mp4')
  assert.equal(safeFilename('  ..hidden  ', 'mp3'), 'hidden.mp3')
  assert.equal(safeFilename('Café ☕ vlog', 'mp4'), 'Café ☕ vlog.mp4')
  assert.equal(safeFilename('', 'mp4'), 'video.mp4')
})

test('normalizeUrl adds a scheme and rejects junk', () => {
  assert.equal(normalizeUrl('youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ')
  assert.equal(normalizeUrl(' https://x.com/a/status/1 '), 'https://x.com/a/status/1')
  assert.equal(normalizeUrl('javascript:alert(1)'), undefined)
  assert.equal(normalizeUrl('hello'), undefined)
  assert.equal(normalizeUrl(''), undefined)
})
