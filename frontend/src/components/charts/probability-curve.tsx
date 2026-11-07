"use client";

import { useState } from "react";
import { cents, edgeCents, pct, price, strike as fmtStrike, symName, venueLabel } from "@/lib/format";
import type { Curve, CurvePoint, Opportunity } from "@/lib/types";
import { AxisX, ChartBox, GridY, Legend, linear, niceTicks, pathOf, Tip, TipRow } from "./core";

const VENUE_COLOR: Record<string, string> = { kalshi: "var(--kalshi)", polymarket: "var(--poly)" };
export const venueColor = (v?: string | null) => VENUE_COLOR[v ?? ""] ?? "var(--ink-3)";

/** Which model the curve shows: the trading model where the curve has it. */
export function curveModel(tradeModel?: string) {
  if (tradeModel === "options") return { key: "p_options", band: "band", label: "Options-implied" } as const;
  if (tradeModel === "realized") return { key: "p_realized", band: "band_hybrid", label: "Realized vol" } as const;
  return { key: "p_hybrid", band: "band_hybrid", label: "Hybrid" } as const;
}

interface Group {
  strike: number;
  p: number | null;
  band: number;
  quotes: CurvePoint[];
}

const SANS = { fontFamily: "var(--font-sans)", fontSize: 11 } as const;

/** Plain-English one-liner for a live signal. */
export function signalText(o: Opportunity): string {
  const v = venueLabel(o.venue);
  if (o.signal === "no") return `Model ${pct(o.fair != null ? 1 - o.fair : null, 0)} chance of NO · ${v} NO at ${cents(o.bid != null ? 1 - o.bid : null)}`;
  return `Model ${pct(o.fair, 0)} · ${v} sells YES at ${cents(o.ask)}`;
}

