import { parseRelease } from '../../lib/parse'
import { extractQuality, extractQualityLabel } from './quality'

// ─── Types ────────────────────────────────────────────────────────────────

export interface TorrentFile {
  index: number         // file index within torrent (0-based)
  name: string          // full filename (e.g., "The.Vampire.Diaries.S01E05.1080p.mkv")
  size: number          // file size in bytes
}

export interface ResolvedMetadata {
  files: TorrentFile[]
  totalSize: number
  name: string          // torrent name from metadata
}

// ─── Parse magnet link ──────────────────────────────────────────────────

/**
 * Extract the info hash from a magnet link.
 */
export function extractInfoHash(magnetLink: string): string | null {
  // magnet:?xt=urn:btih:<hash> (40 hex chars)
  const m = magnetLink.match(/btih:([a-fA-F0-9]{40})/i)
  if (m) return m[1]!.toLowerCase()

  // Some magnets use base32 encoding (32 chars)
  const m32 = magnetLink.match(/btih:([A-Z2-7]{32})/i)
  if (m32) return m32[1]!.toLowerCase()

  return null
}

/**
 * Extract the display name (dn) from a magnet link.
 */
export function extractMagnetName(magnetLink: string): string | null {
  const m = magnetLink.match(/[?&]dn=([^&]+)/i)
  if (m) {
    try {
      return decodeURIComponent(m[1]!)
    } catch {
      return m[1]!
    }
  }
  return null
}

// ─── HTTP torrent cache services ────────────────────────────────────────

/** HTTP endpoints that serve .torrent files by info hash */
const TORRENT_CACHES = [
  // torrage.info — historically reliable
  {
    name: 'torrage',
    url: (hash: string) => `https://torrage.info/torrent.php?h=${hash}`,
    binary: false, // returns text/html with the torrent embedded
  },
  // btcache.me
  {
    name: 'btcache',
    url: (hash: string) => `https://btcache.me/torrent/${hash}`,
    binary: false,
  },
]

// ─── Main export ────────────────────────────────────────────────────────

/**
 * Resolve torrent metadata (file list, sizes, name) from a magnet link.
 *
 * Strategy:
 * 1. Parse info hash and name from magnet URI
 * 2. Try HTTP torrent caches to get the .torrent file
 * 3. Parse bencoded data to extract file info
 * 4. If all HTTP methods fail, return null (caller should fall back)
 *
 * IMPORTANT: Only fetches the .torrent file (info dict, ~few KB).
 * NEVER downloads actual content chunks.
 *
 * Caching note: Callers should cache results in torrent_metadata table.
 */
export async function resolveTorrentMetadata(
  magnetLink: string,
): Promise<ResolvedMetadata | null> {
  const infoHash = extractInfoHash(magnetLink)
  if (!infoHash) {
    console.warn('[resolve-metadata] Could not extract info hash from magnet')
    return null
  }

  // Try HTTP caches
  const torrentData = await fetchTorrentFile(infoHash)
  if (torrentData) {
    try {
      const meta = parseTorrentData(torrentData, infoHash)
      return meta
    } catch (err) {
      console.warn(
        `[resolve-metadata] Failed to parse torrent data for ${infoHash}:`,
        (err as Error).message,
      )
    }
  }

  return null
}

// ─── HTTP-based metadata fetching ───────────────────────────────────────

/**
 * Fetch a .torrent file from HTTP torrent caches.
 * Returns the raw bencoded buffer, or null if all caches fail.
 */
async function fetchTorrentFile(infoHash: string): Promise<Buffer | null> {
  for (const cache of TORRENT_CACHES) {
    const url = cache.url(infoHash)
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const resp = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PopcornTime/1.0)',
        },
      })
      clearTimeout(timeout)

      if (!resp.ok) {
        console.warn(`[resolve-metadata] ${cache.name}: HTTP ${resp.status}`)
        continue
      }

      const contentType = resp.headers.get('content-type') ?? ''

      if (contentType.includes('application/x-bittorrent') || contentType.includes('application/octet-stream')) {
        // Binary torrent file
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length < 50) continue // too small
        return buf
      }

      // Some caches embed the torrent in HTML. Try to extract it.
      if (contentType.includes('text/html')) {
        const text = await resp.text()
        // Try to find a magnet link that we can re-fetch
        const magnetMatch = text.match(/magnet:\?xt=urn:btih:[^"'\s]+/i)
        if (magnetMatch) {
          // Found a magnet - but we already have it. Try extracting binary.
        }
        // Some pages have the torrent base64-encoded
        const b64Match = text.match(/href="data:application\/x-bittorrent;base64,([^"]+)"/)
        if (b64Match) {
          try {
            return Buffer.from(b64Match[1]!, 'base64')
          } catch { /* fall through */ }
        }
      }
    } catch (err) {
      console.warn(`[resolve-metadata] ${cache.name} error:`, (err as Error).message)
      continue
    }
  }
  return null
}

// ─── Parse bencoded torrent data ────────────────────────────────────────

function parseTorrentData(buf: Buffer, _infoHash: string): ResolvedMetadata {
  const bencode = getBencodeParser()
  const decoded = bencode.decode(buf)
  return extractMetadata(decoded)
}

