# Deploy — PopcornTime API

**Servidor:** VPS 5.189.130.23  
**Path:** `/root/projetos/popcorntime-api`  
**Domínio:** `popcorntime.fsops.com.br`  
**Serviço:** `systemd` (`popcorntime-api.service`)

Neste PC, use o alias SSH `hermes`: ele configura o usuário `root` e a chave
`~/.ssh/main-key`. A conexão pelo IP diretamente não aplica a configuração desse
alias. Para usar o IP no PowerShell, informe a chave explicitamente:

```powershell
ssh -i "$env:USERPROFILE\.ssh\main-key" -o IdentitiesOnly=yes root@5.189.130.23
```

## Fluxo de deploy (PC → GitHub → VPS)

O código fonte fica no seu PC Windows (`C:\Users\MarceloV2\Code\chq\popcorntime-api`). O deploy segue 3 passos:

### 1. Do PC: commit + push

```powershell
# No Windows (PowerShell)
cd C:\Users\MarceloV2\Code\chq\popcorntime-api
git add -A
git commit -m "descrição das alterações"
git push
```

### 2. Da VPS: pull + restart

```powershell
# Ainda no Windows, via SSH
ssh hermes "cd /root/projetos/popcorntime-api && ./deploy.sh"
```

Ou em 1 linha só (commit + push + deploy):

```powershell
cd C:\Users\MarceloV2\Code\chq\popcorntime-api && git add -A && git commit -m "update" && git push && ssh hermes "cd /root/projetos/popcorntime-api && ./deploy.sh"
```

### 3. Verificar

```powershell
ssh hermes "systemctl status popcorntime-api --no-pager"
```

Ou acessar: `https://popcorntime.fsops.com.br/catalog?type=movies`

## O que o deploy.sh faz

1. `git pull` — puxa alterações do GitHub
2. `bun install --frozen-lockfile` — instala dependências
3. `systemctl restart popcorntime-api` — reinicia o serviço (hot-reload, sem downtime)

## Migração do cache de metainfo

Antes do primeiro deploy da pré-resolução de torrents:

```bash
cd /root/projetos/popcorntime-api
set -a && source .env && set +a
psql "$DATABASE_URL" -f migrations/004_synopsis_raw.sql
psql "$DATABASE_URL" -f migrations/005_torrent_metainfo.sql
```

A migração é idempotente e pode ser executada novamente sem apagar metadados já resolvidos.

## Comandos úteis

```bash
# Status do serviço
systemctl status popcorntime-api

# Logs
journalctl -u popcorntime-api -f

# Rodar pipeline manualmente
cd /root/projetos/popcorntime-api && bun run src/jobs/pipeline.ts

# Ver última execução do cron
systemctl status cron && grep popcorntime /var/log/syslog | tail -5
```

## Pipeline automático

O pipeline roda a cada **6 horas** via cron:

```cron
0 */6 * * * cd /root/projetos/popcorntime-api && /root/.bun/bin/bun run src/jobs/pipeline.ts >> /var/log/popcorntime-pipeline.log 2>&1
```

## Fontes HTTP de anime

Antes de publicar esta versão, aplique a migração adicional no banco com
`DATABASE_URL` configurada no `.env` da API. O runner Bun executa a migração
em uma transação e limita o tempo de espera por locks:

```bash
bun scripts/migrate-http-streams.ts
```

Publique a API depois da migração e reconstrua o app para incluir o módulo HLS
na Android TV e as opções atualizadas do mpv. A coleta HTTP é acionada pelos
botões de atualizar fontes; o pipeline periódico atual continua com seus jobs
existentes. A validação opcional `bun scripts/check-http-sources.ts` lê páginas
HTML/JSON e cabeçalhos HEAD, sem baixar vídeos. Também é possível verificar
somente a AnimeFire com `bun scripts/check-http-sources.ts "Overgeared" 3 animefire`.

Na validação desta VPS em 12/10/2026 (UTC), os links dublado e legendado da
AnimesDigital foram resolvidos no servidor e responderam HTTP 200 no cliente.
A API pública da AnimeFire respondeu HTTP 403 com bloqueio do Cloudflare para
a VPS. A integração permanece cadastrada, mas sua coleta/resolução nesta VPS
depende de o provedor permitir esse acesso. O erro aparece em `sourceWarnings`
sem impedir a coleta da AnimesDigital.

A fonte `animesonline` (AnimesOnline.cloud) usa a mesma tabela `http_streams`,
sem migração adicional. Valide busca, coleta e resolução com
`bun scripts/check-http-sources.ts "Sword Art Online" 1 animesonline` na VPS.
A resolução verifica apenas os cabeçalhos das CDNs permitidas com HEAD e
seleciona um espelho disponível, sem baixar mídia. O APK Android 1.0.11
acrescenta o nome dessa fonte ao seletor de reprodução.

## Estrutura do projeto

```
/root/projetos/popcorntime-api/
├── src/
│   ├── index.ts              # Servidor Elysia
│   ├── db.ts                 # Conexão Drizzle + Postgres
│   ├── types.ts              # Schema do banco
│   ├── jobs/
│   │   └── pipeline.ts       # Pipeline de ingestão
│   └── modules/
│       ├── catalog/          # Rotas da API
│       ├── collection/       # Coleta de torrents
│       │   ├── sources/      # apibay, eztv, solidtorrents
│       │   ├── gap-detector.ts
│       │   └── fill-gaps.ts
│       ├── enrichment/       # TMDB, OMDb, Jikan
│       │   └── scrape-files.ts
│       ├── grouping/         # Agrupamento por conteúdo
│       ├── episodes/         # Resolução de episódios
│       └── torrent/          # Scraping de file lists
├── deploy.sh                 # Script de deploy
├── API.md                    # Documentação da API
└── .env                      # Variáveis de ambiente
```
