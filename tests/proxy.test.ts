/**
 * Suporte a proxy: seleção por env, máscara p/ logs, token e h.
 * Sem rede — o teste ao vivo via proxy é condicional (só roda com proxy setado).
 */
import { describe, expect, it } from "vitest";
import {
  hostHash,
  maskProxy,
  newGuestToken,
  proxyUrl,
  fetchProductLive,
  KeepaBlockedError,
} from "../src/protocol.js";

describe("proxy (offline)", () => {
  it("prioridade: KEEPA_PROXY > HTTPS_PROXY > HTTP_PROXY", () => {
    expect(proxyUrl({})).toBeUndefined();
    expect(proxyUrl({ HTTP_PROXY: "http://a:1" })).toBe("http://a:1");
    expect(
      proxyUrl({ HTTP_PROXY: "http://a:1", HTTPS_PROXY: "http://b:2" }),
    ).toBe("http://b:2");
    expect(
      proxyUrl({
        HTTP_PROXY: "http://a:1",
        HTTPS_PROXY: "http://b:2",
        KEEPA_PROXY: "http://c:3",
      }),
    ).toBe("http://c:3");
  });

  it("mascara senha no log, mantém host", () => {
    expect(maskProxy("http://user:s3cr3t@proxy.exemplo:8080")).toBe(
      "http://user:***@proxy.exemplo:8080",
    );
    expect(maskProxy("http://proxy.exemplo:8080")).toBe(
      "http://proxy.exemplo:8080",
    );
  });

  it("token guest: 64 chars base32", () => {
    const t = newGuestToken();
    expect(t).toMatch(/^[0-9a-v]{64}$/);
    expect(newGuestToken()).not.toBe(t);
  });

  it("h é determinístico (keepa.com)", () => {
    expect(hostHash()).toBe("y05NLUjUS87PBQA=");
  });
});

describe.runIf(
  Boolean(
    process.env.KEEPA_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY,
  ),
)("ao vivo via proxy", () => {
  it("guest via proxy retorna produto OU bloqueio explícito", async () => {
    let bp;
    try {
      bp = await fetchProductLive("B0CZ6XY78Y", 1);
    } catch (e) {
      expect(e).toBeInstanceOf(KeepaBlockedError);
      return;
    }
    expect(bp.asin).toBe("B0CZ6XY78Y");
    expect(Array.isArray(bp.csv)).toBe(true);
  }, 120_000);
});
