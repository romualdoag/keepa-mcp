# keepa-mcp

"O preço atual está bom ou não?" — MCP server que analisa preço de produto
Amazon a partir do histórico Keepa (protocolo WebSocket do `keepaBox.html`,
mapeado por engenharia reversa — ver `../keepa-rev/docs/PROTOCOL.md`).

Uso estritamente pessoal, baixo volume (1 produto por consulta, cache 3h).
Sem API paga do Keepa. Se o Keepa exigir verificação humana (Turnstile),
as tools falham com erro claro — **sem evasão**.

## Tools

| tool | o que faz |
|---|---|
| `analyze_amazon_price(url)` | aceita link Amazon (`amazon.*`, `amzn.to`, `a.co`) → veredito `OTIMO`/`BOM`/`NEUTRO`/`RUIM`/`SEM_VEREDITO` + estatísticas |
| `get_price_stats(asin, domain)` | só os números (menor/atual/maior c/ datas ISO, médias 30/90/180d, quedas/mês, janelas 90/180/365d, atual Usado/Amazon) |
| `get_price_history(asin, domain, days)` | série `[{date, price}]` do Novo p/ plotagem (`days=0` = tudo) |

`domain`: 1=com, 2=co.uk, 3=de, 4=fr, 5=co.jp, 6=ca, 8=it, 9=es, 10=in, 11=mx, 12=br.

## Instalação

```bash
cd ~/github/keepa-mcp
npm install
npm run build
npm test   # 22 testes (matemática validada contra o quadro Keepa real)
```

## Uso com Claude Code

```bash
claude mcp add keepa-mcp -- node /home/hermes/github/keepa-mcp/dist/index.js
```

## Configuração (env, tudo opcional)

| var | padrão | efeito |
|---|---|---|
| `KEEPA_CACHE_TTL_MS` | `10800000` (3h) | cache por ASIN |
| `KEEPA_TIMEOUT_MS` | `60000` | timeout da consulta WS |
| `KEEPA_PROXY` | (vazio) | proxy `http(s)://[user:pass@]host:porta` p/ WS e resolve de links curtos (ex. residencial; tem prioridade sobre `HTTPS_PROXY`/`HTTP_PROXY`) |
| `KEEPA_VERSION` | `20261014` | build do keepa.js (atualize se o protocolo mudar) |
| `KEEPA_OTIMO_ACIMA_MENOR` | `0.03` | ÓTIMO: atual ≤ menor +3% e abaixo da média 90d |
| `KEEPA_BOM_DESCONTO_MEDIA` | `0.05` | BOM: atual ≤ média90 −5% ou posição <25% |
| `KEEPA_NEUTRO_BANDA` | `0.05` | NEUTRO dentro de ±5% da média 90d |
| `KEEPA_RUIM_POSICAO` | `0.6` | RUIM: posição na faixa >60% (ou > média +5%) |
| `KEEPA_BOM_POSICAO` | `0.25` | BOM por posição na faixa |
| `KEEPA_DROPS_ALTO` / `KEEPA_DROPS_BAIXO` | `2` / `1` | notas de volatilidade (quedas/mês) |
| `KEEPA_STALE_DIAS` | `30` | avisa se o dado atual é mais velho que isso |

## Rede bloqueada? (checkHuman)

O modo guest funciona de redes residenciais/navegador comum. De IPs de
datacenter o Keepa responde `checkHuman` no request `product` — a tool retorna
erro explícito. Opções legítimas:

1. Rodar o MCP numa máquina/rede residencial (mesmo código, sem mudança).
2. Validar a matemática offline: `npm test` usa fixture real do HAR
   (`fixtures/B0CZ6XY78Y.json`) e confere o quadro até o centavo.
3. Não usar solvers de captcha, stealth plugins ou rotação de IP para forçar —
   é evasão de proteção anti-bot e está fora do escopo do projeto.

## Como detectar quebra do protocolo

`tests/live.test.ts` é o teste de contrato: busca `B0CZ6XY78Y` ao vivo e
confere as âncoras (menor ≤ 118.99, maior ≥ 179.00). Sinais de quebra:
status ≠ 200/108, magic novo nos frames, `basicProducts` vazio, stride novo
no `csv`. Ajuste `KEEPA_VERSION` e revise `PROTOCOL.md` §8.

## Stack (por que TypeScript)

Mesma dos outros MCPs da casa (`space-launch-mcp`, `apple-stock-mcp`):
`@modelcontextprotocol/sdk` + `zod` + `vitest`, `service.ts` com lógica pura
testável. Decode zstd via `fzstd` (o mesmo decoder que o keepa.js embarca).
