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

## Tradução de legendas

O backend traduz lotes de até 72 falas (12.000 caracteres incluindo a margem de
JSON), com até 4 chamadas simultâneas compartilhadas entre os jobs de legendas. Envia
duas falas anteriores e duas posteriores como contexto e remonta o VTT pelos
IDs originais, mantendo ordem, tempos, identificadores e metadados.

| Variável | Padrão | Limite |
| --- | --- | --- |
| `OPENCODE_GO_API_KEY` | Chave do ambiente ou `~/.hermes/.env` | Obrigatória para traduzir |
| `OPENCODE_GO_SUBTITLE_MODEL` | `deepseek-v4-flash` | Modelo disponível no OpenCode Go |
| `OPENCODE_GO_SUBTITLE_CONCURRENCY` | `4` | De 1 a 8 chamadas simultâneas no total |
| `OPENCODE_GO_SUBTITLE_BATCH_CUES` | `72` | De 1 a 120 falas por lote |

Valores numéricos inválidos usam o padrão; valores acima do máximo são limitados.
As configurações são lidas ao iniciar a API. Para DeepSeek, o payload envia
`reasoning_effort: "none"`, verificado no endpoint do OpenCode Go, para evitar a
geração de raciocínio antes da tradução. O campo específico desse gateway também
é descrito nesta [investigação do OpenCode](https://github.com/anomalyco/opencode/pull/46181).

Cada chamada tem timeout de 60 segundos e até três tentativas. Respostas
incompletas são reparadas pedindo somente as falas ausentes, com o lote original
como contexto. Erros temporários e HTTP 429 têm espera entre tentativas e
respeitam `Retry-After`; erros de autenticação/configuração e cooldowns acima de
30 segundos encerram o job imediatamente. Se um lote falhar definitivamente, as
outras chamadas daquele job são canceladas antes de liberar os limites de jobs.

Os logs `[subtitle-translation]` registram duração, quantidade de falas, tentativa
e tamanho do raciocínio de cada resposta, além do tempo de download e tempo total
do job. As traduções completas continuam salvas em `local-subtitles` para reuso.

Testes de concorrência, contexto, ordenação, integridade do VTT, reparo parcial,
rate limits, cancelamento e timeout:

```bash
bun test src/modules/subtitles/translation-engine.test.ts
```

### Medição no provedor

Comparação direta no endpoint real do OpenCode Go, com `deepseek-v4-flash` e a
mesma amostra sintética de 432 falas em inglês (36 diálogos repetidos 12 vezes):

| Fluxo | Chamadas | Tempo de tradução |
| --- | --- | --- |
| Anterior: 36 falas, sequencial, raciocínio padrão | 12 | 253,2 s (4min13s) |
| Atual: 72 falas, até 4 em paralelo, raciocínio desligado | 6 | 13,9 s |

O ganho observado foi de aproximadamente 18 vezes. Todas as chamadas concluíram
na primeira tentativa e os timestamps da saída foram comparados com os da
entrada. O fluxo atual retornou zero caracteres de raciocínio em todos os lotes;
o anterior chegou a gerar 51.189 caracteres de raciocínio em uma única chamada.
Essa medição cobre a tradução da amostra em memória, sem download, gravação ou
polling do app; não representa uma garantia de tempo para qualquer episódio.
