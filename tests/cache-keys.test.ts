/**
 * keepa-mcp hardening de chaves: normalização + prefixo v1: c/ fallback legado.
 * Cache frio isolado: SQLite em memória, zero vazamento entre testes.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  __resetForTests,
  cacheKey,
  clearMemoryCache,
  getPriceHistory,
  getPriceStats,
} from "../src/service.js";
import { kvGet, kvSet } from "../src/cache.js";
import type { BasicProduct } from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "B0CZ6XY78Y.json"), "utf-8"),
) as { asin: string; domainId: number; csv1_NEW: number[]; csv2_USED: number[] };
// "agora" fixo = server timeStamp da captura (2026-10-16T02:31:44Z)
const NOW = Math.floor(1792117904737 / 60_000) - 21564000;

const fetchFixture = async (asin: string, domainId: number): Promise<BasicProduct> => ({
  asin,
  domainId,
  csv: [null, fixture.csv1_NEW, fixture.csv2_USED] as BasicProduct["csv"],
});

beforeEach(() => {
  __resetForTests(":memory:");
});

describe("cacheKey: normalização", () => {
  it("trim + uppercase no ASIN, Number no domainId", () => {
    expect(cacheKey(" b0cz6xy78y ", 1)).toBe("1-B0CZ6XY78Y");
    expect(cacheKey("B0CZ6XY78Y", 1)).toBe("1-B0CZ6XY78Y");
    expect(cacheKey("B0CZ6XY78Y", "1" as unknown as number)).toBe("1-B0CZ6XY78Y");
  });

  it("getPriceStats dedupa variantes (1 fetch p/ upper/lower c/ espaços)", async () => {
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const s1 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    const s2 = await getPriceStats(" b0cz6xy78y ", 1, counting, NOW);
    expect(calls).toBe(1);
    expect(s2).toBe(s1); // mesmo objeto do quente
  });

  it("getPriceHistory dedupa variantes", async () => {
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const h1 = await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
    const h2 = await getPriceHistory("  b0cz6xy78y", 1, 90, counting, NOW);
    expect(calls).toBe(1);
    expect(h2.points).toEqual(h1.points);
  });
});

describe("chaves v1: c/ fallback legado (migração lazy, fail-soft)", () => {
  it("escritas novas usam prefixo v1:, sem resíduo legado", async () => {
    await getPriceStats("B0CZ6XY78Y", 1, fetchFixture, NOW);
    await getPriceHistory("B0CZ6XY78Y", 1, 90, fetchFixture, NOW);
    expect(kvGet("v1:stats:1-B0CZ6XY78Y")).toBeDefined();
    expect(kvGet("v1:series:1-B0CZ6XY78Y")).toBeDefined();
    expect(kvGet("stats:1-B0CZ6XY78Y")).toBeUndefined();
    expect(kvGet("series:1-B0CZ6XY78Y")).toBeUndefined();
  });

  it("stats legado serve sem refetch e migra p/ v1:", async () => {
    const s1 = await getPriceStats("B0CZ6XY78Y", 1, fetchFixture, NOW);
    __resetForTests(":memory:"); // limpa tudo (simula banco antigo só c/ legada)
    kvSet("stats:1-B0CZ6XY78Y", s1); // semente legada
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const s2 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    expect(calls).toBe(0);
    expect(s2).toEqual(s1);
    expect(kvGet("v1:stats:1-B0CZ6XY78Y")).toEqual(s1); // migrou lazy
  });

  it("series legada serve sem refetch e migra p/ v1:", async () => {
    const h1 = await getPriceHistory("B0CZ6XY78Y", 1, 90, fetchFixture, NOW);
    const pts = kvGet<{ t: number; price: number }[]>("v1:series:1-B0CZ6XY78Y");
    expect(pts).toBeDefined();
    __resetForTests(":memory:");
    kvSet("series:1-B0CZ6XY78Y", pts); // semente legada
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const h2 = await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
    expect(calls).toBe(0);
    expect(h2.points).toEqual(h1.points);
    expect(kvGet("v1:series:1-B0CZ6XY78Y")).toEqual(pts); // migrou lazy
  });

  it("frio v1: sobrevive a restart (L1 limpo, zero refetch)", async () => {
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const s1 = await getPriceStats("b0cz6xy78y ", 1, counting, NOW);
    expect(calls).toBe(1);
    clearMemoryCache(); // simula restart do gateway
    const s2 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    expect(calls).toBe(1);
    expect(s2).toEqual(s1);
  });
});
