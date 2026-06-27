// Normalização de códigos de idioma entre provedores (cada um usa um padrão diferente).

const LABELS: Record<string, string> = {
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  en: 'Inglês',
  es: 'Espanhol',
}

/** Converte qualquer variante (pt-br, pob, pt_BR, "Brazilian Portuguese") no canônico "pt-BR". */
export function canonicalLang(raw: string | null | undefined): string {
  if (!raw) return 'unknown'
  const s = raw.trim().toLowerCase()
  if (['pob', 'pt-br', 'pt_br', 'br', 'brazilian', 'portuguese (brazilian)', 'portuguese, brazilian'].includes(s))
    return 'pt-BR'
  if (['por', 'pt', 'pt-pt', 'pt_pt', 'portuguese'].includes(s)) return 'pt-PT'
  // formato xx-YY genérico
  const m = s.match(/^([a-z]{2})[-_]([a-z]{2})$/)
  if (m) return `${m[1]}-${m[2]!.toUpperCase()}`
  return s.slice(0, 2)
}

export function langLabel(canonical: string): string {
  return LABELS[canonical] ?? canonical
}

/** Prioridade de exibição: pt-BR primeiro, depois pt-PT, depois inglês. */
export function langPriority(canonical: string): number {
  const order: Record<string, number> = { 'pt-BR': 0, 'pt-PT': 1, en: 2 }
  return order[canonical] ?? 50
}

/** Código que o OpenSubtitles REST espera (minúsculo: pt-br, pt-pt, en). */
export function toOpenSubtitlesLang(canonical: string): string {
  return canonical.toLowerCase()
}

/** Código que o SubDL espera (BR, PT, EN...). */
export function toSubdlLang(canonical: string): string {
  if (canonical === 'pt-BR') return 'BR'
  if (canonical === 'pt-PT') return 'PT'
  return canonical.slice(0, 2).toUpperCase()
}
