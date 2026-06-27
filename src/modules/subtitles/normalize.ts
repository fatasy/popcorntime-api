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

/** Pipeline completo: bytes brutos → string VTT UTF-8 pronta para o player. */
export function normalizeToVtt(raw: Uint8Array): string {
  const inflated = maybeGunzip(raw)
  const text = decodeToString(inflated)
  return srtToVtt(text)
}
