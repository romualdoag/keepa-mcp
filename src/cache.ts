/**
 * keepa-mcp cache frio — persiste o cache quente (memória) em SQLite.
 *
 * Padrão extraído do parksapi-mcp (historyCache.ts + KV): dado quente fica
 * em memória com TTL curto; o SQLite frio segura restart do gateway sem
 * rajada de refetch no WebSocket guest do Keepa (frágil, cf. protocol.ts).
 *
 * - KEEPA_CACHE_PATH (default ./keepa-cache.sqlite), KEEPA_CACHE_ENABLED=0 (bypass).
 * - kvGet(): hit só se fresco (TTL 3h p/ recente); kvGetStale(): leitura
 *   infinita p/ range histórico (dado antigo é imutável — o Keepa só anexa).
 * - Fail-soft: qualquer erro de SQLite desliga o cache e segue direto pro
 *   upstream. Cache nunca quebra chamada.
 * - Banco local nunca commitado (*.sqlite* no .gitignore).
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { KEEPA_OFFSET } from "./stats.js";

export function cacheTtlMs(): number {
  return Number(process.env.KEEPA_CACHE_TTL_MS ?? 3 * 3600_000);
}

export function isCacheEnabled(): boolean {
  return process.env.KEEPA_CACHE_ENABLED !== "0";
}

function cacheDbPath(): string {
  return (
    dbPathOverride ??
    process.env.KEEPA_CACHE_PATH ??
    path.join(process.cwd(), "keepa-cache.sqlite")
  );
}

let dbPathOverride: string | undefined;
let db: DatabaseSync | null = null;

/** Test hook: aponta o cache p/ outro arquivo (ou ':memory:') e fecha o atual. */
export function __resetForTests(dbPath = ":memory:"): void {
  closeCache();
  dbPathOverride = dbPath;
}

export function closeCache(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function getDb(): DatabaseSync | null {
  if (!isCacheEnabled()) return null;
  if (db) return db;
  try {
    const opened = new DatabaseSync(cacheDbPath());
    opened.exec("PRAGMA journal_mode=WAL");
    opened.exec("PRAGMA busy_timeout=5000");
    opened.exec(`
      CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
    db = opened;
    return db;
  } catch {
    // Fail-soft: cwd read-only, lock ou schema quebrado nunca quebra a chamada.
    return null;
  }
}

/** Lê do KV se fresco; `undefined` = miss, expirado, desligado ou erro. */
export function kvGet<T>(key: string, ttlMs: number = cacheTtlMs()): T | undefined {
  const row = kvGetRow(key);
  if (!row) return undefined;
  const ageMs = Date.now() - row.fetchedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) return undefined;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return undefined;
  }
}

/** Leitura infinita (sem TTL): p/ range histórico já coberto. */
export function kvGetStale<T>(key: string): { value: T; fetchedAt: number } | undefined {
  const row = kvGetRow(key);
  if (!row) return undefined;
  try {
    return { value: JSON.parse(row.valueJson) as T, fetchedAt: row.fetchedAt };
  } catch {
    return undefined;
  }
}

function kvGetRow(key: string): { valueJson: string; fetchedAt: number } | undefined {
  const store = getDb();
  if (!store) return undefined;
  try {
    const row = store
      .prepare("SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM kv_cache WHERE key = ?")
      .get(key) as { valueJson: string; fetchedAt: number } | undefined;
    return row ?? undefined;
  } catch {
    return undefined;
  }
}

/** Grava no KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  const store = getDb();
  if (!store) return;
  try {
    store
      .prepare("INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  } catch {
    /* fail-soft */
  }
}

/** Apaga uma chave (usado pelo clearCache). Fail-soft. */
export function kvDel(key: string): void {
  const store = getDb();
  if (!store) return;
  try {
    store.prepare("DELETE FROM kv_cache WHERE key = ?").run(key);
  } catch {
    /* fail-soft */
  }
}

/** Apaga tudo do KV (usado pelo clearCache). Fail-soft. */
export function kvClear(): void {
  const store = getDb();
  if (!store) return;
  try {
    store.exec("DELETE FROM kv_cache");
  } catch {
    /* fail-soft */
  }
}

/**
 * Query histórica? O instante `nowMin` (keepa-minutos) cai antes de ontem
 * (UTC): hoje + ontem sempre refazem fetch — o upstream continua anexando
 * pontos a elas — mas dia retrasado p/ trás é imutável, então dado coberto
 * serve infinito sem refetch (cf. parksapi: `to` no passado → full hit).
 * Independente de TTL por construção (TTL só diz se o fresco venceu).
 */
const DAY_MS = 86_400_000;
export function isHistoricQuery(nowMin: number): boolean {
  const now = new Date();
  const todayUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return (nowMin + KEEPA_OFFSET) * 60_000 < todayUTC - DAY_MS;
}
