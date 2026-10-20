/**
 * keepa-mcp protocolo WS — réplica mínima do keepa.js para o fluxo guest:
 * abre wss://push.keepa.com/apps/cloud/, aguarda hello 108, envia
 * user/settings → user/tracking → product (JSON+zlib, frame binário),
 * recebe JSON puro ou JSON+zstd e resolve por id.
 *
 * Limites: 1 produto por chamada, sem varredura. Se o servidor responder
 * checkHuman (Turnstile) ou a rede apresentar challenge, lança
 * KeepaBlockedError — SEMPRE parar, nunca evadir.
 */
import WebSocket from "ws";
import { deflateSync, deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { decompress as fzstdDecompress } from "fzstd";
import { HttpsProxyAgent } from "https-proxy-agent";

/** Proxy (residencial) p/ sair com IP não-datacenter. Ordem: KEEPA_PROXY > HTTPS_PROXY > HTTP_PROXY. */
export function proxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.KEEPA_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || undefined;
}

/** Mascara credencial p/ logs: http://user:***@host:porta */
export function maskProxy(u: string): string {
  return u.replace(/(\/\/[^/:@]+:)[^/@]+(@)/, "$1***$2");
}

export const WS_URL =
  "wss://push.keepa.com/apps/cloud/?app=keepaWebsite&version=3.0";
export const ORIGIN = "https://keepa.com";
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
export const KEEPA_BUILD = process.env.KEEPA_VERSION ?? "20261014";
const TIMEOUT_MS = Number(process.env.KEEPA_TIMEOUT_MS ?? 60_000);

const TOKEN_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/** Token guest de 64 chars base32, como Guid.newGuid(64) do keepa.js. */
export function newGuestToken(): string {
  const b = randomBytes(40); // 320 bits = 64 x 5 bits
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of b) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 64) {
      bits -= 5;
      out += TOKEN_ALPHABET[(acc >>> bits) & 31];
    }
  }
  return out;
}

/** h: base64(deflate_raw("keepa.com")) — window.location.host do iframe. */
export function hostHash(): string {
  return deflateRawSync(Buffer.from("keepa.com")).toString("base64");
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrame(data: Buffer): Record<string, unknown> {
  let raw: Buffer = data;
  if (data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    raw = Buffer.from(fzstdDecompress(new Uint8Array(data)));
  }
  return JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
}

function encode(obj: unknown): Buffer {
  return deflateSync(
    Buffer.from(JSON.stringify(obj), "utf-8"),
  );
}

export class KeepaError extends Error {}
export class KeepaBlockedError extends KeepaError {}

export interface BasicProduct {
  asin: string;
  domainId: number;
  csv: Array<number[] | null>;
  title?: string;
  lastUpdate?: number;
  trackingSince?: number;
  productType?: number;
  [k: string]: unknown;
}

export interface FetchOpts {
  timeoutMs?: number;
  onEvent?: (ev: string) => void;
}

/**
 * Busca o produto (com histórico) como guest. Baixo volume: 3 requests.
 * Rejeita com KeepaBlockedError se houver checkHuman/challenge.
 */
export function fetchProductLive(
  asin: string,
  domainId: number,
  opts: FetchOpts = {},
): Promise<BasicProduct> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const token = newGuestToken();
  const proxy = proxyUrl();
  const rid = Math.floor(Math.random() * 1e8) % 12345;
  const install = Date.now();
  const base = {
    ikb: true,
    install,
    l: "keepa.com",
    u: "/keepaBox.html",
    ua: UA,
    h: hostHash(),
    version: KEEPA_BUILD,
    user: token,
  };

  return new Promise<BasicProduct>((resolve, reject) => {
    let done = false;
    const fail = (e: Error) => {
      if (!done) {
        done = true;
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(e);
      }
    };
    const timer = setTimeout(
      () => fail(new KeepaError(`timeout após ${timeoutMs}ms sem resposta product`)),
      timeoutMs,
    );

    const ws = new WebSocket(WS_URL, {
      origin: ORIGIN,
      headers: { "User-Agent": UA },
      maxPayload: 100 * 1024 * 1024,
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
    });

    const send = (o: unknown) => ws.send(encode(o));

    ws.on("open", () => {
      opts.onEvent?.(
        proxy ? `ws-open via proxy ${maskProxy(proxy)}` : "ws-open direto",
      );
      send({ ...base, path: "user/settings", type: "getSettings", id: rid });
    });
    ws.on("error", (e) => fail(new KeepaError(`websocket: ${String(e)}`)));

    let stage = 0;
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = decodeFrame(data as Buffer);
      } catch (e) {
        fail(new KeepaError(`frame ilegível: ${String(e)}`));
        return;
      }
      if (msg.checkHuman) {
        fail(
          new KeepaBlockedError(
            "servidor exigiu checkHuman (Turnstile) para esta rede/cliente — " +
              "parado sem evasão (ver README: rode a partir de rede residencial ou use fixture)",
          ),
        );
        return;
      }
      const status = msg.status as number | undefined;
      const id = msg.id as number | undefined;
      if (status === 108) {
        opts.onEvent?.("hello-guest");
        return;
      }
      if (id === rid && stage === 0) {
        stage = 1; // settings respondida (200 ou 401 guest)
        opts.onEvent?.(`settings:${String(status)}`);
        send({ ...base, path: "user/tracking", asin, kA: false, id: rid + 1 });
        return;
      }
      if (id === rid + 1 && stage === 1) {
        stage = 2;
        opts.onEvent?.(`tracking:${String(status)}`);
        send({
          ...base,
          path: "product",
          type: "ws",
          history: true,
          domainId,
          asin,
          url: `https://www.amazon.${domainHost(domainId)}/dp/${asin}/`,
          kA: false,
          maxAge: 3,
          refreshProduct: false,
          id: rid + 2,
        });
        return;
      }
      if (id === rid + 2 && stage === 2) {
        if (status !== 200) {
          fail(new KeepaError(`product respondeu status=${String(status)}`));
          return;
        }
        const prods = (msg.basicProducts ?? msg.products) as
          | BasicProduct[]
          | undefined;
        const bp = prods?.[0];
        if (!bp || !bp.csv) {
          fail(new KeepaError("resposta product sem basicProducts/csv"));
          return;
        }
        done = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* noop */
        }
        resolve(bp);
      }
    });
  });
}

function domainHost(domainId: number): string {
  const map: Record<number, string> = {
    1: "com",
    2: "co.uk",
    3: "de",
    4: "fr",
    5: "co.jp",
    6: "ca",
    8: "it",
    9: "es",
    10: "in",
    11: "mx",
    12: "com.br",
  };
  return map[domainId] ?? "com";
}
