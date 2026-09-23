// Pós-processamento: descompacta (gzip), corrige encoding (Latin-1/Windows-1252 → UTF-8)
// e converte SRT → WebVTT, para o player receber sempre UTF-8 limpo.

/** Descompacta se os bytes forem um gzip (magic 1f 8b). */
export function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>)
  }
  return bytes
}

/** Decodifica para string corrigindo acentuação PT-BR (UTF-8 → fallback Windows-1252/Latin-1). */
export function decodeToString(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes)
    } catch {
      return Buffer.from(bytes).toString('latin1')
    }
  }
}

export function srtToVtt(input: string): string {
  let s = input
    .replace(/^﻿/, '') // remove BOM
    .replace(/\r\n?/g, '\n') // normaliza quebras de linha
  if (s.trimStart().toUpperCase().startsWith('WEBVTT')) {
    return s.trim() + '\n' // já é VTT
  }
  // timestamps SRT (vírgula) → VTT (ponto): 00:00:01,000 → 00:00:01.000
  s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return 'WEBVTT\n\n' + s.trim() + '\n'
}

function assTimestampToVtt(value: string): string | null {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/)
  if (!match) return null

  const hours = match[1]!
  const minutes = match[2]!
  const seconds = match[3]!
  const fraction = match[4]!
  const milliseconds = fraction.padEnd(3, '0').slice(0, 3)
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${milliseconds}`
}

function splitAssFields(value: string, fieldCount: number): string[] {
  const fields: string[] = []
  let remainder = value

  for (let index = 0; index < fieldCount - 1; index++) {
    const comma = remainder.indexOf(',')
    if (comma < 0) break
    fields.push(remainder.slice(0, comma))
    remainder = remainder.slice(comma + 1)
  }

  fields.push(remainder)
  return fields
}

function cleanAssText(value: string): string {
  return value
    .replace(/\{\\i1\}/gi, '<i>')
    .replace(/\{\\i0\}/gi, '</i>')
    .replace(/\{\\b1\}/gi, '<b>')
    .replace(/\{\\b0\}/gi, '</b>')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim()
}

/** Converte a seção Events de uma legenda ASS/SSA em cues WebVTT. */
export function assToVtt(input: string): string | null {
  const lines = input
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  let inEvents = false
  let format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
  const cues: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[events\]$/i.test(trimmed)) {
      inEvents = true
      continue
    }
    if (/^\[.+\]$/.test(trimmed)) {
      inEvents = false
      continue
    }
    if (!inEvents) continue

    const formatMatch = trimmed.match(/^Format:\s*(.+)$/i)
    if (formatMatch) {
      format = formatMatch[1]!.split(',').map((field) => field.trim())
      continue
    }

    const dialogueMatch = line.match(/^\s*Dialogue:\s*(.*)$/i)
    if (!dialogueMatch) continue

    const fields = splitAssFields(dialogueMatch[1]!, format.length)
    if (fields.length !== format.length) continue

    const values = new Map(format.map((field, index) => [field.toLowerCase(), fields[index]]))
    const start = assTimestampToVtt(values.get('start') ?? '')
    const end = assTimestampToVtt(values.get('end') ?? '')
    const text = cleanAssText(values.get('text') ?? '')
    if (!start || !end || !text) continue

    cues.push(`${cues.length + 1}\n${start} --> ${end}\n${text}`)
  }

  return cues.length > 0 ? `WEBVTT\n\n${cues.join('\n\n')}\n` : null
}

/** Pipeline completo: bytes brutos → string VTT UTF-8 pronta para o player. */
export function normalizeToVtt(raw: Uint8Array): string {
  const inflated = maybeGunzip(raw)
  const text = decodeToString(inflated)
  const ass = assToVtt(text)
  if (ass) return ass
  return srtToVtt(text)
}
