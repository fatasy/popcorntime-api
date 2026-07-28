import WebTorrent from 'webtorrent'
import {
  extractInfoHash,
  type ResolvedMetainfo,
  validateTorrentMetainfo,
} from './resolve-metadata'

const SWARM_TIMEOUT_MS = 30_000
const DESTROY_TIMEOUT_MS = 3_000

export type MetadataClient = InstanceType<typeof WebTorrent>

export function createMetadataClient(): MetadataClient {
  const client = new WebTorrent({ utp: false })
  client.on('error', (err: string | Error) => {
    console.warn('[metainfo/swarm] client error:', err instanceof Error ? err.message : err)
  })
  return client
}

/**
 * Entra no swarm somente até receber o ut_metadata. O torrent é removido
 * imediatamente após o evento, antes de iniciar download útil das peças.
 */
export function resolveMetainfoFromSwarm(
  client: MetadataClient,
  magnetLink: string,
): Promise<ResolvedMetainfo> {
  const infoHash = extractInfoHash(magnetLink)
  if (!infoHash) return Promise.reject(new Error('invalid magnet info hash'))

  return new Promise((resolve, reject) => {
    const torrent = client.add(metadataOnlyMagnet(magnetLink), {
      destroyStoreOnDestroy: true,
    })
    let settled = false

    const removeTorrent = () => {
      void client.remove(torrent, { destroyStore: true }).catch(() => {})
    }
    const finish = (err?: Error, result?: ResolvedMetainfo) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      torrent.removeListener('metadata', onMetadata)
      torrent.removeListener('error', onError)
      removeTorrent()
      if (err) reject(err)
      else resolve(result!)
    }
    const onMetadata = () => {
      try {
        const data = Buffer.from(torrent.torrentFile)
        finish(undefined, validateTorrentMetainfo(data, infoHash, 'swarm'))
      } catch (err) {
        finish(err as Error)
      }
    }
    const onError = (err: Error) => finish(err)
    const timeout = setTimeout(
      () => finish(new Error('swarm metadata timeout')),
      SWARM_TIMEOUT_MS,
    )

    torrent.once('metadata', onMetadata)
    torrent.once('error', onError)
  })
}

function metadataOnlyMagnet(magnetLink: string): string {
  const input = new URL(magnetLink)
  const output = new URL('magnet:?')
  for (const key of ['xt', 'dn', 'tr']) {
    for (const value of input.searchParams.getAll(key)) {
      output.searchParams.append(key, value)
    }
  }
  return output.toString()
}

export async function destroyMetadataClient(client: MetadataClient): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => client.destroy(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, DESTROY_TIMEOUT_MS)),
  ])
}
