# PopcornTime Catalog API — Documentação para LLM

**Base URL:** `https://popcorntime.fsops.com.br`  
**Formato:** JSON  
**Autenticação:** leitura pública; operações de atualização exigem Bearer token
**Docs Swagger:** `/swagger`

---

## Endpoints

### 1. `GET /catalog` — Listar catálogo

**Query params:**

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `type` | `movie\|series\|anime` | — | Filtrar por tipo |
| `genre` | string | — | Filtrar por gênero (ex: `"Animação"`) |
| `year` | number | — | Filtrar por ano |
| `tmdb_id` | number | — | **Lookup exato** pelo ID do TMDB (use com `type=movie\|series`) |
| `mal_id` | number | — | **Lookup exato** pelo ID do MAL (use com `type=anime`) |
| `sort` | `popular\|rating\|year\|title\|created_at\|updated_at` | `created_at` | Ordenação. `popular` = por seeds |
| `order` | `asc\|desc` | `desc` | Direção da ordenação |
| `enriched` | `"true"\|"1"` | — | Só conteúdo com metadados (poster, sinopse) |
| `page` | number | 1 | Página |
| `limit` | number (max 100) | 20 | Itens por página |

**Response (200):**
```json
{
  "data": [
    {
      "id": 266,
      "type": "anime",
      "title": "Pokémon the Movie: Secrets of the Jungle",
      "original_title": "劇場版ポケットモンスター ココ",
      "year": 2020,
      "synopsis": "Koko cresceu na floresta...",
      "genres": ["Animação", "Aventura", "Fantasia"],
      "rating": "7.5",
      "poster_url": "https://image.tmdb.org/t/p/w500/abc123.jpg",
      "backdrop_url": "https://image.tmdb.org/t/p/w780/def456.jpg",
      "cast_members": ["Rica Matsumoto", "Ikue Ōtani"],
      "director": "Tetsuo Yajima",
      "duration_min": 100,
      "country": "Japan",
      "season": null,
      "episode": null,
      "tmdb_id": 12345,
      "imdb_id": "tt1234567",
      "mal_id": null,
      "enriched_at": "2026-06-26T01:22:49.004Z",
      "created_at": "2026-06-26T01:08:16.678Z",
      "updated_at": "2026-06-26T01:22:49.004Z",
      "primary": {
        "content_id": 266,
        "torrent_id": 272,
        "title": "Pokémon the Movie Secrets of the Jungle 2020",
        "seeds": 120,
        "leechers": 15,
        "size_bytes": 2147483648,
        "magnet_link": "magnet:?xt=urn:btih:abc123...",
        "source": "apibay"
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 273 }
}
```

**Campos podem ser `null` se o conteúdo não foi enriquecido.** Sempre verifique `enriched_at` antes de assumir que metadados existem.

**Lookup por ID externo (clique de um item do `/trending`):** o `/trending`
devolve a lista externa completa (sem filtrar pelo catálogo interno), então o
clique precisa de um lookup exato e barato — sempre com `limit=1`:

```
GET /catalog?type=movie&tmdb_id=1607127&limit=1     # filmes e séries (TMDB)
GET /catalog?type=series&tmdb_id=95350&limit=1
GET /catalog?type=anime&mal_id=60059&limit=1        # anime (Jikan/MAL)
```

Envie o `type` junto: os IDs do TMDB de filme e de série são espaços distintos
(o id 95350 pode existir em ambos). Três resultados possíveis:

| Resposta | Significado | O que o app faz |
|---|---|---|
| `data: [ { ...conteúdo, "primary": {...} } ]` | Registro local **com** fonte primária | Abrir o detalhe/player interno normalmente |
| `data: [ { ...conteúdo, "primary": null } ]` | Registro local existe, mas **sem torrent primário** | Abrir o detalhe interno e sinalizar "sem fonte de reprodução" |
| `data: []` (`meta.total: 0`) | **Sem registro local** | Manter o detalhe externo (título/ano/poster do `/trending`) com estado "sem fonte" |