export function ProbabilityCurve({
  curve, tradeModel, height = 430, signals = [],
}: { curve: Curve; tradeModel?: string; height?: number; signals?: Opportunity[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const m = curveModel(tradeModel);
  const pts = [...(curve.points ?? [])].filter((p) => Number.isFinite(p.strike)).sort((a, b) => a.strike - b.strike);

  // strikes within $1 of each other (Kalshi 76,499.99 vs Polymarket 76,500) share a column
  const groups: Group[] = [];
  for (const p of pts) {
    const pv = (p[m.key] ?? p.p_hybrid ?? p.p_options) as number | null | undefined;
    const bv = ((p[m.band] ?? p.band ?? 0) as number) || 0;
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.strike - p.strike) < 1) {
      g.quotes.push(p);
      if (g.p == null && pv != null) g.p = pv;
    } else groups.push({ strike: Math.round(p.strike * 100) / 100, p: pv ?? null, band: bv, quotes: [p] });
  }

  return (
    <div>
      <ChartBox height={height} testId="curve-chart" label={`Chance ${symName(curve.sym)} ends above each strike: ${m.label} model vs Kalshi and Polymarket prices`}>
        {(w) => {
          const M = { l: 46, r: 14, t: 30, b: 40 };
          const strikes = groups.map((g) => g.strike);
          const spot = curve.spot ?? null;
          const all = spot != null ? [...strikes, spot] : strikes;
          let lo = Math.min(...all);
          let hi = Math.max(...all);
          if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
          const padX = (hi - lo || 1000) * 0.06;
          const x = linear([lo - padX, hi + padX], [M.l, w - M.r]);
          const y = linear([0, 1], [height - M.b, M.t]);
          const modelPts = groups.filter((g) => g.p != null);
          const line = pathOf(modelPts.map((g) => [x(g.strike), y(g.p as number)]));
          const upper = modelPts.map((g) => [x(g.strike), y(Math.min(1, (g.p as number) + g.band))] as [number, number]);
          const lower = modelPts.map((g) => [x(g.strike), y(Math.max(0, (g.p as number) - g.band))] as [number, number]).reverse();
          const band = upper.length ? `${pathOf([...upper, ...lower])}Z` : "";
          const xt = niceTicks(lo - padX, hi + padX, Math.max(3, Math.floor(w / 110)));
          const hg = hover != null ? groups[hover] : null;
          // live signals: shade their strike, mark the venue price, annotate the best one or two
          const sigs = [...signals]
            .filter((o) => o.strike != null)
            .sort((a, b) => (b.best_edge ?? 0) - (a.best_edge ?? 0))
            .map((o, rank) => {
              const px = o.signal === "no" ? o.bid : o.ask;
              return { o, rank, sx: x(o.strike as number), sy: px != null ? y(px) : null, text: signalText(o) };
            });

          function onMove(e: React.PointerEvent<SVGSVGElement>) {
            const r = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - r.left;
            let best = -1;
            let bd = Infinity;
            groups.forEach((g, i) => {
              const d = Math.abs(x(g.strike) - px);
              if (d < bd) [bd, best] = [d, i];
            });
            setHover(best >= 0 && bd < 60 ? best : null);
          }

          return (
            <>
              <svg width={w} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
                <GridY ticks={[0, 0.25, 0.5, 0.75, 1]} y={y} x0={M.l} x1={w - M.r} fmt={(v) => `${v * 100}%`} />
                <AxisX ticks={xt} x={x} y={height - M.b} fmt={(v) => `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`} />
                <text x={M.l - 40} y={12} textAnchor="start" style={SANS}>Chance of ending above</text>
                <text x={(M.l + w - M.r) / 2} y={height - 4} textAnchor="middle" style={SANS}>{symName(curve.sym)} price at expiry (strike)</text>
                {sigs.map(({ o, sx }) => (
                  <rect key={`band-${o.cid}`} data-testid="signal-band" x={sx - 11} y={M.t} width={22} height={height - M.t - M.b} rx={3} style={{ fill: "var(--brand)", opacity: 0.08 }} />
                ))}
                {spot != null ? (
                  <g data-testid="spot-marker">
                    <line x1={x(spot)} x2={x(spot)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--ink-2)" }} strokeDasharray="3 3" />
                    <rect x={x(spot) - 42} y={M.t - 13} width={84} height={14} rx={2} style={{ fill: "var(--ink)" }} />
                    <text x={x(spot)} y={M.t - 3} textAnchor="middle" style={{ fill: "var(--bg)", fontSize: 10 }}>now {price(spot, 0)}</text>
                  </g>
                ) : null}
                {hg ? <line x1={x(hg.strike)} x2={x(hg.strike)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--ink-3)" }} strokeWidth={1} opacity={0.5} /> : null}
                <path d={band} style={{ fill: "var(--band)" }} />
                <path d={line} fill="none" style={{ stroke: "var(--brand)" }} strokeWidth={2} strokeLinejoin="round" />
                {groups.map((g, gi) =>
                  g.quotes.map((q, qi) => {
                    if (q.bid == null && q.ask == null) return null;
                    const off = g.quotes.length > 1 ? (qi === 0 ? -6 : 6) : 0;
                    const cx = x(g.strike) + off;
                    const yb = y(q.bid ?? (q.ask as number));
                    const ya = y(q.ask ?? (q.bid as number));
                    const c = venueColor(q.venue);
                    return (
                      <g key={`${gi}-${qi}`} data-testid="venue-quote" opacity={hover == null || hover === gi ? 1 : 0.55}>
                        <line x1={cx} x2={cx} y1={yb} y2={ya} style={{ stroke: c }} strokeWidth={3} strokeLinecap="round" />
                        <line x1={cx - 4.5} x2={cx + 4.5} y1={yb} y2={yb} style={{ stroke: c }} strokeWidth={2} strokeLinecap="round" />
                        <line x1={cx - 4.5} x2={cx + 4.5} y1={ya} y2={ya} style={{ stroke: c }} strokeWidth={2} strokeLinecap="round" />
                      </g>
                    );
                  }),
                )}
                {sigs.map(({ o, sx, sy }) =>
                  sy == null ? null : (
                    <g key={`m-${o.cid}`} data-testid="signal-marker">
                      <circle cx={sx} cy={sy} r={8} style={{ fill: "none", stroke: "var(--brand)" }} strokeWidth={1.5} strokeDasharray="2 2" />
                    </g>
                  ),
                )}
                {sigs.filter((g) => g.rank < 2 && g.sy != null).map(({ o, rank, sx, sy, text }) => {
                  const bw = Math.min(w - M.l - M.r, text.length * 6 + 18);
                  const by = rank === 0 ? M.t + 6 : height - M.b - 30;
                  const bx = Math.max(M.l, Math.min(w - M.r - bw, sx - bw / 2));
                  return (
                    <g key={`a-${o.cid}`} data-testid="signal-annotation">
                      <line x1={sx} x2={sx} y1={rank === 0 ? by + 22 : by} y2={(sy as number) + (rank === 0 ? -9 : 9)} style={{ stroke: "var(--brand)" }} strokeWidth={1} />
                      <rect x={bx} y={by} width={bw} height={22} rx={5} style={{ fill: "var(--panel)", stroke: "var(--brand)" }} strokeWidth={1} />
                      <text x={bx + bw / 2} y={by + 14.5} textAnchor="middle" style={{ ...SANS, fill: "var(--ink)", fontWeight: 500 }}>{text}</text>
                    </g>
                  );
                })}
                {modelPts.map((g) => (
                  <circle
                    key={g.strike}
                    data-testid="curve-point"
                    cx={x(g.strike)}
                    cy={y(g.p as number)}
                    r={hg === g ? 4.5 : 3}
                    style={{ fill: "var(--panel)", stroke: "var(--brand)" }}
                    strokeWidth={2}
                  />
                ))}
              </svg>
              {hg ? (
                <Tip x={x(hg.strike)} y={y(hg.p ?? 0.5)} w={w}>
                  <div className="mb-1 font-semibold text-ink">{symName(curve.sym)} above <span className="num">{fmtStrike(hg.strike)}</span> at expiry?</div>
                  <TipRow k={`Model chance, P(S_T > K)`} v={hg.p != null ? `${pct(hg.p)} ± ${pct(hg.band)}` : "—"} color="var(--brand)" />
                  {hg.quotes.map((q) => {
                    const edgeYes = hg.p != null && q.ask != null ? hg.p - q.ask : null;
                    const edgeNo = hg.p != null && q.bid != null ? q.bid - hg.p : null;
                    return (
                      <div key={q.cid ?? q.venue}>
                        <TipRow k={`${venueLabel(q.venue)} buy / sell YES`} v={`${cents(q.ask)} / ${cents(q.bid)}`} color={venueColor(q.venue)} />
                        <TipRow k="gap before fees YES / NO" v={`${edgeCents(edgeYes)} / ${edgeCents(edgeNo)}`} />
                      </div>
                    );
                  })}
                </Tip>
              ) : null}
            </>
          );
        }}
      </ChartBox>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Legend
          items={[
            { label: `Model chance (${m.label.toLowerCase()})`, color: "var(--brand)" },
            { label: "model error band", color: "var(--band)", kind: "box" },
            { label: "Kalshi price (bid–ask)", color: "var(--kalshi)", kind: "whisker" },
            { label: "Polymarket price (bid–ask)", color: "var(--poly)", kind: "whisker" },
            { label: `${symName(curve.sym)} now`, color: "var(--ink-2)", kind: "dash" },
          ]}
        />
        {signals.length ? <span className="text-[11.5px] text-brand">Shaded: strikes with a live trade signal.</span> : <span className="text-[11.5px] text-ink-3">Hover a strike for prices. No live signal on this expiry.</span>}
      </div>
    </div>
  );
}
