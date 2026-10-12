# popcorntime-api

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Fontes HTTP de anime

Provedores: **AnimesDigital**, por scraping das páginas públicas, e **AnimeFire**,
pela API pública, com opções dubladas e legendadas. Use os botões de atualizar fontes do
título ou do episódio para coletar as referências. O casamento usa os títulos da
temporada/parte do MAL, sem misturar a obra com sequelas de nome semelhante.

`http_streams` guarda somente a referência da página, metadados e a URL direta
quando resolvida. `GET /streams/:id/resolve` consulta novamente o HTML ou JSON, atualiza a URL
e devolve JSON ao app; o player consome a CDN diretamente. A API não baixa nem
hospeda vídeos, manifestos HLS ou segmentos, e não faz proxy de mídia.
Fontes que só oferecem um player sem URL direta retornam erro explícito.
Os provedores são consultados independentemente: uma falha gera `sourceWarnings`
e preserva as referências encontradas nas outras fontes.

A AnimeFire agrupa temporadas; a integração preserva os números locais e os
offsets das partes do MAL. Cada áudio tem uma referência própria, e a resolução
retorna `mimeType` para reconhecer seus links HLS com extensão `.jpg`.
Alguns links antigos podem estar indisponíveis apesar do catálogo publicado.
A CDN da AnimeFire atualmente permite CORS somente para o próprio site;
esta fonte destina-se aos players nativos, e pode falhar na versão web.

Antes de iniciar esta versão, aplique `migrations/010_http_streams.sql` ao banco.
O script é idempotente e também adiciona os campos HTTP ao progresso dos perfis.
Recompile o app: Android TV precisa da dependência Media3 HLS; o navegador usa
HLS.js com buffer em memória e requisições `no-store`, e Windows usa mpv com
cache em disco desativado. A escolha de fonte e a retomada usam o ID estável da
referência, permitindo renovar URLs temporárias.

```bash
bun test src/modules/streams
# Verifica HTML/JSON + HEAD, sem baixar o vídeo:
bun scripts/check-http-sources.ts "Spy x Family" 1
bun scripts/check-http-sources.ts "Overgeared" 3 animefire
```