Este lookup é aditivo: sem `tmdb_id`/`mal_id` o `/catalog` se comporta
exatamente como antes. Ele **não é mais necessário** para a faixa `/trending`
(que já devolve o `id` interno de cada item), mas continua disponível para quando
o app tiver apenas o ID externo em mãos.

---

### 2. `GET /catalog/:id` — Detalhe do conteúdo

**Response (200) — Filme:**
```json
{
  "id": 351,
  "type": "movie",
  "title": "Toy Story 5",
  "year": 2026,
  "synopsis": "O trabalho de Buzz, Woody, Jessie...",
  "genres": ["Animação", "Família", "Comédia"],
  "rating": "7.5",
  "poster_url": "https://image.tmdb.org/t/p/w500/xyz.jpg",
  "cast_members": ["Tom Hanks", "Tim Allen"],
  "director": "Andrew Stanton",
  "duration_min": 95,
  "tmdb_id": 1084244,
  "torrents": [
    {
      "id": 300,
      "hash": "abc123...",
      "title": "Toy.Story.5.2026.1080p.WEB-DL",
      "magnet_link": "magnet:?xt=urn:btih:abc123...",
      "seeds": 250,
      "leechers": 30,
      "size_bytes": 4294967296,
      "source": "apibay",
      "is_primary": true
    }
  ]
}
```

**Response (200) — Série:**
```json
{
  "id": 267,
  "type": "series",
  "title": "Diários de um Vampiro",
  "year": 2009,
  "synopsis": "Quatro meses após o trágico acidente...",
  "genres": ["Drama", "Sci-Fi & Fantasy"],
  "rating": "8.3",
  "poster_url": "https://image.tmdb.org/t/p/w500/vampire.jpg",
  "season_count": 8,
  "seasons": [
    {
      "season": 1,
      "torrents": [
        {
          "hash": "6ea2ed05...",
          "title": "The Vampire Diaries Season 1 2 3 4 5 6 7 8 - threesixtyp",
          "magnet_link": "magnet:?xt=urn:btih:6ea2...",
          "seeds": 45,
          "leechers": 93,
          "is_primary": false,
          "season": 1,
          "episode": null
        }
      ]
    }
  ]
}
```

**Response (404):** `{ "error": "Content not found" }`

---

### 3. `GET /catalog/:id/episodes` — Episódios da série

**Response (200):**
```json
{
  "content": {
    "id": 267,
    "title": "Diários de um Vampiro",
    "type": "series"
  },
  "seasons": [
    {
      "season": 1,
      "episode_count": 22,
      "episodes": [
        {
          "season": 1,
          "episode": 1,
          "title": "Piloto",
          "air_date": "2009-09-10",
          "overview": "A vida de Elena muda depois que Stefan chega à cidade.",
          "still_url": "https://image.tmdb.org/t/p/w300/abc123.jpg",
          "thumbnail_url": "https://image.tmdb.org/t/p/w300/abc123.jpg",
          "image_kind": "still",
          "image_source": "tmdb",
          "image_match": "tmdb",
          "image_credit": "TMDB",
          "image_credit_url": "https://www.themoviedb.org",
          "image_license": null,
          "runtime_sec": 2520,
          "filler": null,
          "recap": null,
          "metadata_source": "tmdb",
          "markers": { "intro": { "start": 12.5, "end": 42 }, "credits": { "start": 1380 }, "runtime_sec": 2520, "source": "mixed" },
          "torrents": [
            {
              "hash": "6ea2ed05...",
              "magnet_link": "magnet:?xt=urn:btih:6ea2...",
              "title": "The Vampire Diaries Season 1 2 3 4 5 6 7 8 - threesixtyp",
              "seeds": 45,
              "file_index": 0,
              "inferred": false,
              "quality": "1080p",
              "size_bytes": 1234567890,
              "collected_at": "2026-09-01T12:00:00.000Z"
            }
          ]
        }
      ]
    }
  ]
}
```

**Como o frontend usa `file_index`:**

