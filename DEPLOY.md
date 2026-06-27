# Deploy — PopcornTime API

**Servidor:** VPS 5.189.130.23  
**Path:** `/root/projetos/popcorntime-api`  
**Domínio:** `popcorntime.fsops.com.br`  
**Serviço:** `systemd` (`popcorntime-api.service`)

## Deploy rápido

```bash
# Na VPS
cd /root/projetos/popcorntime-api && ./deploy.sh
```

Ou via SSH de qualquer lugar:

```bash
ssh root@5.189.130.23 'cd /root/projetos/popcorntime-api && ./deploy.sh'
```

## O que o deploy.sh faz

1. `git pull` — puxa alterações do GitHub
2. `bun install --frozen-lockfile` — instala dependências
3. `systemctl restart popcorntime-api` — reinicia o serviço

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
