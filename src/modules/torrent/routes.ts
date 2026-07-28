import { Elysia, t } from 'elysia'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { torrent_metadata } from '../../types'

const HEX_INFO_HASH = /^[a-f0-9]{40}$/i

export const torrentRoutes = new Elysia().get(
  '/torrents/:hash/metainfo',
  async ({ params, request, set }) => {
    const hash = params.hash.toLowerCase()
    if (!HEX_INFO_HASH.test(hash)) {
      set.status = 400
      return { error: 'Invalid info hash' }
    }

    const [row] = await db
      .select({ metainfo: torrent_metadata.metainfo })
      .from(torrent_metadata)
      .where(eq(torrent_metadata.hash, hash))
      .limit(1)

    if (!row?.metainfo) {
      set.status = 404
      set.headers['cache-control'] = 'public, max-age=300'
      return { error: 'Metainfo not found' }
    }

    const etag = `"${hash}"`
    const cacheHeaders = {
      'cache-control': 'public, max-age=31536000, immutable',
      etag,
    }
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: cacheHeaders })
    }

    const body = Buffer.from(row.metainfo)
    return new Response(body, {
      headers: {
        ...cacheHeaders,
        'content-type': 'application/x-bittorrent',
        'content-length': String(body.length),
        'content-disposition': `inline; filename="${hash}.torrent"`,
      },
    })
  },
  {
    params: t.Object({ hash: t.String() }),
    detail: {
      summary: 'Get cached torrent metainfo by info hash',
      tags: ['torrent'],
    },
  },
)