```
1. Usuário escolhe S03E05
2. GET /catalog/:id/episodes → encontra season=3, episode=5, file_index=48
3. Abre o magnet_link no WebTorrent (client-side)
4. Seleciona o arquivo de índice 48 dentro do torrent
5. Streama via file.streamTo(videoElement)
```

**Importante:** `file_index` é uma **estimativa** baseada na ordenação típica de arquivos (S01E01=0, S01E02=1...). O frontend deve confirmar a lista real de arquivos via WebTorrent.

**Response (400):** `{ "error": "Content is not a series" }` — chamou episodes em um filme

---

### 4. `POST /catalog/:id/refresh` — Atualizar um título sob demanda

Exige `Authorization: Bearer <accessToken>`.

Body:

```json
{ "scope": "all" }
```

`scope` aceita `all`, `metadata` ou `sources`. Em `all`, a API consulta primeiro
TMDB/Jikan/OMDb, atualiza o catálogo de temporadas e episódios e só então busca
e vincula torrents. Filmes consultam múltiplos índices e retornam todas as fontes
válidas para o seletor; séries/animes informam quantos episódios ainda ficaram sem fonte.

### 5. `GET /search` — Buscar por título

**Query params:** mesmos de `/catalog`, mais:

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `q` | string | **Obrigatório.** Termo de busca (case-insensitive) |

**Response (200):** mesmo envelope de `/catalog`

```json
{
  "data": [...],
  "meta": { "page": 1, "limit": 20, "total": 3 }
}
```

---

### 5. `GET /trending` — Faixa diária "em alta" (ranking externo SINCRONIZADO)

Faixas com a lista **completa do provedor**, na **ordem original do ranking**,
sincronizadas com o catálogo interno **uma vez por dia**. Contrato por faixa:
**`{ title, source, type, data }`** (+ auxiliares). Cada item traz o **id interno**
do registro em `contents` (para abrir `/catalog/:id`) além dos IDs externos.

| `?type` | Fonte da ordem | `title` retornado |
|---|---|---|
| `movie` | TMDB `/trending/movie/day` | `Em alta hoje` |
| `series` | TMDB `/trending/tv/day` | `Em alta hoje` |
| `anime` | Jikan `/top/anime?filter=airing` | `Animes em exibição` |
| `all` (default) | as três acima | — (retorna `groups`) |

> Anime **não tem ranking diário**: o Jikan publica o ranking dos títulos **em
> exibição**. Por isso o título é `Animes em exibição` — não chame de "hoje".

**Query params:** `type` (`movie`|`series`|`anime`|`all`, default `all`; aceita plural) · `limit` (default 10, máx 20)

**Ciclo de atualização (1x/dia, preguiçoso):** no primeiro pedido após 24h o
servidor (1) busca a lista do provedor, (2) casa/cria o registro em `contents`
para cada item e (3) grava a lista **com os ids internos** no cache. Enquanto o
cache vale, nenhuma chamada externa acontece. Se o provedor falhar, o último
ranking válido é servido (`cache.stale: true`) — **já com os ids internos** — e
o app não percebe diferença. A coleta de torrents continua com o pipeline/coletor:
**nada** é coletado dentro do GET.

**Response (200) — `?type=movie`:**

```json
{
  "title": "Em alta hoje",
  "source": "tmdb",
  "type": "movie",
  "data": [
    {
      "rank": 1,
      "id": 4186,
      "type": "movie",
      "source": "tmdb",
      "tmdb_id": 1607127,
      "mal_id": null,
      "title": "O Último Tiro Certo",
      "original_title": "One Last Shot",
      "year": 2026,
      "release_date": "2026-09-22",
      "poster_url": "https://image.tmdb.org/t/p/w500/owdiTFWuWq4UxPth6nXNsO6x74Q.jpg",
      "backdrop_url": "https://image.tmdb.org/t/p/w780/8giIQcHpxgsPVP6c7aQtHl3txuh.jpg",
      "overview": "Sinopse em pt-BR vinda do TMDB...",
      "rating": 8.375,
      "source_url": "https://www.themoviedb.org/movie/1607127",
      "primary": null
    }
  ],
  "source_list": "trending/movie/day",
  "source_url": "https://www.themoviedb.org",
  "ranking_window": "day",
  "available": true,
  "error": null,
  "notice": "Lista sincronizada com o catálogo interno: use `id` para abrir /catalog/:id. `primary: null` = ainda sem fonte de reprodução (o pipeline de torrents preenche depois) — não oculte o item, mostre o estado \"sem fonte\".",
  "limit": 10,
  "total": 10,
  "provider_total": 39,
  "cache": { "hit": true, "stale": false, "age_seconds": 43200, "ttl_seconds": 86400, "fetched_at": "2026-09-22T03:00:00.000Z" },
  "generated_at": "2026-09-22T15:00:00.000Z"
}
```

