// Normalização de códigos de idioma entre provedores (cada um usa um padrão diferente).

const LABELS: Record<string, string> = {
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  en: 'Inglês',
  es: 'Espanhol',
}

/** Converte qualquer variante (pt-br, pob, pt_BR, br_pt, "Brazilian Portuguese") no canônico "pt-BR". */
export function canonicalLang(raw: string | null | undefined): string {
  if (!raw) return 'unknown'
  const s = raw.trim().toLowerCase()
  if (['pob', 'pt-br', 'pt_br', 'br', 'br_pt', 'brazilian', 'portuguese (brazilian)', 'portuguese, brazilian'].includes(s))
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

/** Códigos que o SubDL espera no filtro `languages` (verified 2026-08-30):
 *  pt-BR → BR_PT (o código `BR` existe mas casa 0 resultados), pt-PT → PT/PT_PT,
 *  en → EN. Sempre enviamos AMBOS os códigos conhecidos por idioma porque a
 *  aceitação varia por catálogo. */
export function toSubdlLangs(canonical: string): string[] {
  if (canonical === 'pt-BR') return ['BR_PT', 'BR']
  if (canonical === 'pt-PT') return ['PT', 'PT_PT']
  return [canonical.slice(0, 2).toUpperCase()]
}

/** @deprecated legado — use toSubdlLangs. Mantido para compat. */
export function toSubdlLang(canonical: string): string {
  return toSubdlLangs(canonical)[0]!
}
