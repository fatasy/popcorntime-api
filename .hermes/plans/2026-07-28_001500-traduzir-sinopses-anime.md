# Plano: Traduzir Sinopses de Anime para pt-BR

## Goal

Traduzir gradualmente as sinopses dos 809+ animes do catálogo de inglês para português brasileiro. A coluna `synopsis` (já usada pela API) passará a conter o texto em português; o original em inglês será preservado em `synopsis_raw`.

## Contexto atual

- **809 animes** na tabela `contents`, tipo `anime`
- `synopsis` contém texto em inglês (vindo do Jikan/MyAnimeList via enrichment)
- API expõe `synopsis` diretamente em `/catalog/:id` e `/search`
- Não há coluna de backup para o original

## Estratégia

```
synopsis  (hoje: inglês)  →  passa a ser PORTUGUÊS
synopsis_raw  (nova coluna)  →  guarda o original em inglês
```

Vantagens:
- **Zero mudanças na API** — `synopsis` continua sendo o campo principal, só que agora em pt-BR
- Original preservado em `synopsis_raw` para fallback ou re-tradução futura
- Fluxo simples: copiar → traduzir → gravar

---

## Cards

### Card 1 — Migration: adicionar `synopsis_raw`

Criar `migrations/004_synopsis_raw.sql`:

```sql
ALTER TABLE contents ADD COLUMN IF NOT EXISTS synopsis_raw text;
```

**Validação:** `\d contents` ou `SELECT synopsis_raw FROM contents LIMIT 1`

---

### Card 2 — Script de tradução (`src/jobs/translate-synopses.ts`)

**Fluxo para cada lote (ex.: 50 por execução):**

1. Buscar animes com `synopsis IS NOT NULL AND synopsis_raw IS NULL`
2. Para cada um:
   a. Copiar `synopsis` → `synopsis_raw` (backup do original)
   b. Chamar opencode Go (`deepseek-v4-flash`) com o synopsis em inglês
   c. Prompt:
      ```
      Traduza o texto abaixo para português brasileiro. Preserve nomes próprios e termos específicos (jutsus, técnicas, etc.). Responda apenas a tradução, sem explicações ou formatação extra.

      {synopsis_raw}
      ```
   d. Atualizar `synopsis` com o texto traduzido
3. Delay de ~500ms entre chamadas
4. Log: `[translate] ✓ id=123 "Attack on Titan"`

**Tratamento de erros:**
- Timeout/erro HTTP → loga `✗ id=123 erro`, não quebra o lote
- Se `synopsis_raw` já estiver preenchido, pula (já foi processado)

**Arquivos:**
- `src/jobs/translate-synopses.ts` (novo)

**Validação:**
- `bun run src/jobs/translate-synopses.ts` com `BATCH=3` (teste)
- `SELECT id, title, synopsis, synopsis_raw FROM contents WHERE synopsis_raw IS NOT NULL LIMIT 5;`

---

### Card 3 — API: expor `synopsis_raw`

O select em `routes.ts` já retorna todas as colunas da tabela (`db.select().from(contents)`), então `synopsis_raw` aparece automaticamente nas respostas.

**Verificação:**
- `curl /catalog/277 | python3 -m json.tool` → `synopsis_raw` presente
- `curl '/search?type=anime&q=Naruto'` → `synopsis_raw` presente (null até traduzir)

---

### Card 4 — Cron job periódico

Agendar via `cronjob` do Hermes:

```bash
Schedule: every 2h
Comando: bun run src/jobs/translate-synopses.ts
Workdir: /root/projetos/popcorntime-api
Limite: 50 sinopses por execução
```

- Total: 809 / 50 ≈ **16 execuções** (~32h em intervalo de 2h)
- Quando `synopsis_raw` estiver preenchido em todos, o job não faz mais nada

**Validação:**
- `cronjob list` → job ativo
- Após 2 execuções, contar: `SELECT count(*) FROM contents WHERE synopsis_raw IS NOT NULL;`

---

### Card 5 — Enriquecimento futuro: não sobrescrever `synopsis` traduzida

Quando o pipeline de enrichment rodar para um anime já traduzido, ele não deve substituir `synopsis` pela sinopse em inglês.

**Mudança em `src/modules/enrichment/index.ts`:**

- Em `applyUpdate()` (linha 180): se `synopsis_raw` já está preenchido (conteúdo traduzido), o update de `synopsis` vai na verdade para `synopsis_raw`:
  ```ts
  if (update.synopsis && synopsisRawExists) {
    update.synopsis_raw = update.synopsis
    delete update.synopsis
  }
  ```
  Ou, mais simples: o enricher sempre escreve em `synopsis_raw` quando o conteúdo já foi traduzido.

**Detalhe:** verificar se `synopsis_raw` está preenchido → se sim, redirecionar escrita de `synopsis` para `synopsis_raw`.

---

## Cronograma

| Card | Descrição | Estimativa |
|------|-----------|------------|
| 1 | Migration `synopsis_raw` | ~20min |
| 2 | Script de tradução | ~2h |
| 3 | Verificação API | ~10min |
| 4 | Cron job | ~20min |
| 5 | Proteção no enrichment | ~30min |

**Total:** ~3h20min de implementação + tradução distribuída ao longo de ~32h via cron.

## Riscos e tradeoffs

- **Custo:** ~800 chamadas deepseek-v4-flash — centavos de dólar
- **Qualidade:** Tradução automática pode errar nomes próprios; o prompt orienta a preservá-los
- **Re-enriquecimento:** Card 5 precisa ser implementado para evitar que o pipeline sobrescreva a tradução com o inglês original