Com `?type=all` (ou sem `type`): `{ "generated_at": ..., "limit": 10, "groups": [ {...movie}, {...series}, {...anime} ] }`.

**Regras do contrato:**

1. `data` é a lista do provedor cortada apenas pelo `limit`, **na ordem do
   ranking**; `rank` é a posição original (1 = primeiro). Nada é removido por não
   ter torrent ou vínculo prévio — as posições são contínuas (1..N).
2. `id` = **id interno** em `contents` (use em `/catalog/:id`). `null` apenas se
   a sincronização daquele item falhou (ex.: banco indisponível) — o item
   continua na lista com os metadados externos.
3. `primary` = torrent primário **atual** (mesmo shape do `/catalog`:
   `torrent_id`, `title`, `seeds`, `leechers`, `size_bytes`, `magnet_link`,
   `source`, `quality`). `primary: null` = **sem fonte de reprodução ainda**:
   mantenha o item, abra o detalhe e mostre o estado "sem fonte". O coletor de
   torrents preenche isso depois (o GET não coleta nada).
4. `tmdb_id` (filmes/séries) e `mal_id` (anime) são os IDs EXTERNOS; `poster_url`,
   `backdrop_url`, `overview`, `rating`, `year`, `release_date` vêm do provedor.
5. `notice` documenta a limitação acima (item sem fonte continua na lista).
6. `cache.ttl_seconds = 86400` (1 dia); `cache.hit: true` = servido do cache
   persistido; `cache.stale: true` = o refresh falhou e estamos servindo o
   ranking anterior (com os ids internos). Após falha, o servidor re-tenta em 5 min.
7. `available: false` (+ `error`) = provedor indisponível e **nenhum** ranking
   anterior persistido: oculte a faixa.
8. **Use o `title` da resposta** — não codifique nome de faixa no app.

**O que a sincronização faz (por item, sem duplicar):**

| Passo | Critério | Ação |
|---|---|---|
| 1 | `type` + ID externo (`tmdb_id`/`mal_id`) já existe | Completa os metadados do registro (título, ano, IDs, poster/backdrop, `rating`; `synopsis` só se estiver vazia) |
| 2 | `type` + título **exato** + ano, em registro **sem** ID externo | Vincula o ID externo ao registro existente |
| 3 | nenhum dos dois | Cria o registro com `enriched_at = null` (o pipeline completa gênero/elenco/sinopse e o coletor vincula torrents) |

**Response (400):** `{ "error": "Unknown type \"...\". Use movie | series | anime | all" }`

---

### 6. `GET /health` — Health check

**Response (200):** `{ "status": "ok" }`

---

## Tipos de dados

### Content (conteúdo)
```typescript
interface Content {
  id: number
  type: "movie" | "series" | "anime"
  title: string                 // título em pt-BR (do TMDB) ou título do torrent
  original_title: string | null // título original
  year: number | null
  synopsis: string | null       // sinopse em pt-BR
  genres: string[] | null       // ex: ["Animação", "Família"]
  rating: string | null         // ex: "7.5" (0-10, sempre string)
  poster_url: string | null     // URL TMDB (w500)
  backdrop_url: string | null   // URL TMDB (w780)
  cast_members: string[] | null // até 10 atores
  director: string | null
  duration_min: number | null
  country: string | null
  season: number | null         // OBSOLETO para séries, use seasons[]
  episode: number | null        // OBSOLETO para séries
  tmdb_id: number | null
  imdb_id: string | null
  mal_id: number | null         // MyAnimeList ID
  enriched_at: string | null    // ISO timestamp — null = sem metadados
  created_at: string
  updated_at: string
}
```

