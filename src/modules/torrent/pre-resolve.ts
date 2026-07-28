import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { content_torrents, torrent_metadata, torrents } from '../../types'
import { resolveTorrentMetainfo } from './resolve-metadata'
import {
  createMetadataClient,
  destroyMetadataClient,
  resolveMetainfoFromSwarm,
  type MetadataClient,
} from './swarm-metadata'

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export interface PreResolveResult {
  attempted: number
  resolved: number
  failed: number
}

/**
 * Resolve um lote pequeno de torrents visíveis no catálogo. Primários e mais
 * seedados vêm primeiro; falhas só voltam à fila após 24 horas.
 */
export async function preResolveTorrentMetadata(
  limit = 25,
  concurrency = 4,
): Promise<PreResolveResult> {
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS)
  const linked = sql<boolean>`exists (
    select 1 from ${content_torrents}
    where ${content_torrents.torrent_id} = ${torrents.id}
  )`
  const primary = sql<boolean>`exists (
    select 1 from ${content_torrents}
    where ${content_torrents.torrent_id} = ${torrents.id}
      and ${content_torrents.is_primary} = true
  )`

  const candidates = await db
    .select({
      hash: torrents.hash,
      magnetLink: torrents.magnet_link,
    })
    .from(torrents)
    .leftJoin(torrent_metadata, eq(torrent_metadata.hash, torrents.hash))
    .where(
      and(
        linked,
        isNull(torrent_metadata.metainfo),
        or(
          isNull(torrent_metadata.last_attempt_at),
          lt(torrent_metadata.last_attempt_at, retryBefore),
        ),
      ),
    )
    .orderBy(desc(primary), desc(torrents.seeds))
    .limit(Math.max(1, limit))

  let resolved = 0
  const workerCount = Math.min(Math.max(1, concurrency), candidates.length || 1)
  let nextIndex = 0
  let swarmClient: MetadataClient | null = null
  const getSwarmClient = () => {
    swarmClient ??= createMetadataClient()
    return swarmClient
  }

  try {
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const candidate = candidates[nextIndex++]!
          const attemptedAt = new Date()

          try {
            const result =
              (await resolveTorrentMetainfo(candidate.magnetLink)) ??
              (await resolveMetainfoFromSwarm(getSwarmClient(), candidate.magnetLink))

            await db
              .insert(torrent_metadata)
              .values({
                hash: candidate.hash,
                metadata: result.metadata,
                metainfo: result.data,
                source: result.source,
                attempt_count: 1,
                last_attempt_at: attemptedAt,
                resolved_at: attemptedAt,
                last_error: null,
              })
              .onConflictDoUpdate({
                target: torrent_metadata.hash,
                set: {
                  metadata: result.metadata,
                  metainfo: result.data,
                  source: result.source,
                  attempt_count: sql`${torrent_metadata.attempt_count} + 1`,
                  last_attempt_at: attemptedAt,
                  resolved_at: attemptedAt,
                  last_error: null,
                },
              })
            resolved++
          } catch (err) {
            const message = String((err as Error).message ?? err).slice(0, 1000)
            await db
              .insert(torrent_metadata)
              .values({
                hash: candidate.hash,
                metadata: null,
                metainfo: null,
                attempt_count: 1,
                last_attempt_at: attemptedAt,
                resolved_at: null,
                last_error: message,
              })
              .onConflictDoUpdate({
                target: torrent_metadata.hash,
                set: {
                  attempt_count: sql`${torrent_metadata.attempt_count} + 1`,
                  last_attempt_at: attemptedAt,
                  last_error: message,
                },
              })
          }
        }
      }),
    )
  } finally {
    if (swarmClient) await destroyMetadataClient(swarmClient)
  }

  return {
    attempted: candidates.length,
    resolved,
    failed: candidates.length - resolved,
  }
}
