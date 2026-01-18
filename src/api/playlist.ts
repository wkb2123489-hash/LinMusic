import type { Song, Playlist } from './types'
import { getCoverUrl } from './music'
import { normalizeImageUrl } from '@/utils/format'

// 是否使用本地存储模式（无后端）
const LOCAL_MODE = import.meta.env.VITE_LOCAL_MODE === 'true'
const BASE_URL = import.meta.env.DEV ? 'http://localhost:8788/api' : '/api'

// 本地存储键名
const LS_PLAYLISTS = 'linmusic.playlists'
const LS_SONGS_PREFIX = (id: number) => `linmusic.playlistSongs.${id}`

// 简单的本地存储读写工具
function readLS<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return defaultValue
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}
function writeLS(key: string, value: any): void {
  localStorage.setItem(key, JSON.stringify(value))
}

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

const toPlaylist = (item: any): Playlist => {
  const rawCover = item.coverUrl || item.cover_url
  const fallbackCover = item.latest_song_id && item.latest_platform
    ? getCoverUrl(String(item.latest_song_id), item.latest_platform)
    : undefined
  return {
    id: item.id,
    name: item.name,
    description: item.description || undefined,
    coverUrl: normalizeImageUrl(rawCover) || normalizeImageUrl(fallbackCover),
    songCount: item.songCount ?? item.song_count ?? 0,
    createdAt: item.createdAt || item.created_at,
    updatedAt: item.updatedAt || item.updated_at
  }
}

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    })
  } catch {
    throw new Error('API unavailable. Run `npx wrangler pages dev --port 8788` for local API.')
  }
  const contentType = response.headers.get('content-type') || ''
  const bodyText = await response.text()
  if (!contentType.includes('application/json')) {
    throw new Error('API unavailable. Run `npx wrangler pages dev --port 8788` for local API.')
  }
  const payload = JSON.parse(bodyText) as ApiResponse<T>

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'Request failed')
  }

  return payload.data as T
}

export async function getPlaylists(): Promise<Playlist[]> {
  if (LOCAL_MODE) {
    const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
    return playlists
  }
  try {
    const data = await request<any[]>('/playlists')
    return data.map(toPlaylist)
  } catch (error) {
    console.error('Get playlists failed:', error)
    return []
  }
}

export async function getPlaylist(id: number): Promise<{ playlist: Playlist; songs: Song[] } | null> {
  if (LOCAL_MODE) {
    const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
    const playlist = playlists.find((p) => p.id === id)
    if (!playlist) return null
    const songs = readLS<Song[]>(LS_SONGS_PREFIX(id), [])
    return { playlist, songs }
  }
  try {
    const data = await request<{ playlist: any; songs: Song[] }>(`/playlists/${id}`)
    return {
      playlist: toPlaylist(data.playlist),
      songs: data.songs || []
    }
  } catch (error) {
    console.error('Get playlist failed:', error)
    return null
  }
}

export async function createPlaylist(name: string, description?: string): Promise<Playlist | null> {
  if (LOCAL_MODE) {
    const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
    const nextId = playlists.length ? Math.max(...playlists.map(p => p.id)) + 1 : 1
    const now = new Date().toISOString()
    const playlist: Playlist = {
      id: nextId,
      name,
      description,
      songCount: 0,
      createdAt: now,
      updatedAt: now
    }
    playlists.push(playlist)
    writeLS(LS_PLAYLISTS, playlists)
    return playlist
  }
  try {
    const data = await request<any>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description })
    })
    return toPlaylist({ ...data, song_count: 0 })
  } catch (error) {
    console.error('Create playlist failed:', error)
    return null
  }
}

