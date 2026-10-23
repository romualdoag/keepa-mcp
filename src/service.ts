/**
 * keepa-mcp service — lógica pura por trás das tools MCP.
 * Fonte de dados injetável (live WS por padrão; fixtures nos testes).
 */
import {
  CSV,
  SeriesStats,
  computeStats,
  configFromEnv,
  history,
  nowKeepaMin,
  parseSeries,
  verdict,
  VerdictConfig,
  keepaToISODate,
} from "./stats.js";
import {
  BasicProduct,
  KeepaBlockedError,
  fetchProductLive,
  proxyUrl,
} from "./protocol.js";
import { ProxyAgent } from "undici";
import {
  __resetForTests as __resetColdForTests,
  cacheTtlMs,
  isHistoricQuery,
  kvClear,
  kvGet,
  kvGetStale,
  kvSet,
} from "./cache.js";

/** amazon.<tld> → domainId Keepa */
const DOMAIN_BY_TLD: Record<string, number> = {
  "com": 1,
  "co.uk": 2,
  "de": 3,
  "fr": 4,
  "co.jp": 5,
  "ca": 6,
  "it": 8,
  "es": 9,
  "in": 10,
  "mx": 11,
  "com.br": 12,
  "br": 12,
};

const ASIN_RE = /\/dp\/([A-Z0-9]{10})(?:[/?]|$)|\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)|\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i;

export interface ResolvedProduct {
  asin: string;
  domainId: number;
}

export async function resolveAmazonUrl(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<ResolvedProduct> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // links curtos: segue redirect e usa a URL final (via proxy, se configurado)
  if (host === "amzn.to" || host === "a.co") {
    const proxy = fetchFn === fetch ? proxyUrl() : undefined;
    const init = (
      proxy
        ? { redirect: "follow", dispatcher: new ProxyAgent(proxy) }
        : { redirect: "follow" }
    ) as RequestInit;
    const r = await fetchFn(url, init);
    const final = r.url;
    try {
      (r as { cancel?: () => void }).cancel?.();
    } catch {
      /* noop */
    }
    u = new URL(final);
  }
  const m = u.hostname.match(/(?:^|\.)amazon\.([a-z.]+)$/i);
  if (!m) throw new Error(`não é URL da Amazon: ${input}`);
  const tld = m[1].toLowerCase();
  const domainId = DOMAIN_BY_TLD[tld];
  if (!domainId) throw new Error(`domínio Amazon não suportado: ${tld}`);
  const am =
    u.pathname.match(ASIN_RE) ??
    u.search.match(/ASIN=([A-Z0-9]{10})/i);
  const asin = am?.[1] ?? am?.[2] ?? am?.[3];
  if (!asin) throw new Error(`ASIN não encontrado na URL: ${input}`);
  return { asin: asin.toUpperCase(), domainId };
}

export type FetchProduct = (
  asin: string,
  domainId: number,
) => Promise<BasicProduct>;

export interface StatsResult {
  asin: string;
  domainId: number;
  title?: string;
  fetchedAt: string;
  nowKeepa: number;
  novo: SeriesStats;
  usadoAtual: { val: number; date: string } | -1 | null;
  amazonAtual: { val: number; date: string } | -1 | null;
}

export interface CacheEntry {
  at: number;
  data: StatsResult;
}

const cache = new Map<string, CacheEntry>();
const seriesCache = new Map<
  string,
  { at: number; data: { t: number; price: number }[] }
>();

/** Chaves do KV frio (espelham o cache quente em memória). */
const statsKey = (asin: string, domainId: number): string =>
  `stats:${cacheKey(asin, domainId)}`;
const seriesKey = (asin: string, domainId: number): string =>
  `series:${cacheKey(asin, domainId)}`;

export function cacheKey(asin: string, domainId: number): string {
  return `${domainId}-${asin}`;
}

/** Limpa quente (memória) + frio (SQLite). */
export function clearCache(): void {
  clearMemoryCache();
  kvClear();
}

/** Limpa só a memória — simula restart do gateway (o SQLite frio sobrevive). */
export function clearMemoryCache(): void {
  cache.clear();
  seriesCache.clear();
}

/** Test hook: zera tudo e aponta o SQLite p/ outro arquivo (ou ':memory:'). */
export function __resetForTests(dbPath = ":memory:"): void {
  clearMemoryCache();
  __resetColdForTests(dbPath);
}