### Torrent (no detalhe)
```typescript
interface Torrent {
  hash: string                  // info hash
  title: string                 // título original do torrent
  magnet_link: string           // link magnet completo (com trackers)
  seeds: number
  leechers: number
  size_bytes: number            // tamanho em bytes
  source: string                // "apibay" ou "tpb"
  is_primary: boolean           // true = torrent com mais seeds
  season: number | null         // temporada (quando disponível)
  episode: number | null        // episódio (quando disponível)
}
```

### EpisodeTorrent (no endpoint episodes)
```typescript
interface EpisodeTorrent {
  hash: string
  magnet_link: string
  title: string
  seeds: number
  file_index: number | null     // índice REAL do arquivo dentro do torrent
  inferred: boolean             // true se o mapeamento é estimado/heurístico
  quality: string | null
  size_bytes: number | null
  collected_at: string | null
  ptbr_audio: boolean           // título declara áudio PT-BR (dublado / dual PT-BR)
}
```

**Ordem das fontes**: áudio PT-BR primeiro, depois mais seeds (EZTV por último). Vale
para a lista de cada episódio e para `seasons[].torrents` no detalhe. `file_index` vem
do nome dos arquivos (`file_list`) quando disponível — packs não vêm necessariamente em
ordem de episódio — e só cai no índice posicional sem `file_list`.

### Arte por episódio (miniaturas)

Campos aditivos do endpoint de episódios. **`image_kind` é o contrato estável** —
nunca deduza o tipo de arte pela presença de URL:

| Campo | Tipo | Descrição |
|---|---|---|
| `image_kind` | `"still" \| "fallback" \| "none"` | `still` = arte DESTE episódio · `fallback` = poster/backdrop do conteúdo (NÃO é still do episódio) · `none` = sem imagem, usar placeholder local |
| `still_url` | `string \| null` | URL da arte real do episódio (só quando `image_kind = "still"`) |
| `thumbnail_url` | `string \| null` | Pronto para exibir: o still quando existe, senão a arte do conteúdo; `null` quando `image_kind = "none"` |
| `image_source` | `"tmdb" \| "tvmaze" \| "thetvdb" \| null` | Fonte da arte |
| `image_match` | `"tmdb" \| "imdb" \| "thetvdb" \| "title" \| null` | Como a fonte foi vinculada ao conteúdo (auditoria; `title` só ocorre em anime, com guardas estritas de nome/ano/idioma) |
| `image_credit` / `image_credit_url` / `image_license` | `string \| null` | Atribuição exigida pela fonte |

**Regra de UI:** use `thumbnail_url` como miniatura do episódio; quando
`image_kind = "none"` (ou `thumbnail_url = null`) mostre o placeholder local.
Se `image_kind = "still"`, exiba `image_credit` com link para `image_credit_url`
(TVmaze é CC BY-SA; TMDB e TheTVDB também exigem atribuição). Nunca apresente
`image_kind = "fallback"` como se fosse o still do episódio.

Episódios de "pacote" (temporada/episódio `0`, quando a listagem não conseguiu
separar os arquivos) normalmente vêm com `image_kind = "fallback"`.

O metadado é persistido por até 24h na tabela `episode_metadata`. A listagem usa
os dados já salvos, incluindo o último catálogo válido quando seu cache vence,
e renova títulos, artes e marcadores em segundo plano. A falha de Jikan, TMDB,
TVMaze ou AniSkip não impede a resposta com as fontes de reprodução atuais.

As contagens de episódios das temporadas/franquias mantêm os episódios sem
fonte visíveis enquanto os metadados são renovados. Um título TMDB sem nenhum
catálogo salvo tem uma tentativa inicial limitada a 1,2 s; as consultas de
episódios restantes continuam em segundo plano. A atualização explícita via
`POST /catalog/:id/refresh` continua aguardando o catálogo externo quando o
escopo inclui metadados. Renovações simultâneas do mesmo catálogo são unificadas,
com concorrência limitada e espera entre novas tentativas após uma falha.

