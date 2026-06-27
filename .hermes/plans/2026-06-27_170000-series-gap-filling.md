# Plano: Preenchimento de Gaps de Temporadas/Episódios

**Meta:** Catálogo de séries completo — todas as temporadas e episódios disponíveis, não só os do top 100.

**Salvo:** `.hermes/plans/2026-06-27_170000-series-gap-filling.md`

---

## Diagnóstico

O pipeline atual coleta do `apibay.org/precompiled/data_top100_<cat>.json` — só os 100 torrents mais seedados de cada categoria. Para séries, isso significa que **só a temporada mais recente aparece** (ex: Euphoria S03, mas não S01/S02).

**Euphoria (tmdb_id=85552, 3 temporadas):**
- Temos: S03E03 (2 torrents), S03E08 (1 torrent)
- Faltam: S01 (8 episódios), S02 (8 episódios), S03E01-E02,E04-E07
- **Cobertura: 2 de 24 episódios (8%)**

---

## Abordagem

Adicionar uma etapa de **preenchimento ativo de gaps** após o enriquecimento TMDB. Para cada série com TMDB ID, comparar o que temos com o que o TMDB diz que existe, e buscar torrents faltantes em fontes secundárias.

### Fontes para busca direcionada

| Fonte | Endpoint | Cobertura | Temporadas antigas? |
|-------|----------|-----------|-------------------|
| **EZTV** | `api/get-torrents?imdb_id=ttXXXX` | Dedicado a séries | ✅ S01-S03 |
| **apibay search** | `q.php?q=show+s01e01` | Geral | ⚠️ Baixa |
| **SolidTorrents** | `api/v1/search?q=show+s01e01` | DHT index | ✅ Boa |
| **LimeTorrents** | Scraping HTML | Geral | ✅ Boa |
| **Nyaa** (anime) | `nyaa.si/?q=show+s01` | Anime | ✅ |

**Fonte primária: EZTV** — organizado por IMDB ID, já tem season/episode estruturado, magnet links, seeds.

---

## Cards

### Card 1 — EZTV Source (`src/modules/collection/sources/eztv.ts`)
**Escopo:** Módulo que busca torrents de uma série pelo IMDB ID no EZTV.

- Endpoint: `https://eztvx.to/api/get-torrents?imdb_id=<imdb_id>`
- Cada entrada já tem: `title`, `hash`, `magnet_url`, `season`, `episode`, `seeds`, `size_bytes`
- Mapear para `RawTorrent` (interface existente)
- Rate limit: 1 req/s
- **Validação:** Chamar com `imdb_id=tt8772296` (Euphoria) e verificar se retorna torrents de S01, S02, S03

### Card 2 — SolidTorrents Search Source (`src/modules/collection/sources/solidtorrents.ts`)
**Escopo:** Módulo que busca torrents por query no SolidTorrents.

- Endpoint: `https://solidtorrents.to/api/v1/search?q=<query>`
- Tem file list no endpoint de detalhes (`/api/v1/torrent/<id>`)
- Mapear para `RawTorrent`
- **Validação:** Buscar "Euphoria S01E01" e confirmar resultados

### Card 3 — Gap Detector (`src/modules/collection/gap-detector.ts`)
**Escopo:** Dado um conteúdo enriquecido com TMDB, detectar quais temporadas/episódios estão faltando.

- Input: `content_id` (com tmdb_id populado)
- Consulta TMDB `/tv/<tmdb_id>` → lista de temporadas e episódios
- Consulta banco → quais `content_torrents` já existem
- Output: `{ season: number, episode: number }[]` (gaps)
- Cache em `metadata_cache` (TTL 24h para não repetir chamadas TMDB)
- **Validação:** Rodar para Euphoria (id=59), verificar output: S01E01-E08, S02E01-E08, S03E01-E02,E04-E07

### Card 4 — Gap Filler Pipeline Step (`src/modules/collection/fill-gaps.ts`)
**Escopo:** Para cada série enriquecida, detectar gaps e buscar torrents.

- Itera sobre `contents` com `tmdb_id` populado e `type = 'series'`
- Para cada uma, chama o gap detector
- Para cada gap, busca em EZTV + SolidTorrents (paralelo por fonte)
- Insere torrents novos no banco (se hash não existe)
- Linka ao conteúdo existente via `content_torrents`
- Processa no máximo 10 séries por execução (para não sobrecarregar)
- **Validação:** Rodar para Euphoria, verificar se S01 e S02 aparecem no catálogo

### Card 5 — Integração no Pipeline
**Escopo:** Adicionar o passo de gap filling no pipeline principal.

- Adicionar após `enrichPending` e antes de `mergeByTmdbId`
- Chamar `fillGaps(limit=5)` — processa 5 séries por execução
- Idempotente: séries já preenchidas são puladas (verificar `last_gap_fill_at`)
- Adicionar coluna `last_gap_fill_at` na tabela `contents`
- **Validação:** Rodar pipeline completo, verificar que Euphoria agora tem múltiplas temporadas

### Card 6 — Expor na API
**Escopo:** As rotas do catálogo já retornam os torrents por conteúdo. Após o gap filling, novas temporadas aparecem automaticamente.

- Verificar `GET /catalog/:id/episodes` — retorna episódios com magnet links
- Confirmar que após gap fill, S01 e S02 da Euphoria aparecem com magnet links
- Sem alterações de código necessárias (a estrutura já suporta)
- **Validação:** `curl /catalog/59/episodes` e verificar presença de S01E01, S02E01, etc.

---

## Estimativas

| Card | Descrição | Tempo |
|------|-----------|-------|
| 1 | EZTV source | 45min |
| 2 | SolidTorrents source | 30min |
| 3 | Gap detector | 1h |
| 4 | Gap filler step | 1h |
| 5 | Pipeline integration | 30min |
| 6 | API verification | 15min |
| **Total** | | **~4h** |

## Dependências

```
Card 1 ──┐
Card 2 ──┤
          ├──> Card 4 ──> Card 5 ──> Card 6
Card 3 ──┘
```

Cards 1, 2, 3 podem ser feitos em paralelo. Card 4 depende dos 3. Cards 5 e 6 são sequenciais.

## Riscos

- **EZTV API rate limit**: Pode bloquear se usarmos rápido demais. Mitigação: 1 req/s + cache.
- **Cobertura de temporadas antigas**: EZTV pode não ter S01 de todas as séries. Fallback: SolidTorrents + LimeTorrents.
- **Qualidade dos torrents antigos**: Muitos seeds? Mitigação: filtrar por seeds > 0, priorizar mais seedados.
- **Volume de chamadas TMDB**: Gap detector consulta TMDB por série. Mitigação: cache 24h + rate limit.

## Arquivos que serão criados/alterados

- **Novos:** `src/modules/collection/sources/eztv.ts`
- **Novos:** `src/modules/collection/sources/solidtorrents.ts`
- **Novos:** `src/modules/collection/gap-detector.ts`
- **Novos:** `src/modules/collection/fill-gaps.ts`
- **Alterado:** `src/jobs/pipeline.ts` (adicionar step)
- **Alterado:** `src/types.ts` (coluna `last_gap_fill_at`)
- **Alterado:** DB migration (adicionar coluna)
