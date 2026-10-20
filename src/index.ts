#!/usr/bin/env node
/**
 * keepa-mcp — "o preço atual está bom ou não?" para produtos Amazon,
 * via protocolo WebSocket do Keepa (engenharia reversa, uso pessoal).
 *
 * Tools:
 * - analyze_amazon_price(url): veredito + estatísticas (resolve amzn.to/a.co).
 * - get_price_stats(asin, domain): só os números, datas ISO.
 * - get_price_history(asin, domain, days): série temporal p/ plotagem.
 *
 * Nunca inventa números: sem dados → erro explícito. Cache por ASIN (TTL).
 * Se o Keepa exigir checkHuman, a tool falha com mensagem clara (sem evasão).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeAmazonPrice,
  getPriceHistory,
  getPriceStats,
} from "./service.js";
import { configFromEnv } from "./stats.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = require("../package.json").version ?? "0.0.0";

const server = new McpServer({ name: "keepa-mcp", version: PKG_VERSION });

type TextResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function asText(obj: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function asError(err: unknown): TextResult {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[keepa-mcp] tool error: ${msg}`);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

server.registerTool(
  "analyze_amazon_price",
  {
    title: "Analisar preço Amazon",
    description:
      "Dado um link de produto da Amazon (aceita amzn.to/a.co), retorna " +
      "se o preço atual Novo está bom ou não (OTIMO/BOM/NEUTRO/RUIM/SEM_VEREDITO) " +
      "com menor/atual/maior, médias 90/180d e quedas por mês.",
    inputSchema: { url: z.string().describe("link do produto na Amazon") },
  },
  async ({ url }): Promise<TextResult> => {
    try {
      return asText(await analyzeAmazonPrice(url, undefined, configFromEnv()));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_price_stats",
  {
    title: "Estatísticas de preço",
    description:
      "Só os números do histórico Novo: menor/atual/maior (com datas ISO), " +
      "médias 30/90/180d, quedas por mês, janelas 90/180/365d e preço atual " +
      "Usado/Amazon quando houver.",
    inputSchema: {
      asin: z.string().describe("ASIN de 10 caracteres"),
      domain: z
        .number()
        .int()
        .default(1)
        .describe("1=com, 2=co.uk, 3=de, 4=fr, 5=co.jp, 6=ca, 8=it, 9=es, 10=in, 11=mx, 12=br"),
    },
  },
  async ({ asin, domain }): Promise<TextResult> => {
    try {
      return asText(await getPriceStats(asin, domain));
    } catch (e) {
      return asError(e);
    }
  },
);

server.registerTool(
  "get_price_history",
  {
    title: "Série temporal de preço",
    description:
      "Série [{date, price}] do preço Novo nos últimos N dias (days=0 volta tudo), " +
      "pronta para plotagem.",
    inputSchema: {
      asin: z.string().describe("ASIN de 10 caracteres"),
      domain: z.number().int().default(1).describe("domainId Keepa (1=com … 12=br)"),
      days: z.number().int().default(180).describe("janela em dias (0 = histórico todo)"),
    },
  },
  async ({ asin, domain, days }): Promise<TextResult> => {
    try {
      return asText(await getPriceHistory(asin, domain, days));
    } catch (e) {
      return asError(e);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(`[keepa-mcp] fatal: ${String(e)}`);
  process.exit(1);
});