export async function getPriceStats(
  asin: string,
  domainId: number,
  fetchProduct: FetchProduct = fetchProductLive,
  nowMin: number = nowKeepaMin(),
): Promise<StatsResult> {
  const ttlMs = cacheTtlMs();
  const key = cacheKey(asin, domainId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const cold = kvGet<StatsResult>(statsKey(asin, domainId), ttlMs);
  if (cold) {
    cache.set(key, { at: Date.now(), data: cold });
    return cold;
  }
  // Range histórico já coberto serve infinito: o Keepa só anexa pontos novos.
  // (Sem requentar o L1: dado expirado não deve mascarar o TTL do recente.)
  const stale = kvGetStale<StatsResult>(statsKey(asin, domainId));
  if (stale && isHistoricQuery(nowMin)) return stale.value;

  const bp = await fetchProduct(asin, domainId);
  const novoPts = parseSeries(bp.csv?.[CSV.NEW]);
  const novo = computeStats(novoPts, nowMin);
  if (!novo)
    throw new Error(
      `produto ${asin} sem série Novo (fora de linha ou productType restrito)`,
    );
  // sem estoque agora? último ponto da série bruta
  const raw = bp.csv?.[CSV.NEW];
  if (raw && raw.length >= 2 && Number(raw[raw.length - 1]) < 0) {
    novo.inStock = false;
    novo.current = { val: -1, date: keepaToISODate(Number(raw[raw.length - 2])) };
  }

  const lastOf = (
    idx: number,
  ): { val: number; date: string } | -1 | null => {
    const s = bp.csv?.[idx];
    if (!s || s.length < 2) return null;
    const v = Number(s[s.length - 1]);
    if (v < 0) return -1;
    return { val: v / 100, date: keepaToISODate(Number(s[s.length - 2])) };
  };

  const out: StatsResult = {
    asin: bp.asin ?? asin,
    domainId: bp.domainId ?? domainId,
    title: typeof bp.title === "string" ? bp.title : undefined,
    fetchedAt: new Date().toISOString(),
    nowKeepa: nowMin,
    novo,
    usadoAtual: lastOf(CSV.USED),
    amazonAtual: lastOf(CSV.AMAZON),
  };
  cache.set(key, { at: Date.now(), data: out });
  kvSet(statsKey(asin, domainId), out);
  // O fetch já trouxe a série completa: alimenta o cache da history de graça.
  seriesCache.set(`csv:${key}`, { at: Date.now(), data: novoPts });
  kvSet(seriesKey(asin, domainId), novoPts);
  return out;
}

export interface AnalyzeResult extends StatsResult {
  analysis: ReturnType<typeof verdict>;
}

export async function analyzeAmazonPrice(
  url: string,
  fetchProduct: FetchProduct = fetchProductLive,
  cfg: VerdictConfig = configFromEnv(),
  nowMin: number = nowKeepaMin(),
): Promise<AnalyzeResult> {
  const { asin, domainId } = await resolveAmazonUrl(url);
  const stats = await getPriceStats(asin, domainId, fetchProduct, nowMin);
  return { ...stats, analysis: verdict(stats.novo, nowMin, cfg) };
}

export async function getPriceHistory(
  asin: string,
  domainId: number,
  days: number,
  fetchProduct: FetchProduct = fetchProductLive,
  nowMin: number = nowKeepaMin(),
): Promise<{
  asin: string;
  domainId: number;
  days: number;
  points: Array<{ date: string; price: number }>;
}> {
  const ttlMs = cacheTtlMs();
  const key = `csv:${cacheKey(asin, domainId)}`;
  let pts: { t: number; price: number }[];
  const hit = seriesCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    pts = hit.data;
  } else {
    const cold = kvGet<{ t: number; price: number }[]>(
      seriesKey(asin, domainId),
      ttlMs,
    );
    if (cold) {
      pts = cold;
      seriesCache.set(key, { at: Date.now(), data: pts });
    } else {
      // Range histórico já coberto serve infinito (série antiga é imutável).
      // (Sem requentar o L1: dado expirado não deve mascarar o TTL do recente.)
      const stale = kvGetStale<{ t: number; price: number }[]>(
        seriesKey(asin, domainId),
      );
      if (stale && isHistoricQuery(nowMin)) {
        pts = stale.value;
      } else {
        const bp = await fetchProduct(asin, domainId);
        pts = parseSeries(bp.csv?.[CSV.NEW]);
        seriesCache.set(key, { at: Date.now(), data: pts });
        kvSet(seriesKey(asin, domainId), pts);
      }
    }
  }
  return { asin, domainId, days, points: history(pts, nowMin, days) };
}

export { KeepaBlockedError };
