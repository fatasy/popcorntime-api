# Plano: Agrupamento Inteligente + Resolução de Episódios (sem streaming server-side)

**Objetivo:**  
1. Catálogo mostrar **1 entrada por série**, com temporadas/episódios listados  
2. Servidor **resolve metadados** dos torrents (qual arquivo = qual episódio) — **sem fazer streaming**  
3. Frontend consome a API e faz streaming P2P (WebTorrent no client)

**Arquitetura:**
```
Servidor (API)              Frontend (app)
┌──────────────┐           ┌──────────────────┐
│ Organiza      │           │ Recebe magnet +   │
│ metadados     │──────────▶│ file index        │
│ Resolve       │           │ Faz streaming     │
│ torrent→ep    │           │ P2P (WebTorrent)  │
└──────────────┘           └──────────────────┘
```

---

## Card 1 — Mesclar séries por `tmdb_id` + expor temporadas

**Problema:** Hoje cada temporada vira um `content` separado. "The Vampire Diaries S01", "S02"... = 8 linhas no catálogo.

**Solução:** Após enriquecimento, mesclar conteúdos de série com mesmo `tmdb_id`.

**Steps:**

1. **Migração:** Adicionar `season` e `episode` na tabela `content_torrents`
   - O `contents.season`/`episode` continua existindo (útil para filmes e anime), mas para séries a info da temporada vai no vínculo
   
2. **Nova função `mergeByTmdbId()` em `src/modules/grouping/`**
   - Agrupa `contents` de série com mesmo `tmdb_id` não-nulo
   - Elege o content com melhores metadados (poster, sinopse, rating) como canônico
   - Move `content_torrents` dos órfãos para o canônico
   - Deleta `contents` órfãos
   - Log: `[merge] "The Vampire Diaries" (tmdb:18165): 6 seasons merged`

3. **Hook no pipeline.ts:** `mergeByTmdbId()` após `enrichPending()`

4. **Rota `GET /catalog/:id`** — para séries, inclui array `seasons`:
   ```json
   {
     "id": 42,
     "title": "The Vampire Diaries",
     "year": 2009,
     "rating": "8.4",
     "seasons": [
       {
         "season": 1,
         "torrents": [
           { "title": "... S01E01", "seeds": 450, "magnet": "..." },
           { "title": "... S01 Complete", "seeds": 320, "magnet": "..." }
         ]
       }
     ]
   }
   ```

5. **Verificação:** `GET /catalog` mostra série 1x. `GET /catalog/42` lista temporadas.

---

## Card 2 — Resolver arquivos do torrent → mapear episódios

**Problema:** Um torrent "The Vampire Diaries S01 Complete" tem 22 arquivos `.mkv`. O frontend precisa saber qual arquivo = qual episódio para tocar só o S01E05.

**Solução:** Servidor busca metadados do torrent (file list) via DHT/trackers, faz parse dos nomes de arquivo, mapeia para season/episode. **Sem baixar o conteúdo.**

**Steps:**

1. **Instalar `bittorrent-dht` ou usar `magnet2torrent` leve** para resolver magnet → torrent metadata (só o info dict, sem baixar dados)

2. **Função `resolveTorrentFiles(hash: string): TorrentFile[]`**
   - Conecta na DHT/tracker, obtém metadata (file names, sizes)
   - Retorna array: `[{ index: 0, name: "S01E01.mkv", size: 350MB }, ...]`
   - Timeout 30s; se falhar, retorna lista vazia

3. **Parser `parseEpisode(filename: string): { season, episode } | null`**
   - Patterns: `S01E05`, `1x05`, `Season 1 Episode 5`, `Ep 05`, `105`
   - Reutiliza lógica do `parseRelease`

4. **Rota `GET /api/torrent/:hash/files`**
   - Retorna lista de arquivos com `index`, `name`, `size`, `season`, `episode`
   - Cache em `torrent_files` (nova tabela ou JSON column no `torrents`)

5. **Endpoint `GET /catalog/:id/episodes`** — visão composta:
   - Para cada torrent do conteúdo, resolve arquivos (cacheado)
   - Retorna lista plana de episódios: `[{ season, episode, title, magnet, fileIndex, seeds }]`

6. **Verificação:**
   ```bash
   curl /api/torrent/<hash>/files
   # [{"index":0, "name":"The.Vampire.Diaries.S01E01.mkv", "season":1, "episode":1}, ...]
   ```

---

## Card 3 (bônus) — Frontend recebe o contrato

**Não implementar** — só documentar o contrato para o app:

- `GET /catalog` → lista de conteúdos (filmes e séries)
- `GET /catalog/:id` → detalhe + seasons (séries)  
- `GET /catalog/:id/episodes` → lista de episódios com `magnet` + `fileIndex`
- **Frontend:** usa `webtorrent` no browser, abre o magnet, seleciona o arquivo pelo `fileIndex`, faz streaming via `file.streamTo(videoElement)`

---

## Arquivos afetados

| Arquivo | Card |
|---|---|
| `src/types.ts` | 1 — `content_torrents` ganha `season`, `episode`; nova `torrent_files` |
| `src/modules/grouping/merge-series.ts` | 1 — NOVO |
| `src/modules/catalog/routes.ts` | 1 — seasons no detail, episodes endpoint |
| `src/jobs/pipeline.ts` | 1 — hook mergeByTmdbId |
| `src/modules/torrent/resolve-files.ts` | 2 — NOVO |
| `src/modules/torrent/parse-episode.ts` | 2 — NOVO |
| `package.json` | 2 — dep para resolver magnet metadata |

## Riscos

- **Mesclagem errada:** `tmdb_id` bugado → mescla séries diferentes. Mitigação: só mesclar `type='series'` + `tmdb_id` não-nulo + mesmo `type`.
- **DHT lenta:** resolver metadata pode demorar ou falhar para torrents sem peers. Mitigação: timeout 30s + cache agressivo.
- **Frontend:** o app cliente precisa de WebTorrent (pacote `webtorrent` no browser). Isso é responsabilidade do frontend, não do servidor.