export async function updatePlaylist(
  id: number,
  updates: { name?: string; description?: string; coverUrl?: string }
): Promise<boolean> {
  if (LOCAL_MODE) {
    const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
    const idx = playlists.findIndex((p) => p.id === id)
    if (idx < 0) return false
    const now = new Date().toISOString()
    const updated: Playlist = { ...playlists[idx], ...updates, updatedAt: now }
    playlists[idx] = updated
    writeLS(LS_PLAYLISTS, playlists)
    return true
  }
  try {
    await request(`/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
    return true
  } catch (error) {
    console.error('Update playlist failed:', error)
    return false
  }
}

export async function deletePlaylist(id: number): Promise<boolean> {
  if (LOCAL_MODE) {
    const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
    const next = playlists.filter((p) => p.id !== id)
    writeLS(LS_PLAYLISTS, next)
    try { localStorage.removeItem(LS_SONGS_PREFIX(id)) } catch {}
    return true
  }
  try {
    await request(`/playlists/${id}`, { method: 'DELETE' })
    return true
  } catch (error) {
    console.error('Delete playlist failed:', error)
    return false
  }
}

export async function addSongToPlaylist(
  playlistId: number,
  song: Song
): Promise<{ success: boolean; duplicated?: boolean; error?: string }> {
  if (LOCAL_MODE) {
    try {
      const coverUrl = normalizeImageUrl(song.coverUrl)
        || normalizeImageUrl(getCoverUrl(String(song.id), song.platform))
      const songs = readLS<Song[]>(LS_SONGS_PREFIX(playlistId), [])
      const duplicated = songs.some((s) => s.id === String(song.id) && s.platform === song.platform)
      if (duplicated) {
        return { success: true, duplicated: true }
      }
      const nextEntryId = songs.length ? Math.max(...songs.map(s => s.playlistSongId || 0)) + 1 : 1
      const songToAdd: Song = {
        id: String(song.id),
        platform: song.platform,
        name: song.name || '未知歌曲',
        artist: song.artist || '未知歌手',
        album: song.album,
        duration: song.duration,
        coverUrl,
        playlistSongId: nextEntryId
      }
      songs.push(songToAdd)
      writeLS(LS_SONGS_PREFIX(playlistId), songs)

      // 更新歌单的歌曲计数
      const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
      const idx = playlists.findIndex((p) => p.id === playlistId)
      if (idx >= 0) {
        const now = new Date().toISOString()
        playlists[idx] = { ...playlists[idx], songCount: songs.length, updatedAt: now }
        writeLS(LS_PLAYLISTS, playlists)
      }
      return { success: true, duplicated: false }
    } catch (error) {
      console.error('Add song to playlist failed (local):', error)
      const message = error instanceof Error ? error.message : '添加失败'
      return { success: false, error: message }
    }
  }
  try {
    const coverUrl = normalizeImageUrl(song.coverUrl)
      || normalizeImageUrl(getCoverUrl(String(song.id), song.platform))
    const songToAdd: Song = {
      id: String(song.id),
      platform: song.platform,
      name: song.name || '未知歌曲',
      artist: song.artist || '未知歌手',
      album: song.album,
      duration: song.duration,
      coverUrl
    }

    const data = await request<{ duplicated?: boolean }>('/playlist-songs', {
      method: 'POST',
      body: JSON.stringify({ playlistId, ...songToAdd })
    })
    return { success: true, duplicated: !!data?.duplicated }
  } catch (error) {
    console.error('Add song to playlist failed:', error)
    const message = error instanceof Error ? error.message : '添加失败'
    return { success: false, error: message }
  }
}

export async function removeSongFromPlaylist(
  playlistId: number,
  songId: string,
  platform: string,
  playlistSongId?: number
): Promise<boolean> {
  if (LOCAL_MODE) {
    try {
      let entryId = playlistSongId
      if (!entryId) {
        const songs = readLS<Song[]>(LS_SONGS_PREFIX(playlistId), [])
        const match = songs.find((item) => item.id === songId && item.platform === platform)
        if (match && typeof match.playlistSongId === 'number') {
          entryId = match.playlistSongId
        }
      }
      if (!entryId) return false
      const songs = readLS<Song[]>(LS_SONGS_PREFIX(playlistId), [])
      const nextSongs = songs.filter((s) => s.playlistSongId !== entryId)
      if (nextSongs.length === songs.length) return false
      writeLS(LS_SONGS_PREFIX(playlistId), nextSongs)

      // 更新歌单的歌曲计数
      const playlists = readLS<Playlist[]>(LS_PLAYLISTS, [])
      const idx = playlists.findIndex((p) => p.id === playlistId)
      if (idx >= 0) {
        const now = new Date().toISOString()
        playlists[idx] = { ...playlists[idx], songCount: nextSongs.length, updatedAt: now }
        writeLS(LS_PLAYLISTS, playlists)
      }
      return true
    } catch (error) {
      console.error('Remove song from playlist failed (local):', error)
      return false
    }
  }
  try {
    let entryId = playlistSongId

    if (!entryId) {
      const data = await getPlaylist(playlistId)
      const match = data?.songs.find(
        (item) => item.id === songId && item.platform === platform
      )
      if (match && typeof match.playlistSongId === 'number') {
        entryId = match.playlistSongId
      }
    }

    if (!entryId) return false

    await request(`/playlist-songs/${entryId}`, { method: 'DELETE' })
    return true
  } catch (error) {
    console.error('Remove song from playlist failed:', error)
    return false
  }
}
