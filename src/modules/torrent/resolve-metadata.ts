import { createHash } from 'node:crypto'
import { gunzipSync } from 'fflate'
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

export interface ResolvedMetainfo {
  data: Buffer
  metadata: ResolvedMetadata
  infoHash: string
  source: string
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
  if (m32) return base32ToHex(m32[1]!)

  return null
}

function base32ToHex(input: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (const char of input.toUpperCase()) {
    const digit = alphabet.indexOf(char)
    if (digit < 0) return null
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }

  return bytes.length === 20 ? Buffer.from(bytes).toString('hex') : null
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
  {
    name: 'torrage',
    url: (hash: string) => `https://torrage.info/download.php?h=${hash.toUpperCase()}`,
  },
  {
    name: 'btcache',
    url: (hash: string) => `https://btcache.me/torrent/${hash.toUpperCase()}`,
  },
  {
    name: 'itorrents',
    url: (hash: string) => `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`,
  },
]

const FETCH_TIMEOUT_MS = 8_000
const MAX_TORRENT_BYTES = 8 * 1024 * 1024

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
  const result = await resolveTorrentMetainfo(magnetLink)
  return result?.metadata ?? null
}

/**
 * Resolve e valida o .torrent completo. O SHA-1 é calculado sobre os bytes exatos
 * do dicionário `info`; respostas que não casam com o magnet são rejeitadas.
 */
export async function resolveTorrentMetainfo(
  magnetLink: string,
): Promise<ResolvedMetainfo | null> {
  const infoHash = extractInfoHash(magnetLink)
  if (!infoHash) {
    console.warn('[resolve-metadata] Could not extract info hash from magnet')
    return null
  }

  const controllers = TORRENT_CACHES.map(() => new AbortController())
  try {
    return await Promise.any(
      TORRENT_CACHES.map((cache, index) =>
        fetchTorrentFile(cache, infoHash, controllers[index]!.signal),
      ),
    )
  } catch {
    return null
  } finally {
    for (const controller of controllers) controller.abort()
  }
}

// ─── HTTP-based metadata fetching ───────────────────────────────────────

async function fetchTorrentFile(
  cache: (typeof TORRENT_CACHES)[number],
  infoHash: string,
  outerSignal: AbortSignal,
): Promise<ResolvedMetainfo> {
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS)
  const abort = () => timeoutController.abort()
  outerSignal.addEventListener('abort', abort, { once: true })

  try {
    const response = await fetch(cache.url(infoHash), {
      signal: timeoutController.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PopcornTime/1.0)',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_TORRENT_BYTES) throw new Error('metainfo too large')

    const compressed = Buffer.from(await response.arrayBuffer())
    const body =
      compressed[0] === 0x1f && compressed[1] === 0x8b
        ? Buffer.from(gunzipSync(compressed))
        : compressed
    if (body.length < 50 || body.length > MAX_TORRENT_BYTES) {
      throw new Error('invalid metainfo size')
    }

    const contentType = response.headers.get('content-type') ?? ''
    const data = contentType.includes('text/html') ? extractTorrentFromHtml(body) : body
    if (!data) throw new Error('no torrent data in response')

    return validateTorrentMetainfo(data, infoHash, cache.name)
  } finally {
    clearTimeout(timeout)
    outerSignal.removeEventListener('abort', abort)
  }
}

function extractTorrentFromHtml(body: Buffer): Buffer | null {
  const text = body.toString('utf-8')
  const match = text.match(/data:application\/x-bittorrent;base64,([^"']+)/i)
  return match ? Buffer.from(match[1]!, 'base64') : null
}

// ─── Parse bencoded torrent data ────────────────────────────────────────

export function validateTorrentMetainfo(
  data: Buffer,
  infoHash: string,
  source: string,
): ResolvedMetainfo {
  if (data.length < 50 || data.length > MAX_TORRENT_BYTES) {
    throw new Error('invalid metainfo size')
  }
  const metadata = parseTorrentData(data)
  const actualHash = hashInfoDictionary(data)
  if (actualHash !== infoHash.toLowerCase()) {
    throw new Error(`info hash mismatch: ${actualHash}`)
  }
  return { data, metadata, infoHash: actualHash, source }
}

function parseTorrentData(buf: Buffer): ResolvedMetadata {
  const bencode = getBencodeParser()
  const decoded = bencode.decode(buf)
  return extractMetadata(decoded)
}

function hashInfoDictionary(buf: Buffer): string {
  const info = findTopLevelDictionaryValue(buf, 'info')
  if (!info) throw new Error('No raw info dictionary in torrent data')
  return createHash('sha1').update(info).digest('hex')
}

function findTopLevelDictionaryValue(buf: Buffer, wantedKey: string): Buffer | null {
  if (buf[0] !== 0x64) throw new Error('Torrent root is not a dictionary')
  let pos = 1

  while (pos < buf.length && buf[pos] !== 0x65) {
    const key = readBencodedString(buf, pos)
    pos = key.end
    const valueStart = pos
    pos = skipBencodedValue(buf, pos)
    if (key.value.toString('utf-8') === wantedKey) {
      return Buffer.from(buf.subarray(valueStart, pos))
    }
  }
  return null
}

function readBencodedString(buf: Buffer, start: number): { value: Buffer; end: number } {
  let colon = start
  while (colon < buf.length && buf[colon] !== 0x3a) {
    const byte = buf[colon]!
    if (byte < 0x30 || byte > 0x39) throw new Error('Invalid bencoded string')
    colon++
  }
  if (colon >= buf.length) throw new Error('Unterminated bencoded string')

  const length = Number(buf.toString('ascii', start, colon))
  const valueStart = colon + 1
  const end = valueStart + length
  if (!Number.isSafeInteger(length) || length < 0 || end > buf.length) {
    throw new Error('Invalid bencoded string length')
  }
  return { value: Buffer.from(buf.subarray(valueStart, end)), end }
}

function skipBencodedValue(buf: Buffer, start: number): number {
  const marker = buf[start]
  if (marker == null) throw new Error('Unexpected end of bencoded data')

  if (marker >= 0x30 && marker <= 0x39) return readBencodedString(buf, start).end
  if (marker === 0x69) {
    const end = buf.indexOf(0x65, start + 1)
    if (end < 0) throw new Error('Unterminated bencoded integer')
    return end + 1
  }
  if (marker === 0x6c || marker === 0x64) {
    let pos = start + 1
    while (pos < buf.length && buf[pos] !== 0x65) {
      if (marker === 0x64) pos = readBencodedString(buf, pos).end
      pos = skipBencodedValue(buf, pos)
    }
    if (pos >= buf.length) throw new Error('Unterminated bencoded collection')
    return pos + 1
  }
  throw new Error(`Invalid bencoded marker at ${start}`)
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