function extractMetadata(decoded: any): ResolvedMetadata {
  const info = decoded?.info
  if (!info) {
    throw new Error('No info dictionary in torrent data')
  }

  const name = bufferToString(info.name ?? 'Unknown')
  const files: TorrentFile[] = []
  let totalSize = 0

  if (info.files && Array.isArray(info.files) && info.files.length > 0) {
    // Multi-file torrent
    for (let i = 0; i < info.files.length; i++) {
      const f = info.files[i]
      const pathParts: string[] = []
      if (f.path && Array.isArray(f.path)) {
        for (const p of f.path) {
          pathParts.push(bufferToString(p))
        }
      }
      const filePath = pathParts.length > 0 ? pathParts.join('/') : `file_${i}`
      const size = typeof f.length === 'number' ? f.length : 0
      files.push({ index: i, name: filePath, size })
      totalSize += size
    }
    return { files, totalSize, name }
  }

  if (typeof info.length === 'number') {
    // Single-file torrent
    const size = info.length
    files.push({ index: 0, name, size })
    return { files, totalSize: size, name }
  }

  throw new Error('No files or length in torrent info dict')
}

function bufferToString(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  // Handle Buffer, Uint8Array, or Array of byte values
  if (Buffer.isBuffer(v)) return v.toString('utf-8')
  if (v instanceof Uint8Array) return new TextDecoder().decode(v)
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'number') {
    return String.fromCharCode(...v)
  }
  return String(v)
}

// ─── Bencode parser (lazy-loaded) ──────────────────────────────────────

let _bencodeModule: any = null
let _bencodeLoadAttempted = false

function getBencodeParser(): { decode: (buf: Buffer) => any; encode: (obj: any) => Buffer } {
  if (_bencodeModule) return _bencodeModule

  if (!_bencodeLoadAttempted) {
    _bencodeLoadAttempted = true
    try {
      // Try the 'bencode' npm package
      _bencodeModule = require('bencode')
      if (_bencodeModule) return _bencodeModule
    } catch { /* fall through */ }
  }

  // Use built-in minimal parser
  _bencodeModule = createMinimalBencodeParser()
  return _bencodeModule
}

// ─── Minimal bencode parser (fallback if npm package fails) ─────────────

function createMinimalBencodeParser() {
  return {
    decode(buf: Buffer): any {
      const decoder = new BencodeDecoder(buf)
      return decoder.decode()
    },
    encode(_obj: any): Buffer {
      throw new Error('encode not implemented in minimal parser')
    },
  }
}

class BencodeDecoder {
  private buf: Buffer
  private pos: number

  constructor(buf: Buffer) {
    this.buf = buf
    this.pos = 0
  }

  decode(): any {
    if (this.pos >= this.buf.length) throw new Error('Unexpected end of data')
    const char = this.buf[this.pos]!
    if (char === 0x69) return this.decodeInt()       // 'i'
    if (char === 0x6c) return this.decodeList()       // 'l'
    if (char === 0x64) return this.decodeDict()       // 'd'
    if (char >= 0x30 && char <= 0x39) return this.decodeString() // digit
    throw new Error(`Unexpected character at pos ${this.pos}: ${String.fromCharCode(char)} (0x${char.toString(16)})`)
  }

  private readByte(): number {
    if (this.pos >= this.buf.length) throw new Error('Unexpected end of bencoded data')
    return this.buf[this.pos++]!
  }

  private decodeInt(): number {
    this.pos++ // skip 'i'
    let str = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x65) {
      str += String.fromCharCode(this.readByte())
    }
    if (this.pos >= this.buf.length) throw new Error('Unterminated integer')
    this.pos++ // skip 'e'
    return parseInt(str, 10)
  }

  private decodeString(): Buffer {
    let lenStr = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3a) {
      const c = this.buf[this.pos]!
      if (c < 0x30 || c > 0x39) throw new Error(`Invalid string length at pos ${this.pos}`)
      lenStr += String.fromCharCode(this.readByte())
    }
    if (this.pos >= this.buf.length) throw new Error('Unterminated string length')
    this.pos++ // skip ':'
    const len = parseInt(lenStr, 10)
    if (this.pos + len > this.buf.length) throw new Error('String extends past end of data')
    const str = Buffer.from(this.buf.subarray(this.pos, this.pos + len))
    this.pos += len
    return str
  }

  private decodeList(): any[] {
    this.pos++ // skip 'l'
    const list: any[] = []
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x65) {
      list.push(this.decode())
    }
    if (this.pos >= this.buf.length) throw new Error('Unterminated list')
    this.pos++ // skip 'e'
    return list
  }

  private decodeDict(): Record<string, any> {
    this.pos++ // skip 'd'
    const dict: Record<string, any> = {}
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x65) {
      const key = this.decodeString().toString('utf-8')
      const value = this.decode()
      dict[key] = value
    }
    if (this.pos >= this.buf.length) throw new Error('Unterminated dictionary')
    this.pos++ // skip 'e'
    return dict
  }
}

// ─── Re-exports for convenience ─────────────────────────────────────────

export { extractQualityLabel }
