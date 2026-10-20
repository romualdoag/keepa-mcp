/**
 * keepa-mcp stats — porte fiel da matemática do keepa.js (statsCSV/getWeightedMean),
 * obtida por engenharia reversa (ver ../keepa-rev/docs/PROTOCOL.md).
 *
 * Convenções Keepa:
 * - tempo em "keepa-minutos": minutos desde 2011-01-01T00:00Z.
 *   unix_ms = (t + 21564000) * 60_000
 * - preços em centavos; -1 = sem dado; "" também é ignorado.
 * - menor/maior: em empate, a OCORRÊNCIA MAIS RECENTE vence (<= / >=).
 * - médias: ponderadas por tempo sobre a função-escada, com filtro de
 *   outliers (pontos > $200 E > 5x a média), resultado em centavos inteiros (floor).
 * - avgDrops (quedas/mês): conta degraus de queda na janela (padrão 90d),
 *   normalizado como round(n/dias*3000.5)/100 (≈ x30 = por mês).
 */

export const KEEPA_OFFSET = 21564000;
export const MIN_PER_DAY = 1440;

export const keepaToUnixMs = (t: number): number => (t + KEEPA_OFFSET) * 60_000;
export const keepaToISODate = (t: number): string =>
  new Date(keepaToUnixMs(t)).toISOString().slice(0, 10);
export const nowKeepaMin = (): number =>
  Math.floor(Date.now() / 60_000) - KEEPA_OFFSET;

/** Índices CsvType relevantes (mapa completo no PROTOCOL.md). */
export const CSV = {
  AMAZON: 0,
  NEW: 1,
  USED: 2,
  SALES: 3,
} as const;

export interface Point {
  /** keepa-minutos */
  t: number;
  /** centavos, sempre >= 0 */
  price: number;
}

/** Extrai pontos [t, preço] de uma série csv (passo 2; séries com frete: passo 3, soma frete). */
export function parseSeries(
  arr: number[] | null | undefined,
  withShipping = false,
): Point[] {
  if (!arr) return [];
  const step = withShipping ? 3 : 2;
  const pts: Point[] = [];
  for (let i = 0; i + 1 < arr.length; i += step) {
    const t = Number(arr[i]);
    let p = Number(arr[i + 1]);
    if (withShipping) {
      const s = Number(arr[i + 2]);
      if (!Number.isNaN(s) && s > 0) p += s;
    }
    if (!Number.isNaN(t) && !Number.isNaN(p) && p >= 0) pts.push({ t, price: p });
  }
  return pts;
}

export interface StatVal {
  /** em moeda (ex. dólares) */
  val: number;
  /** data ISO (YYYY-MM-DD) */
  date: string;
}

export interface Averages {
  days: number;
  /** em moeda; -1 = sem dados na janela */
  val: number;
}

export interface SeriesStats {
  count: number;
  /** val -1 = sem estoque/dado atual */
  current: StatVal;
  inStock: boolean;
  lowest: StatVal;
  highest: StatVal;
  lowest90: StatVal | -1;
  highest90: StatVal | -1;
  lowest180: StatVal | -1;
  highest180: StatVal | -1;
  lowest365: StatVal | -1;
  highest365: StatVal | -1;
  avg30: Averages;
  avg90: Averages;
  avg180: Averages;
  /** quedas por mês (janela 90d ou histórico, se menor) */
  avgDrops: number;
  hoursSinceFirstRecord: number;
}

const toVal = (p: Point): StatVal => ({
  val: p.price / 100,
  date: keepaToISODate(p.t),
});

/** Média ponderada por tempo em [nowMin-days*1440, nowMin], centavos inteiros (floor). -1 = sem dados. */
export function weightedMean(
  pts: Point[],
  nowMin: number,
  days: number,
): number {
  const c = nowMin - days * MIN_PER_DAY;
  const d = nowMin;
  if (c >= d || pts.length === 0) return -1;
  const first = pts[0];
  const lastT = pts[pts.length - 1].t;
  if (lastT < 0 || first.t < 0 || first.t > d) return -1;
  const start = Math.max(c, first.t);
  let w = 0;
  let tAcc = 0;
  for (let i = 0; i < pts.length; i++) {
    const z = pts[i].t;
    if (z >= d) break;
    const g = pts[i].price;
    if (z >= start) {
      if (i === 0 && i === pts.length - 1) return g;
      const x0 = i === pts.length - 1 ? nowMin : pts[i + 1].t;
      const x = Math.min(x0, d);
      const dur = Math.max(1, x - z);
      tAcc += dur;
      w += g * dur;
    } else {
      if (i === pts.length - 1 || pts[i + 1].t >= d) return g;
      const z2 = pts[i + 1].t;
      if (z2 >= start) {
        const dur = Math.max(1, z2 - start);
        tAcc = dur;
        w = g * dur;
      }
    }
  }
  return tAcc === 0 ? -1 : Math.floor(w / tAcc);
}

