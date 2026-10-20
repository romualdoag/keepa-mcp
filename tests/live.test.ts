/**
 * Teste de contrato ao vivo (baixo volume: 1 produto).
 * PASSA em dois cenários:
 *  a) rede permite guest → valida o decode contra o ASIN conhecido; ou
 *  b) rede bloqueada (checkHuman/rede) → KeepaBlockedError com mensagem clara.
 * Qualquer outro erro FALHA (detecção de quebra do protocolo).
 */
import { describe, expect, it } from "vitest";
import {
  CSV,
  computeStats,
  nowKeepaMin,
  parseSeries,
} from "../src/stats.js";
import {
  fetchProductLive,
  KeepaBlockedError,
  KeepaError,
} from "../src/protocol.js";

describe("contrato ao vivo (B0CZ6XY78Y)", () => {
  it("guest retorna histórico íntegro OU bloqueio explícito", async () => {
    let bp;
    try {
      bp = await fetchProductLive("B0CZ6XY78Y", 1);
    } catch (e) {
      expect(e).toBeInstanceOf(KeepaBlockedError);
      console.log(`[live] bloqueado neste ambiente (ok): ${(e as Error).message.slice(0, 120)}`);
      return;
    }
    expect(bp.asin).toBe("B0CZ6XY78Y");
    const pts = parseSeries(bp.csv?.[CSV.NEW] ?? null);
    expect(pts.length).toBeGreaterThan(0);
    const st = computeStats(pts, nowKeepaMin())!;
    // âncoras do quadro conhecido (tolerância: catálogo vivo muda com o tempo)
    expect(st.lowest.val).toBeLessThanOrEqual(118.99 + 0.01);
    expect(st.highest.val).toBeGreaterThanOrEqual(179.0 - 0.01);
    expect(st).toBeTruthy();
    void KeepaError;
  }, 120_000);
});
