import type { Allocation, AllocationOpp, Curve, KellyInput, KellyResult } from "./types";

/** Taker fee per contract, both venues: 0.07 * P * (1 - P). */
export const feePerContract = (price: number) => 0.07 * price * (1 - price);

const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Same formula as the backend (edgedesk.capital.tools.kelly). */
export function kelly({ p, price, band, fraction, bankroll }: KellyInput): KellyResult {
  const c = price + feePerContract(price);
  const pc = p - band;
  const full = c > 0 && c < 1 ? (p - c) / (1 - c) : 0;
  const cons = c > 0 && c < 1 ? (pc - c) / (1 - c) : 0;
  const f = Math.max(0, cons) * fraction;
  const qty = c > 0 ? Math.floor((f * bankroll) / c) : 0;
  let growth = 0;
  if (f > 0) {
    const win = (1 - c) / c;
    growth = p * Math.log(1 + f * win) + (1 - p) * Math.log(1 - f);
  }
  return {
    cost_per_contract: r(c, 4),
    edge: r(p - c, 4),
    edge_conservative: r(pc - c, 4),
    kelly_full: r(Math.max(0, full), 4),
    kelly_conservative: r(Math.max(0, cons), 4),
    fraction_used: r(f, 4),
    stake: r(qty * c, 2),
    contracts: qty,
    expected_log_growth: r(growth, 6),
  };
}

// ---------------------------------------------------------------------------------------------
// Illustrative joint allocation, computed in the browser when the API has no live opportunity set
// (allocation: null). Draws S_T from the model curve P(S_T > K) by inverse-CDF interpolation and
// maximises E[log(1 + sum x_i r_i)] by projected gradient ascent. Same objective as the backend.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function illustrativeAllocation(curve: Curve | undefined, fraction = 0.25): Allocation | null {
  const pts = (curve?.points ?? [])
    .filter((p) => p.venue === "kalshi" && p.p_hybrid != null)
    .sort((a, b) => a.strike - b.strike);
  if (pts.length < 3) return null;
  // CDF knots: F(K) = 1 - P(S_T > K), extended to tails.
  const ks = pts.map((p) => p.strike);
  const span = ks[ks.length - 1] - ks[0];
  const knots = [
    { k: ks[0] - span, F: 0 },
    ...pts.map((p) => ({ k: p.strike, F: 1 - (p.p_hybrid as number) })),
    { k: ks[ks.length - 1] + span, F: 1 },
  ];
  for (let i = 1; i < knots.length; i++) knots[i].F = Math.max(knots[i].F, knots[i - 1].F + 1e-6);
  const rnd = mulberry32(7);
  const N = 4000;
  const S = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const u = rnd() * knots[knots.length - 1].F;
    let i = 1;
    while (i < knots.length - 1 && knots[i].F < u) i++;
    const a = knots[i - 1];
    const b = knots[i];
    S[n] = a.k + ((u - a.F) / Math.max(1e-9, b.F - a.F)) * (b.k - a.k);
  }
  // Illustrative prices: each strike quoted 4c under the model on its likelier side.
  const opps = pts.slice(0, 8).map((p) => {
    const pYes = p.p_hybrid as number;
    const side = pYes >= 0.5 ? ("yes" as const) : ("no" as const);
    const prob = side === "yes" ? pYes : 1 - pYes;
    const price = Math.min(0.97, Math.max(0.03, Math.round((prob - 0.04) * 100) / 100));
    return { id: p.cid ?? String(p.strike), strike: p.strike, side, p: r(prob, 4), cost: r(price + feePerContract(price), 4) };
  }).filter((o) => o.p > o.cost);
  if (!opps.length) return null;
  const R = opps.map((o) => Array.from(S, (s) => ((o.side === "yes" ? s > o.strike : s <= o.strike) ? (1 - o.cost) / o.cost : -1)));
  const m = opps.length;
  const x = new Array(m).fill(0.01);
  const maxF = 0.5;
  for (let it = 0; it < 600; it++) {
    const g = new Array(m).fill(0);
    for (let n = 0; n < N; n++) {
      let w = 1;
      for (let j = 0; j < m; j++) w += x[j] * R[j][n];
      if (w <= 1e-6) w = 1e-6;
      for (let j = 0; j < m; j++) g[j] += R[j][n] / w;
    }
    const lr = 0.02;
    for (let j = 0; j < m; j++) x[j] = Math.min(maxF, Math.max(0, x[j] + (lr * g[j]) / N));
    const sum = x.reduce((a, b) => a + b, 0);
    if (sum > maxF) for (let j = 0; j < m; j++) x[j] *= maxF / sum;
  }
  const out: AllocationOpp[] = opps.map((o, j) => ({
    ...o,
    joint: r(x[j] * fraction, 5),
    independent: r(Math.max(0, (o.p - o.cost) / (1 - o.cost)) * fraction, 5),
  }));
  return {
    sym: curve?.sym,
    expiry_ms: curve?.expiry_ms,
    venue: "kalshi",
    opps: out,
    joint_total: r(out.reduce((a, o) => a + o.joint, 0), 5),
    independent_total: r(out.reduce((a, o) => a + o.independent, 0), 5),
    illustrative: true,
  };
}