/** getWeightedMean: filtro de outliers + média do intervalo. */
export function average(
  pts: Point[],
  nowMin: number,
  days: number,
): number {
  if (pts.length === 0) return -1;
  // filtro de extremos: média geral em ~1000 dias; descarta > $200 E > 5x média
  const overall = weightedMean(pts, nowMin, 1000);
  let use = pts;
  if (overall >= 100) {
    const filtered = pts.filter(
      (p) => !(p.price > 20000 && p.price > overall * 5),
    );
    use = filtered;
  }
  if (use.length === 0) return -1;
  return weightedMean(use, nowMin, days);
}

export function computeStats(
  pts: Point[],
  nowMin: number,
  salesType = false,
): SeriesStats | null {
  if (pts.length === 0) return null;
  const cut90 = nowMin - 90 * MIN_PER_DAY;
  const cut180 = nowMin - 180 * MIN_PER_DAY;
  const cut365 = nowMin - 365 * MIN_PER_DAY;

  let lo = pts[0];
  let hi = pts[0];
  let lo90: Point | null = null;
  let hi90: Point | null = null;
  let lo180: Point | null = null;
  let hi180: Point | null = null;
  let lo365: Point | null = null;
  let hi365: Point | null = null;

  for (const p of pts) {
    if (hi.price <= p.price) hi = p; // <= : última ocorrência vence
    if (lo.price >= p.price) lo = p; // >= : última ocorrência vence
    if (p.t > cut90) {
      if (hi90 === null || hi90.price <= p.price) hi90 = p;
      if (lo90 === null || lo90.price >= p.price) lo90 = p;
    }
    if (p.t > cut180) {
      if (hi180 === null || hi180.price <= p.price) hi180 = p;
      if (lo180 === null || lo180.price >= p.price) lo180 = p;
    }
    if (p.t > cut365) {
      if (hi365 === null || hi365.price <= p.price) hi365 = p;
      if (lo365 === null || lo365.price >= p.price) lo365 = p;
    }
  }

  // Quedas: degraus de descida dentro da janela (Va dias; encolhe se histórico curto)
  const histMin = nowMin - pts[0].t;
  let Va = 90;
  if (histMin < 129600) Va = Math.floor(histMin / MIN_PER_DAY);
  let drops = 0;
  if (!(histMin < 1440) && pts.length > 1) {
    const windowMin = Va * MIN_PER_DAY;
    let prev = pts[0].price;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (nowMin - p.t < windowMin) {
        if (p.price < prev) {
          if (salesType) {
            // regra especial do SALES por razão — aproximada fora do escopo do veredito
            const ratio = prev / p.price;
            if (prev < 10000 || (prev < 50000 && ratio > 1.03) || ratio > 1.05)
              drops++;
          } else {
            drops++;
          }
        }
        prev = p.price;
      } else {
        prev = p.price;
      }
    }
  }
  const avgDrops =
    drops > 0 && Va > 0 ? Math.round((drops / Va) * 3000.5) / 100 : 0;

  const a30 = average(pts, nowMin, 30);
  const a90 = average(pts, nowMin, 90);
  const a180 = average(pts, nowMin, 180);
  const cur = pts[pts.length - 1];

  const opt = (p: Point | null): StatVal | -1 => (p === null ? -1 : toVal(p));

  return {
    count: pts.length,
    current: toVal(cur),
    inStock: true,
    lowest: toVal(lo),
    highest: toVal(hi),
    lowest90: opt(lo90),
    highest90: opt(hi90),
    lowest180: opt(lo180),
    highest180: opt(hi180),
    lowest365: opt(lo365),
    highest365: opt(hi365),
    avg30: { days: 30, val: a30 < 0 ? -1 : a30 / 100 },
    avg90: { days: 90, val: a90 < 0 ? -1 : a90 / 100 },
    avg180: { days: 180, val: a180 < 0 ? -1 : a180 / 100 },
    avgDrops,
    hoursSinceFirstRecord: histMin / 60,
  };
}

export type Verdict = "OTIMO" | "BOM" | "NEUTRO" | "RUIM" | "SEM_VEREDITO";

export interface VerdictConfig {
  /** tolerância acima do menor para ÓTIMO (0.03 = +3%) */
  otimoAcimaDoMenor: number;
  /** desconto vs média 90d para BOM (0.05 = −5%) */
  bomDescontoMedia: number;
  /** banda neutra ± da média 90d */
  neutroBanda: number;
  /** posição na faixa p/ BOM (<) e RUIM (>) */
  bomPosicao: number;
  ruimPosicao: number;
  /** limiares de quedas/mês p/ notas de volatilidade */
  dropsAlto: number;
  dropsBaixo: number;
  /** dias sem atualização p/ avisar defasagem */
  staleDias: number;
}

