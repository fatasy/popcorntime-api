/**
 * translate-synopses.ts
 *
 * Cron job that gradually translates anime synopses from English to pt-BR.
 *
 * Run: bun run src/jobs/translate-synopses.ts
 */

import { db } from '../db'
import { contents } from '../types'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

const API_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const MODEL = 'deepseek-v4-flash'

const BATCH = Math.min(100, Math.max(1, parseInt(process.env.BATCH_SIZE || '50', 10)))
const DELAY_MS = 500

interface TranslationResult {
  success: boolean
  translated?: string
  error?: string
}

async function getApiKey(): Promise<string> {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY
  const envFile = Bun.file(process.env.HOME + '/.hermes/.env')
  const text = await envFile.text()
  const pfx = 'OPENCODE_GO'
  const sfx = '_API_KEY='
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(pfx + sfx)) {
      const val = trimmed.split('=', 2)[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
      if (val) return val
    }
  }
  console.error('[translate] No OPENCODE_GO_API_KEY found')
  process.exit(1)
}

async function translate(apiKey: string, text: string): Promise<TranslationResult> {
  try {
    const maxTokens = Math.max(4000, text.length * 4)

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: `Translate to Brazilian Portuguese. Preserve proper names (character names, techniques, locations). Only the translation.\n\n${text}`,
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { success: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    const data = await res.json() as any
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    const reasoningLen = (data?.choices?.[0]?.message?.reasoning_content ?? '').length

    if (!content || content.trim().length === 0) {
      return { success: false, error: `Empty response (reasoning: ${reasoningLen} chars)` }
    }

    return { success: true, translated: content.trim() }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function main() {
  const apiKey = await getApiKey()
  console.log(`[translate] Starting — batch size: ${BATCH}, model: ${MODEL}`)

  const pending = await db
    .select({ id: contents.id, title: contents.title, synopsis: contents.synopsis })
    .from(contents)
    .where(
      and(
        eq(contents.type, 'anime'),
        isNotNull(contents.synopsis),
        isNull(contents.synopsis_raw),
      ),
    )
    .limit(BATCH)

  if (pending.length === 0) {
    console.log('[translate] No anime pending translation. All done!')
    process.exit(0)
  }

  console.log(`[translate] Found ${pending.length} anime to translate`)

  let ok = 0
  let fail = 0

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!
    const label = `[${i + 1}/${pending.length}]`

    if (!item.synopsis || item.synopsis.trim().length < 10) {
      await db
        .update(contents)
        .set({ synopsis_raw: item.synopsis ?? '' })
        .where(eq(contents.id, item.id))
      console.log(`${label} SKIP "${item.title}" (synopsis too short)`)
      continue
    }

    await db
      .update(contents)
      .set({ synopsis_raw: item.synopsis })
      .where(eq(contents.id, item.id))

    const result = await translate(apiKey, item.synopsis)

    if (result.success && result.translated) {
      await db
        .update(contents)
        .set({ synopsis: result.translated, updated_at: sql`now()` })
        .where(eq(contents.id, item.id))
      console.log(`${label} OK "${item.title}" (${item.synopsis.length}->${result.translated.length} chars)`)
      ok++
    } else {
      console.warn(`${label} FAIL "${item.title}": ${result.error}`)
      fail++
    }

    if (i < pending.length - 1) {
      await Bun.sleep(DELAY_MS)
    }
  }

  console.log(`\n[translate] Done: ${ok} translated, ${fail} failed, ${pending.length - ok - fail} skipped/empty`)
}

main().catch((err) => {
  console.error('[translate] Fatal:', err)
  process.exit(1)
})
