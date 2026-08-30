// Job dedicado: upgrade de qualidade de filmes recentes.
//
// Por que existe: um filme em cartaz só tem CAM/TS/HDTS no catálogo; a fonte
// boa (WEB-DL/BluRay 1080p/2160p) aparece semanas/meses depois e o pipeline
// normal (top-100 apibay) nunca volta atrás. Este job varre filmes recentes
// (120 dias) que ainda não têm fonte 1080p+, procura no SolidTorrents pelo
// título PT **e** original (EN), e insere/promove a melhor fonte.
//
// Roda via cron Hermes (job: "PopcornTime qualidade de filmes", a cada 2h).
// O pipeline de 30min também roda uma passada pequena (limit=10) — este job
// cobre a cauda completa (limit=40) com folga de rate-limit.

import { upgradeRecentMovieQuality } from '../modules/collection/movie-quality-upgrade'

const limit = Number(process.env.QUALITY_UPGRADE_LIMIT ?? '40')

console.log(`=== movie-quality-upgrade job (limit=${limit}) ===`)
const upgraded = await upgradeRecentMovieQuality(limit)
console.log(`\n=== done: ${upgraded.length} movie(s) upgraded ===`)
for (const r of upgraded) {
  console.log(`  #${r.contentId} "${r.title}" -> ${r.quality} | ${r.addedTitle?.slice(0, 80)}`)
}
process.exit(0)