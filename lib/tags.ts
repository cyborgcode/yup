/** What yt-dlp knows about a track: the fields that end up in an mp3's tags. */
export type TrackInfo = {
  title?: string
  track?: string
  artist?: string
  artists?: string[]
  creator?: string
  uploader?: string
  channel?: string
  album?: string
  album_artist?: string
  release_year?: number
  release_date?: string
  upload_date?: string
  track_number?: number
  genre?: string
  categories?: string[]
}

export type AudioTags = Partial<Record<'title' | 'artist' | 'album' | 'album_artist' | 'year' | 'track' | 'genre', string>>

// "(Official Music Video)", "[Lyrics]", "(Audio)", "(HD)"… — noise in a song title
const TITLE_JUNK =
  /\s*[([]\s*(?:official\s+)?(?:(?:music|lyric|lyrics)\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|hq|4k)(?:\s+video)?\s*[)\]]/gi
const ARTIST_SONG = /^(.+?)\s+[-–—]\s+(.+)$/

/** YouTube's auto-generated "Artist - Topic" and "ArtistVEVO" channels name the artist. */
function cleanChannel(name: string | undefined): string | undefined {
  return name?.replace(/\s*-\s*Topic$/i, '').replace(/(?<=\S)VEVO$/, '').trim() || undefined
}

function describe(info: TrackInfo): {title?: string; artist?: string; music: boolean} {
  const credited = info.artists?.filter(Boolean).join(', ') || info.artist || info.creator
  if (info.track) return {title: info.track, artist: credited || cleanChannel(info.uploader ?? info.channel), music: true}

  // a music video titled "Artist - Song (Official Video)": split it, but only
  // in the Music category, where that dash really separates artist and song
  if (info.categories?.includes('Music') && info.title) {
    const match = ARTIST_SONG.exec(info.title.replace(TITLE_JUNK, '').trim())
    if (match) return {title: match[2]!.trim(), artist: credited || match[1]!.trim(), music: true}
  }
  return {title: info.title, artist: credited || cleanChannel(info.uploader ?? info.channel), music: false}
}

export function audioTags(info: TrackInfo): AudioTags {
  const {title, artist} = describe(info)
  const year = info.release_year ? String(info.release_year) : (info.release_date ?? info.upload_date)?.slice(0, 4)
  const tags: AudioTags = {
    title,
    artist,
    album: info.album,
    album_artist: info.album_artist ?? (info.album ? info.artists?.[0] : undefined),
    year: year && /^\d{4}$/.test(year) ? year : undefined,
    track: info.track_number ? String(info.track_number) : undefined,
    genre: info.genre,
  }
  for (const key of Object.keys(tags) as Array<keyof AudioTags>) {
    const value = tags[key]?.replace(/\0/g, '').trim().slice(0, 500)
    if (value) tags[key] = value
    else delete tags[key]
  }
  return tags
}

/** "Artist - Song" for music, the plain title for anything else. */
export function audioBaseName(info: TrackInfo): string {
  const {title, artist, music} = describe(info)
  return music && artist && title ? `${artist} - ${title}` : (info.title ?? title ?? 'audio')
}