---

## Fluxo típico do frontend

### Tela inicial — Catálogo
```
GET /catalog?sort=popular&enriched=true&limit=20
→ Mostra grid de posters com título, rating, tipo
→ Paginação: ?page=2
```

### Tela inicial — faixa diária "em alta" (ranking externo sincronizado)
```
GET /trending?type=all&limit=10
→ 3 grupos, cada um { title, source, type, data } com o título vindo da API:
   "Em alta hoje" (filmes), "Em alta hoje" (séries), "Animes em exibição"
→ Ordem = ranking externo (TMDB trending/day; Jikan top airing), lista completa
→ Servidor sincroniza o ranking com o catálogo 1x/dia; nada a fazer no app
→ Card: title, year, poster_url, type
→ Clique: abrir /catalog/<id> (id interno vem no item)
   · primary = {...}  -> há fonte de reprodução
   · primary = null   -> abrir o detalhe e mostrar "sem fonte" (item NÃO sai da faixa)
   · id = null        -> sem registro local: manter o detalhe externo com "sem fonte"
→ Faixa com available=false (ou data vazio) deve ser ocultada
```

### Tela de busca
```
GET /search?q=batman&limit=20
→ Mostra resultados, mesmo formato do catálogo
```

### Tela de detalhe — Filme
```
GET /catalog/351
→ Mostra poster, sinopse, elenco, rating
→ Botão "Assistir": abre magnet_link no WebTorrent
→ file_index = 0 (filmes geralmente têm 1 arquivo)
```

### Tela de detalhe — Série
```
GET /catalog/267
→ Mostra info da série + seletor de temporadas (season_count=8)
→ Usuário escolhe temporada 3
```

### Tela de episódios
```
GET /catalog/267/episodes
→ Lista episódios da S03 (22 episódios)
→ Usuário escolhe S03E05
→ Pega magnet_link + file_index=48
→ Abre no WebTorrent, seleciona arquivo 48, streama
```

---

## Metainfo pré-resolvido

### `GET /torrents/:hash/metainfo`

Retorna o arquivo `.torrent` validado pelo SHA-1 do dicionário `info`.

- **200:** corpo binário com `Content-Type: application/x-bittorrent`
- **304:** o `ETag` enviado pelo cliente ainda é válido
- **400:** info hash inválido
- **404:** metainfo ainda não resolvido; o app deve usar o magnet como fallback

A resposta de sucesso usa `Cache-Control: public, max-age=31536000, immutable`,
pois o conteúdo identificado pelo info hash não muda.

---

## Observações importantes para o frontend

1. **Streaming é client-side:** O backend NÃO serve vídeo. O frontend usa WebTorrent para abrir o `magnet_link` e fazer streaming P2P.

2. **`file_index` é estimativa:** Sempre confirme a lista real de arquivos via WebTorrent antes de usar. Os arquivos de um torrent multi-temporada são numerados sequencialmente (S01E01=0, S01E02=1, ..., S08E16=170).

3. **Conteúdo sem metadados:** `enriched_at === null` significa que não tem poster, sinopse, rating, etc. Use `?enriched=true` para filtrar ou mostre um placeholder.

4. **`rating` é string:** Sempre `"7.5"`, nunca `7.5`. Pode ser `null`.

5. **Torrents multi-temporada:** Um único torrent pode cobrir várias temporadas. O mesmo `magnet_link` aparece em múltiplos episódios com `file_index` diferentes.

6. **Rate limiting:** A API não tem rate limit, mas o pipeline de coleta/enriquecimento atualiza a cada 6 horas. Conteúdo novo pode demorar até 6h para aparecer com metadados.

7. **Cache no frontend:** Os dados mudam a cada ~6h (pipeline). Cache agressivo é recomendado.

---

## Legendas (multi-fonte, foco pt-BR)