export const DEFAULT_VERDICT_CONFIG: VerdictConfig = {
  otimoAcimaDoMenor: 0.03,
  bomDescontoMedia: 0.05,
  neutroBanda: 0.05,
  bomPosicao: 0.25,
  ruimPosicao: 0.6,
  dropsAlto: 2,
  dropsBaixo: 1,
  staleDias: 30,
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): VerdictConfig {
  const n = (k: string, d: number): number => {
    const v = Number(env[k]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    otimoAcimaDoMenor: n("KEEPA_OTIMO_ACIMA_MENOR", 0.03),
    bomDescontoMedia: n("KEEPA_BOM_DESCONTO_MEDIA", 0.05),
    neutroBanda: n("KEEPA_NEUTRO_BANDA", 0.05),
    bomPosicao: n("KEEPA_BOM_POSICAO", 0.25),
    ruimPosicao: n("KEEPA_RUIM_POSICAO", 0.6),
    dropsAlto: n("KEEPA_DROPS_ALTO", 2),
    dropsBaixo: n("KEEPA_DROPS_BAIXO", 1),
    staleDias: n("KEEPA_STALE_DIAS", 30),
  };
}

export interface Analysis {
  verdict: Verdict;
  /** 0 = no menor, 1 = no maior */
  posicaoFaixa: number | null;
  desvioMedia90: number | null;
  motivos: string[];
  avisos: string[];
}

/** Veredito a partir das estatísticas da série Novo. nowMin p/ checar defasagem. */
export function verdict(
  s: SeriesStats,
  nowMin: number,
  cfg: VerdictConfig = DEFAULT_VERDICT_CONFIG,
): Analysis {
  const motivos: string[] = [];
  const avisos: string[] = [];
  const cur = s.current.val;

  if (!s.inStock || cur < 0) {
    return {
      verdict: "SEM_VEREDITO",
      posicaoFaixa: null,
      desvioMedia90: null,
      motivos: ["sem estoque em Novo"],
      avisos,
    };
  }

  const ageDias = (nowMin - isoToKeepa(s.current.date)) / MIN_PER_DAY;
  if (ageDias > cfg.staleDias) {
    avisos.push(
      `dado atual defasado: ${s.current.date} (${Math.floor(ageDias)} dias atrás)`,
    );
  }

  const avg90 = s.avg90.val;
  const pos =
    s.highest.val > s.lowest.val
      ? (cur - s.lowest.val) / (s.highest.val - s.lowest.val)
      : 0;
  const dev = avg90 > 0 ? (cur - avg90) / avg90 : null;

  let v: Verdict = "NEUTRO";
  if (cur <= s.lowest.val * (1 + cfg.otimoAcimaDoMenor) && avg90 > 0 && cur < avg90) {
    v = "OTIMO";
    motivos.push(
      `atual $${cur.toFixed(2)} ≈ menor $${s.lowest.val.toFixed(2)} e abaixo da média 90d $${avg90.toFixed(2)}`,
    );
  } else if (
    (avg90 > 0 && cur <= avg90 * (1 - cfg.bomDescontoMedia)) ||
    pos < cfg.bomPosicao
  ) {
    v = "BOM";
    motivos.push(
      `atual $${cur.toFixed(2)} vs média 90d $${avg90 > 0 ? avg90.toFixed(2) : "n/d"} (posição na faixa ${(pos * 100).toFixed(0)}%)`,
    );
  } else if (
    (avg90 > 0 && cur > avg90 * (1 + cfg.neutroBanda)) ||
    pos > cfg.ruimPosicao
  ) {
    v = "RUIM";
    motivos.push(
      `atual $${cur.toFixed(2)} acima da média 90d $${avg90 > 0 ? avg90.toFixed(2) : "n/d"} (posição na faixa ${(pos * 100).toFixed(0)}%)`,
    );
  } else {
    v = "NEUTRO";
    motivos.push(
      `atual $${cur.toFixed(2)} dentro de ±${(cfg.neutroBanda * 100).toFixed(0)}% da média 90d`,
    );
  }

  if (s.avgDrops > cfg.dropsAlto) {
    avisos.push(
      `preço oscila (${s.avgDrops} quedas/mês): pode valer esperar`,
    );
  } else if (s.avgDrops < cfg.dropsBaixo) {
    avisos.push(`preço estável (${s.avgDrops} quedas/mês)`);
  }

  return { verdict: v, posicaoFaixa: pos, desvioMedia90: dev, motivos, avisos };
}

/** Série temporal p/ plotagem: [{date, price}], últimos `days` (0 = tudo), com downsampling leve. */
export function history(
  pts: Point[],
  nowMin: number,
  days: number,
): Array<{ date: string; price: number }> {
  const cut = days > 0 ? nowMin - days * MIN_PER_DAY : -Infinity;
  const sel = pts.filter((p) => p.t >= cut);
  const maxPts = 1500;
  const step = sel.length > maxPts ? Math.ceil(sel.length / maxPts) : 1;
  return sel
    .filter((_, i) => i % step === 0)
    .map((p) => ({ date: keepaToISODate(p.t), price: p.price / 100 }));
}

function isoToKeepa(iso: string): number {
  return Math.floor(new Date(iso + "T00:00:00Z").getTime() / 60_000) - KEEPA_OFFSET;
}
