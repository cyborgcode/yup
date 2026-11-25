import assert from 'node:assert/strict'
import {test} from 'node:test'
import {buildId3v2} from './id3'
import {audioBaseName, audioTags} from './tags'

test('YouTube Music tracks use the real track, artists and album', () => {
  const info = {
    title: 'Get Lucky',
    track: 'Get Lucky',
    artists: ['Daft Punk', 'Pharrell Williams'],
    album: 'Random Access Memories',
    release_year: 2013,
    uploader: 'Daft Punk - Topic',
    categories: ['Music'],
  }
  assert.deepEqual(audioTags(info), {
    title: 'Get Lucky',
    artist: 'Daft Punk, Pharrell Williams',
    album: 'Random Access Memories',
    album_artist: 'Daft Punk',
    year: '2013',
  })
  assert.equal(audioBaseName(info), 'Daft Punk, Pharrell Williams - Get Lucky')
})

test('music videos are split into artist and song, without the "(Official Video)"', () => {
  const info = {title: 'Adele - Hello (Official Music Video)', uploader: 'AdeleVEVO', categories: ['Music'], upload_date: '20151022'}
  assert.deepEqual(audioTags(info), {title: 'Hello', artist: 'Adele', year: '2015'})
  assert.equal(audioBaseName(info), 'Adele - Hello')
})

test('anything outside the Music category keeps its title; the channel is the artist', () => {
  const info = {title: 'How to cook pasta - the easy way', uploader: 'Gordon Ramsay', categories: ['Howto & Style']}
  assert.deepEqual(audioTags(info), {title: 'How to cook pasta - the easy way', artist: 'Gordon Ramsay'})
  assert.equal(audioBaseName(info), 'How to cook pasta - the easy way')
})

test('"Artist - Topic" channels name the artist', () => {
  assert.equal(audioTags({title: 'Song', uploader: 'Fairuz - Topic'}).artist, 'Fairuz')
  assert.equal(audioBaseName({title: 'Kifak Inta', track: 'Kifak Inta', uploader: 'Fairuz - Topic'}), 'Fairuz - Kifak Inta')
})

test('an uploader who is not credited as the artist stays out of the filename', () => {
  const info = {title: 'big buck bunny 720p surround', track: 'big buck bunny 720p surround', uploader: 'jake@archive.org'}
  assert.equal(audioBaseName(info), 'big buck bunny 720p surround')
  assert.equal(audioTags(info).artist, 'jake@archive.org')
})

test('empty and junk fields are dropped', () => {
  assert.deepEqual(audioTags({title: '  ', upload_date: 'NA'}), {})
})

/** Read the frames back out of a tag we built. */
function parseId3(tag: Buffer): Record<string, Buffer> {
  assert.equal(tag.subarray(0, 5).toString('latin1'), 'ID3\x03\x00')
  const size = (tag[6]! << 21) | (tag[7]! << 14) | (tag[8]! << 7) | tag[9]!
  assert.equal(size, tag.length - 10, 'syncsafe size covers every frame')
  const frames: Record<string, Buffer> = {}
  for (let at = 10; at < tag.length; ) {
    const id = tag.subarray(at, at + 4).toString('latin1')
    const length = tag.readUInt32BE(at + 4)
    frames[id] = tag.subarray(at + 10, at + 10 + length)
    at += 10 + length
  }
  return frames
}

test('the ID3 tag round-trips unicode text and the cover', () => {
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const frames = parseId3(buildId3v2({title: 'Café ☕ أغنية', artist: 'Fairuz', year: '1972'}, cover))
  assert.deepEqual(Object.keys(frames), ['TIT2', 'TPE1', 'TYER', 'APIC'])
  assert.equal(frames.TIT2!.subarray(3).toString('utf16le'), 'Café ☕ أغنية')
  assert.deepEqual(frames.APIC!.subarray(-cover.length), cover)
  assert.equal(frames.APIC!.subarray(1, 12).toString('latin1'), 'image/jpeg\0')
})