O backend agrega legendas de várias fontes (OpenSubtitles + SubDL), normaliza tudo para **UTF-8 WebVTT** (corrige gzip e encoding Latin-1/Windows-1252) e serve um arquivo limpo. A chave de API fica **só no backend**.

### `GET /catalog/:id/subtitles` — listar legendas de um conteúdo

**Query params:**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `season` | number | Temporada (séries) |
| `episode` | number | Episódio (séries) |
| `lang` | string | Idiomas (csv, canônicos). Padrão: `pt-BR,pt-PT,en` |

**Response (200):**
```json
{
  "data": [
    {
      "lang": "pt-BR",
      "langLabel": "Português (Brasil)",
      "release": "The.Movie.2020.1080p.WEB-DL",
      "downloads": 15234,
      "hashMatch": false,
      "hearingImpaired": false,
      "provider": "opensubtitles",
      "url": "https://popcorntime.fsops.com.br/subtitles/file/<token>/s.vtt"
    }
  ],
  "meta": { "count": 1, "languages": ["pt-BR", "pt-PT", "en"] }
}
```

Ranqueado: hash-match → pt-BR → pt-PT → en → mais baixadas. O frontend usa `url` direto no player (já é WebVTT UTF-8).

**Response (503):** `{ "error": "Nenhum provedor de legenda configurado..." }` — falta `OPENSUBTITLES_API_KEY`.

### `GET /subtitles/file/:token/s.vtt` — servir a legenda normalizada

Baixa da fonte, descompacta, converte encoding → UTF-8, converte SRT → WebVTT e serve com `Content-Type: text/vtt`. O `token` vem da resposta acima (não montar à mão).

### Variáveis de ambiente

| Var | Obrigatória | Descrição |
|---|---|---|
| `OPENSUBTITLES_API_KEY` | p/ legendas | Registre grátis em opensubtitles.com → Perfil → API Consumers |
| `OPENSUBTITLES_APP_NAME` | não | User-Agent próprio (default `fpopcorntime v1.0`) |
| `OPENSUBTITLES_USERNAME` / `_PASSWORD` | não | Login eleva a cota de download (5/dia → 20/dia no free) |
| `SUBDL_API_KEY` | não | Fonte secundária (subdl.com/panel/api) |
| `SUBTITLE_LANGS` | não | Idiomas padrão (default `pt-BR,pt-PT,en`) |
| `THETVDB_API_KEY` | não | Arte por episódio de anime via TheTVDB v4 (sem a chave o provedor fica inativo; exige atribuição e licença própria) |


## Fontes HTTP para animes

`GET /streams/providers` lista os provedores HTTP disponíveis: `animesdigital`
(AnimesDigital), `animefire` (AnimeFire) e `animesonline` (AnimesOnline.cloud),
todos com versões `dubbed` (dublado) e `subbed` (legendado).

As rotas existentes `POST /catalog/:id/refresh` e
`POST /catalog/:id/episodes/:season/:episode/refresh` também coletam referências
HTTP de animes. Erros de scraping ou da API de um provedor aparecem em
`sourceWarnings` sem impedir a coleta dos demais ou apagar fontes já cadastradas.

`GET /catalog/:id/episodes` acrescenta `streams` a cada episódio, preservando
o campo `torrents`:

```json
{
  "season": 1,
  "episode": 1,
  "title": "Título do episódio",
  "torrents": [],
  "streams": [{
    "id": 9,
    "provider": "animesdigital",
    "title": "Anime Dublado Episódio 1",
    "season": 1,
    "episode": 1,
    "audio_type": "dubbed",
    "stream_url": null,
    "quality": null,
    "collected_at": "2026-10-11T00:00:00Z"
  }]
}
```

`stream_url` começa nulo e é preenchido na primeira resolução. Antes de cada
reprodução, o app chama `GET /streams/:id/resolve` para obter uma URL atualizada:

```json
{ "id": 9, "url": "https://cdn.example.com/episode/index.m3u8", "quality": null }
```

