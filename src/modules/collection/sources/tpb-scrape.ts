import * as cheerio from 'cheerio'
import {
  buildMagnet,
  extractHash,
  parseSizeToBytes,
  USER_AGENT,
  type RawTorrent,
} from '../../../lib/parse'

const BASE = 'https://thepiratebay.org'

/**
 * Scrape a The Pirate Bay browse page (classic `#searchResult` table layout)
 * for a given category id. Returns raw torrents; failures are logged and the
 * collector falls back to apibay.
 */
export async function scrapeTpb(
  cat: number,
  category: string,
  pages = 1,
): Promise<RawTorrent[]> {
  const out: RawTorrent[] = []

  for (let page = 0; page < pages; page++) {
    try {
      // classic browse URL: /browse/<cat>/<page>/<orderby=99 seeders>
      const url = `${BASE}/browse/${cat}/${page}/99/0`
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn(`[tpb] HTTP ${res.status} cat=${cat} page=${page}`)
        continue
      }

      const html = await res.text()
      const $ = cheerio.load(html)
      const rows = $('table#searchResult tr')

      rows.each((_, el) => {
        try {
          const tr = $(el)
          const title = tr.find('.detName a.detLink').first().text().trim()
          if (!title) return // header row / no name

          const magnet = tr.find('a[href^="magnet:"]').first().attr('href') ?? ''
          const hash = extractHash(magnet)
          if (!hash) return

          const tds = tr.find('td')
          const seeds = parseInt(tds.eq(-2).text().trim(), 10) || 0
          const leechers = parseInt(tds.eq(-1).text().trim(), 10) || 0

          const desc = tr.find('.detDesc').text().replace(/ /g, ' ')
          const sizeMatch = desc.match(/Size\s+([\d.,]+\s*[KMGT]i?B)/i)
          const size_bytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]!) : null

          const upMatch = desc.match(/ULed by\s+(.+?)\s*$/i)
          const uploader =
            (upMatch ? upMatch[1]!.trim() : '') ||
            tr.find('.detDesc a').last().text().trim() ||
            null

          out.push({
            source: 'tpb',
            hash,
            title,
            magnet_link: magnet || buildMagnet(hash, title),
            seeds,
            leechers,
            size_bytes,
            uploader,
            category,
            published_at: null,
          })
        } catch {
          // skip malformed row, keep going
        }
      })
    } catch (err) {
      console.warn(`[tpb] scrape failed cat=${cat} page=${page}:`, (err as Error).message)
    }
  }

  return out
}
