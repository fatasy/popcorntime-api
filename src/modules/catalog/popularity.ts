import { sql } from 'drizzle-orm'
import { contents } from '../../types'

/** Persisted current rankings come first; seeds break ties and rank unlisted works. */
export const CURRENT_RANK_SQL = sql`COALESCE((
  SELECT 10000 - ranked.position::int
  FROM metadata_cache mc
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(mc.response->'items') = 'array'
      THEN mc.response->'items' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS ranked(item, position)
  WHERE mc.source = 'trending' AND mc.lookup_key = 'list:' || ${contents.type}
    AND mc.cached_at > now() - interval '7 days'
    AND ranked.item->>'id' = ${contents.id}::text
  ORDER BY ranked.position LIMIT 1
), 0)`