O campo opcional `mimeType` identifica o formato ao player. A AnimeFire devolve
`"mimeType": "application/vnd.apple.mpegurl"` para seus links HLS com extensão
`.jpg`; a extensão não deve ser usada como única indicação do formato.
As versões de áudio são resolvidas separadamente, sem trocar automaticamente
de dublado para legendado quando uma delas está indisponível. A CDN dessa fonte
restringe CORS ao próprio site, o que pode impedir sua reprodução na versão web.

O AnimesOnline.cloud expõe URLs diretas na página do episódio. Sua resolução
faz apenas HEAD nas CDNs permitidas para selecionar um espelho disponível,
ignorando iframes e respostas HTML. A resposta inclui `mimeType` do MP4/HLS/WebM.
Falha de todos os espelhos retorna 502, preservando o idioma da referência.
Páginas que anunciam os dois áudios não permitem fallback entre eles. Quando o
idioma da referência difere do idioma da página, `page_url` guarda `#audio=dubbed`
ou `#audio=subbed`; o fragmento não é enviado ao site nem à CDN.

Essa resposta é JSON com `Cache-Control: no-store`. O app reproduz `url` direto
na CDN; a API não faz proxy nem download de mídia. IDs inexistentes retornam
404; provedor sem URL direta ou indisponível retorna 502. Qualidade nula indica
que o provedor não informou uma resolução específica; o HLS pode adaptar a
qualidade no player.

O progresso de uma fonte HTTP usa chave estável `http:<id>`, `magnet: ""`,
`fileIndex: -1` e os campos opcionais `streamId`/`streamUrl`. Os registros
existentes de torrents continuam usando os mesmos campos e chaves anteriores.

### Atualização da home e do catálogo

O pipeline agendado a cada 30 minutos renova os rankings vencidos antes de executar coleta e manutenção. O cache de `/trending` vale uma hora; um GET com cache vencido devolve imediatamente a última lista e atualiza em segundo plano. A primeira consulta sem cache espera no máximo 1,2 segundo. `cache.fetched_at` e `cache.stale` informam a idade real da lista.

Quando Jikan falha, a faixa de animes usa a ordem de popularidade do TMDB para animação japonesa com episódios exibidos nos últimos 30 dias. A resposta informa `source: "tmdb"`, `tmdb_id` e `source_list`; essa lista não é apresentada como ranking do MAL. As demais faixas mantêm a ordem do ranking diário do TMDB.

`/catalog?sort=popular` prioriza o ranking persistido atual, inclusive nas categorias e gêneros; seeds continuam como desempate e fallback. `sort=rating` continua ordenando por nota. O pipeline também procura fontes de até seis títulos atuais sem torrents por execução, com intervalo de seis horas por título e sem consultar lançamentos futuros. Enriquecimento usa IDs externos conhecidos diretamente, evitando trocar a identidade da obra pela busca textual.

Para executar apenas a renovação e o enriquecimento, sem a manutenção de torrents: `bun run src/jobs/refresh-home.ts`.

### Xianxia / Wuxia

`GET /catalog?type=anime&genre=Xianxia%20%2F%20Wuxia` lista donghuas chineses da categoria; `type=series` lista produções com atores. Os filtros individuais `genre=Xianxia` e `genre=Wuxia` também são aceitos. A categoria reúne as duas tags confirmadas por keywords do TMDB; fantasia chinesa ou artes marciais, isoladamente, não classificam uma obra.

O job de descoberta sincroniza até duas páginas por tipo de produção a cada seis horas, preservando IDs, traduções e fontes existentes. Também pode ser executado diretamente com `bun run src/jobs/chinese-fantasy.ts --force`. Donghuas usam `type=anime` e mantêm o ID de TV do TMDB para temporadas e episódios.

### Nomes alternativos na busca de fontes de anime

A coleta separa nomes compostos como `My Senior Brother Is Too Steady [Shixiong A Shixiong]`, consulta aliases de TV confirmados pelo TMDB e mantém qualificadores de temporada/parte. Nomes identificados como título da obra literária não são usados como aliases da animação. Resultados do Nyaa passam por comparação do título completo, para não vincular obras com nomes parecidos; pacotes encontrados na busca principal também são aceitos, inclusive intervalos com três dígitos por episódio.
