import type {AudioTags} from './tags'

// ID3v2.3: the version every player reads, iPhones and Windows included. Text
// is UTF-16 so titles in any script survive (v2.3 predates UTF-8 frames).
const TEXT_FRAMES: Record<keyof AudioTags, string> = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  album_artist: 'TPE2',
  year: 'TYER',
  track: 'TRCK',
  genre: 'TCON',
}

function frame(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(body.length, 4) // v2.3 frame sizes are plain big-endian, not syncsafe
  return Buffer.concat([header, body])
}

function textFrame(id: string, text: string): Buffer {
  return frame(id, Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
}

/** Front cover, JPEG, no description. */
function pictureFrame(jpeg: Buffer): Buffer {
  return frame('APIC', Buffer.concat([Buffer.from([0x00]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([0x03, 0x00]), jpeg]))
}

/**
 * A complete ID3v2.3 tag to put in front of an mp3 stream. ffmpeg can only
 * write one by seeking back to fill in its size afterwards, which a stream
 * sent straight to the browser can't do — so it's built up front here.
 */
export function buildId3v2(tags: AudioTags, cover?: Buffer): Buffer {
  const frames = (Object.keys(TEXT_FRAMES) as Array<keyof AudioTags>)
    .filter(key => tags[key])
    .map(key => textFrame(TEXT_FRAMES[key], tags[key]!))
  if (cover) frames.push(pictureFrame(cover))
  const body = Buffer.concat(frames)

  const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 0, 0]) // "ID3", v2.3.0, no flags
  // the tag size is "syncsafe": 7 bits per byte
  header[6] = (body.length >> 21) & 0x7f
  header[7] = (body.length >> 14) & 0x7f
  header[8] = (body.length >> 7) & 0x7f
  header[9] = body.length & 0x7f
  return Buffer.concat([header, body])
}
