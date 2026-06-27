# PopcornTime Catalog API — Documentação para LLM

**Base URL:** `https://popcorntime.fsops.com.br`  
**Formato:** JSON  
**Autenticação:** Nenhuma (API pública)  
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
          "torrents": [
            {
              "hash": "6ea2ed05...",
              "magnet_link": "magnet:?xt=urn:btih:6ea2...",
              "title": "The Vampire Diaries Season 1 2 3 4 5 6 7 8 - threesixtyp",
              "seeds": 45,
              "file_index": 0,
              "inferred": false
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

### 4. `GET /search` — Buscar por título

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

### 5. `GET /health` — Health check

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
  file_index: number | null     // índice estimado do arquivo dentro do torrent
  inferred: boolean             // true se o mapeamento é estimado/heurístico
}
```

---

## Fluxo típico do frontend

### Tela inicial — Catálogo
```
GET /catalog?sort=popular&enriched=true&limit=20
→ Mostra grid de posters com título, rating, tipo
→ Paginação: ?page=2
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
