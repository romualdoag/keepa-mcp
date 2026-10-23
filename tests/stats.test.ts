/**
 * keepa-mcp testes da matemática — fixture real do HAR (B0CZ6XY78Y, csv[1]=Novo).
 * Números-alvo = quadro renderizado no keepaBox:
 * menor $118.99 em 23/05/2026, atual $119.00, maior $179.00 em 31/01/2025,
 * média 90d $137.67, média 180d $138.18 → veredito esperado: OTIMO.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeStats,
  history,
  keepaToISODate,
  nowKeepaMin,
  parseSeries,
  verdict,
  DEFAULT_VERDICT_CONFIG,
  SeriesStats,
} from "../src/stats.js";
import {
  analyzeAmazonPrice,
  clearCache,
  clearMemoryCache,
  __resetForTests,
  getPriceHistory,
  getPriceStats,
  resolveAmazonUrl,
} from "../src/service.js";
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

// Cache frio isolado por teste: SQLite em memória, zero vazamento entre testes.
beforeEach(() => {
  __resetForTests(":memory:");
});

describe("quadro Keepa (fixture HAR)", () => {
  const pts = parseSeries(fixture.csv1_NEW);
  const st = computeStats(pts, NOW)!;

  it("extrai 78 pontos com dado", () => {
    expect(pts.length).toBe(78);
    expect(st.count).toBe(78);
  });

  it("menor 118.99 em 2026-05-23 (última ocorrência)", () => {
    expect(st.lowest.val).toBeCloseTo(118.99, 2);
    expect(st.lowest.date).toBe("2026-05-23");
  });

  it("maior 179.00 em 2025-01-31 (última ocorrência)", () => {
    expect(st.highest.val).toBeCloseTo(179.0, 2);
    expect(st.highest.date).toBe("2025-01-31");
  });

  it("atual 119.00 em 2026-09-28", () => {
    expect(st.current.val).toBeCloseTo(119.0, 2);
    expect(st.current.date).toBe("2026-09-28");
  });

  it("média 180d = 138.18 exata", () => {
    expect(st.avg180.val).toBeCloseTo(138.18, 2);
  });

  it("média 90d = 137.67 exata", () => {
    expect(st.avg90.val).toBeCloseTo(137.67, 2);
  });

  it("veredito OTIMO (atual≈menor +0,01%, −13,6% vs média 90d)", () => {
    const a = verdict(st, NOW);
    expect(a.verdict).toBe("OTIMO");
    expect(a.posicaoFaixa!).toBeLessThan(0.01);
    expect(a.desvioMedia90!).toBeCloseTo(-0.1356, 3);
  });
});

describe("faixas de veredito (sintético)", () => {
  const mk = (cur: number, min: number, max: number, avg90: number): SeriesStats => ({
    count: 10,
    current: { val: cur, date: "2026-10-01" },
    inStock: true,
    lowest: { val: min, date: "2026-01-01" },
    highest: { val: max, date: "2026-02-01" },
    lowest90: -1,
    highest90: -1,
    lowest180: -1,
    highest180: -1,
    lowest365: -1,
    highest365: -1,
    avg30: { days: 30, val: avg90 },
    avg90: { days: 90, val: avg90 },
    avg180: { days: 180, val: avg90 },
    avgDrops: 0.5,
    hoursSinceFirstRecord: 2000,
  });
  const now = nowKeepaMin();

  it("BOM quando ≤ média−5%", () => {
    expect(verdict(mk(90, 80, 200, 100), now).verdict).toBe("BOM");
  });
  it("NEUTRO dentro de ±5% e meio da faixa", () => {
    expect(verdict(mk(102, 70, 150, 100), now).verdict).toBe("NEUTRO");
  });
  it("RUIM quando > média+5%", () => {
    expect(verdict(mk(120, 80, 200, 100), now).verdict).toBe("RUIM");
  });
  it("RUIM quando posição na faixa > 60%", () => {
    expect(verdict(mk(150, 80, 200, 140), now).verdict).toBe("RUIM");
  });
  it("SEM_VEREDITO sem estoque", () => {
    const s = mk(100, 80, 200, 100);
    s.inStock = false;
    s.current = { val: -1, date: "2026-10-01" };
    expect(verdict(s, now).verdict).toBe("SEM_VEREDITO");
  });
  it("avisa defasagem > 30 dias", () => {
    const s = mk(102, 80, 200, 100);
    s.current = { val: 102, date: "2020-01-01" };
    const a = verdict(s, now);
    expect(a.avisos.some((w) => w.includes("defasado"))).toBe(true);
  });
  it("quedas/mês altas sugerem esperar", () => {
    const s = mk(102, 80, 200, 100);
    s.avgDrops = 3.5;
    const a = verdict(s, now, DEFAULT_VERDICT_CONFIG);
    expect(a.avisos.some((w) => w.includes("oscila"))).toBe(true);
  });
});

describe("URLs e serviço (fixture)", () => {
  it("resolve dp + tld (com, com.br, co.uk)", async () => {
    expect(
      await resolveAmazonUrl("https://www.amazon.com/dp/B0CZ6XY78Y/ref=xyz"),
    ).toEqual({ asin: "B0CZ6XY78Y", domainId: 1 });
    expect(
      await resolveAmazonUrl("https://www.amazon.com.br/dp/B0CZ6XY78Y"),
    ).toEqual({ asin: "B0CZ6XY78Y", domainId: 12 });
    expect(
      await resolveAmazonUrl("https://www.amazon.co.uk/gp/product/B0CZ6XY78Y"),
    ).toEqual({ asin: "B0CZ6XY78Y", domainId: 2 });
  });

  it("resolve link curto via redirect", async () => {
    const fakeFetch = (async () => ({ url: "https://www.amazon.com/dp/B0CZ6XY78Y/" })) as unknown as typeof fetch;
    expect(await resolveAmazonUrl("https://amzn.to/abc123", fakeFetch)).toEqual({
      asin: "B0CZ6XY78Y",
      domainId: 1,
    });
  });

  it("rejeita URL não-Amazon e sem ASIN", async () => {
    await expect(resolveAmazonUrl("https://example.com/dp/B0CZ6XY78Y")).rejects.toThrow();
    await expect(resolveAmazonUrl("https://www.amazon.com/")).rejects.toThrow();
  });

  it("getPriceStats usa cache na 2ª chamada", async () => {
    clearCache();
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const s1 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    const s2 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    expect(calls).toBe(1);
    expect(s2.novo.lowest.val).toBeCloseTo(118.99, 2);
    expect(s1).toBe(s2);
  });

  it("analyze devolve OTIMO end-to-end (fixture)", async () => {
    clearCache();
    const r = await analyzeAmazonPrice(
      "https://www.amazon.com/dp/B0CZ6XY78Y",
      async (a, d) => ({ ...(await fetchFixture(a, d)), title: "Fixture" }),
      DEFAULT_VERDICT_CONFIG,
      NOW,
    );
    expect(r.analysis.verdict).toBe("OTIMO");
    expect(r.asin).toBe("B0CZ6XY78Y");
  });

  it("history retorna pontos no formato de plotagem", async () => {
    clearCache();
    const h = await getPriceHistory(
      "B0CZ6XY78Y",
      1,
      90,
      fetchFixture,
      NOW,
    );
    expect(h.points.length).toBeGreaterThan(0);
    expect(h.points[0]).toHaveProperty("date");
    expect(h.points[0]).toHaveProperty("price");
    expect(h.points[h.points.length - 1].price).toBeCloseTo(119.0, 2);
  });

  it("keepaToISODate ancora 2011-01-01", () => {
    expect(keepaToISODate(0)).toBe("2011-01-01");
  });
});

describe("cache frio SQLite", () => {
  it("sobrevive a restart: L1 limpo, SQLite intacto, zero refetch", async () => {
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const s1 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    expect(calls).toBe(1);
    clearMemoryCache(); // simula restart do gateway
    const s2 = await getPriceStats("B0CZ6XY78Y", 1, counting, NOW);
    expect(calls).toBe(1);
    expect(s2).toEqual(s1);
  });

  it("history sai do frio após restart sem refetch", async () => {
    let calls = 0;
    const counting: typeof fetchFixture = async (a, d) => {
      calls++;
      return fetchFixture(a, d);
    };
    const h1 = await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
    expect(calls).toBe(1);
    clearMemoryCache();
    const h2 = await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
    expect(calls).toBe(1);
    expect(h2.points).toEqual(h1.points);
  });

  it("histórico antigo serve infinito mesmo expirado; recente refaz fetch", async () => {
    const prev = process.env.KEEPA_CACHE_TTL_MS;
    process.env.KEEPA_CACHE_TTL_MS = "1";
    try {
      let calls = 0;
      const counting: typeof fetchFixture = async (a, d) => {
        calls++;
        return fetchFixture(a, d);
      };
      await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
      expect(calls).toBe(1);
      await new Promise((r) => setTimeout(r, 10)); // expira o TTL de 1ms
      // NOW é histórico (fixture de dias atrás): serve do frio, zero chamadas.
      await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, NOW);
      expect(calls).toBe(1);
      // Janela recente (agora de verdade): TTL expirado refaz fetch.
      await getPriceHistory("B0CZ6XY78Y", 1, 90, counting, nowKeepaMin());
      expect(calls).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.KEEPA_CACHE_TTL_MS;
      else process.env.KEEPA_CACHE_TTL_MS = prev;
    }
  });
});
