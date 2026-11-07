"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import type { Attr, Dist } from "@/lib/types";
import { ChartBox, GridY, linear, niceTicks, Tip, TipRow } from "./core";

/* Histogram ---------------------------------------------------------------------------------- */

/** Histogram over variable-width bins, drawn as equal-width categories (bins are log-spaced).
 *  Empty bins at both ends are trimmed (one kept on each side for context). */
export function Histogram({
  dist, unit, height = 120, color = "var(--brand)", testId,
}: { dist: Dist; unit: (v: number) => string; height?: number; color?: string; testId?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const all = dist.hist ?? [];
  if (!all.length || !dist.n) return <div className="flex items-center justify-center text-[12px] text-ink-3" style={{ height }}>No samples yet.</div>;
  const first = Math.max(0, all.findIndex((b) => b.n > 0) - 1);
  let last = all.length - 1;
  while (last > 0 && all[last].n === 0) last--;
  const bins = all.slice(first, Math.min(all.length, last + 2));
  const total = bins.reduce((a, b) => a + b.n, 0) || 1;
  const label = (b: { lo: number; hi: number | null }) => (b.hi == null ? `≥ ${unit(b.lo)}` : `${unit(b.lo)} – ${unit(b.hi)}`);
  const tick = (v: number) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : String(v));

  return (
    <ChartBox height={height} testId={testId} label="Latency histogram">
      {(w) => {
        const M = { l: 4, r: 4, t: 14, b: 16 };
        const bw = (w - M.l - M.r) / bins.length;
        const maxN = Math.max(...bins.map((b) => b.n), 1);
        const y = linear([0, maxN], [height - M.b, M.t]);
        const hb = hover != null ? bins[hover] : null;
        return (
          <>
            <svg width={w} height={height} className="block" onPointerLeave={() => setHover(null)}>
              {bins.map((b, i) => {
                const h = height - M.b - y(b.n);
                return (
                  <g key={i} onPointerEnter={() => setHover(i)}>
                    <rect x={M.l + i * bw} y={M.t} width={bw} height={height - M.t - M.b} fill="transparent" />
                    <rect
                      x={M.l + i * bw + 1}
                      y={b.n ? Math.min(y(b.n), height - M.b - 1.5) : height - M.b}
                      width={Math.max(1, bw - 2)}
                      height={b.n ? Math.max(1.5, h) : 0}
                      rx={1.5}
                      style={{ fill: color, opacity: hover == null || hover === i ? 0.85 : 0.45 }}
                    />
                    {b.n ? (
                      <text x={M.l + i * bw + bw / 2} y={y(b.n) - 3} textAnchor="middle" style={{ fontSize: 9, fill: "var(--ink-2)" }}>
                        {((b.n / total) * 100).toFixed(0)}%
                      </text>
                    ) : null}
                  </g>
                );
              })}
              <line x1={M.l} x2={w - M.r} y1={height - M.b} y2={height - M.b} style={{ stroke: "var(--line)" }} />
              {bins.map((b, i) => (
                <text key={i} x={M.l + i * bw + 1} y={height - 4} textAnchor="start" style={{ fontSize: 9 }}>{tick(b.lo)}</text>
              ))}
            </svg>
            {hb ? (
              <Tip x={M.l + (hover as number) * bw + bw / 2} y={10} w={w}>
                <TipRow k="range" v={label(hb)} />
                <TipRow k="samples" v={hb.n.toLocaleString("en-US")} />
                <TipRow k="share" v={`${((hb.n / total) * 100).toFixed(1)}%`} />
              </Tip>
            ) : null}
          </>
        );
      }}
    </ChartBox>
  );
}

/* Waterfall ---------------------------------------------------------------------------------- */

export const ATTR_KEYS: { key: keyof Attr; label: string; hint: string }[] = [
  { key: "edge", label: "Edge", hint: "Expected value at decision: (model prob − price) × contracts" },
  { key: "latency", label: "Latency", hint: "Price moved between decision and arrival at the venue" },
  { key: "slippage", label: "Slippage", hint: "Filled worse than the touch at arrival (depth)" },
  { key: "fees", label: "Fees", hint: "Venue taker fees" },
  { key: "model_luck", label: "Model/luck", hint: "Realised outcome vs model probability (settlement noise + model error)" },
];

/** P&L attribution waterfall: edge, latency, slippage, fees, model/luck, = net. */
export function Waterfall({ total, height = 260, testId = "waterfall" }: { total: Attr; height?: number; testId?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const steps: { label: string; hint: string; v: number; from: number; to: number; net?: boolean }[] = [];
  let run = 0;
  for (const k of ATTR_KEYS) {
    const v = Number(total[k.key] ?? 0);
    steps.push({ label: k.label, hint: k.hint, v, from: run, to: run + v });
    run += v;
  }
  steps.push({ label: "Net", hint: "Sum of the components", v: run, from: 0, to: run, net: true });

  return (
    <ChartBox height={height} testId={testId} label="P&L attribution waterfall">
      {(w) => {
        const M = { l: 62, r: 10, t: 18, b: 30 };
        const vals = steps.flatMap((s) => [s.from, s.to]);
        let lo = Math.min(0, ...vals);
        let hi = Math.max(0, ...vals);
        const pad = (hi - lo || 1) * 0.08;
        lo -= lo < 0 ? pad : 0;
        hi += pad;
        const y = linear([lo, hi], [height - M.b, M.t]);
        const slot = (w - M.l - M.r) / steps.length;
        const bw = Math.min(64, slot * 0.62);
        const hs = hover != null ? steps[hover] : null;
        return (
          <>
            <svg width={w} height={height} className="block" onPointerLeave={() => setHover(null)}>
              <GridY ticks={niceTicks(lo, hi, 4)} y={y} x0={M.l} x1={w - M.r} fmt={(v) => usd(v, { digits: 0 })} zero />
              {steps.map((s, i) => {
                const cx = M.l + slot * i + slot / 2;
                const top = y(Math.max(s.from, s.to));
                const h = Math.max(1.5, Math.abs(y(s.from) - y(s.to)));
                const fill = s.net ? "var(--brand)" : s.v >= 0 ? "var(--pos)" : "var(--neg)";
                const next = steps[i + 1];
                return (
                  <g key={s.label} onPointerEnter={() => setHover(i)} data-testid="waterfall-bar">
                    <rect x={cx - slot / 2} y={M.t} width={slot} height={height - M.t - M.b} fill="transparent" />
                    <rect x={cx - bw / 2} y={top} width={bw} height={h} rx={2} style={{ fill, opacity: hover == null || hover === i ? 0.78 : 0.5 }} />
                    {next && !s.net ? (
                      <line x1={cx + bw / 2} x2={cx + slot - bw / 2} y1={y(s.to)} y2={y(s.to)} style={{ stroke: "var(--ink-3)" }} strokeDasharray="2 2" />
                    ) : null}
                    <text x={cx} y={top - 5} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 10.5 }}>
                      {s.net ? usd(s.v, { digits: 0 }) : `${s.v >= 0 ? "+" : "−"}${usd(Math.abs(s.v), { digits: 0 })}`}
                    </text>
                    <text x={cx} y={height - 10} textAnchor="middle" style={{ fill: s.net ? "var(--ink)" : "var(--ink-2)", fontSize: 10.5, fontWeight: s.net ? 600 : 400 }}>
                      {w < 420 ? s.label.split(" ")[0] : s.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            {hs ? (
              <Tip x={M.l + slot * (hover as number) + slot / 2} y={y(Math.max(hs.from, hs.to))} w={w}>
                <div className="mb-1 font-semibold text-ink">{hs.label}</div>
                <TipRow k="contribution" v={usd(hs.v, { sign: true })} />
                {!hs.net ? <TipRow k="running total" v={usd(hs.to)} /> : null}
                <div className="mt-1 max-w-56 whitespace-normal text-[10.5px] leading-snug text-ink-3">{hs.hint}</div>
              </Tip>
            ) : null}
          </>
        );
      }}
    </ChartBox>
  );
}

/* Range bars (per-hop latency) --------------------------------------------------------------- */

/** One row per hop: bar p50 → p99 on a log axis with a p95 tick. */
export function RangeBars({ rows, unit, testId }: { rows: { name: string; d: Dist }[]; unit: (v: number) => string; testId?: string }) {
  const valid = rows.filter((r) => r.d.n && r.d.p50 != null);
  const rowH = 26;
  const height = Math.max(60, valid.length * rowH + 30);
  if (!valid.length) return <div className="py-6 text-center text-[12px] text-ink-3">No timing samples yet.</div>;
  return (
    <ChartBox height={height} testId={testId} label="Per-hop latency, p50 to p99">
      {(w) => {
        const M = { l: 62, r: 64, t: 6, b: 22 };
        const lo = Math.max(0.1, Math.min(...valid.map((r) => r.d.p50 as number)) / 2);
        const hi = Math.max(...valid.map((r) => (r.d.p99 ?? r.d.p95 ?? r.d.p50) as number)) * 1.5;
        const lx = (v: number) => Math.log10(Math.max(lo, v));
        const x = linear([lx(lo), lx(hi)], [M.l, w - M.r]);
        const X = (v: number) => x(lx(v));
        const ticks = [0.1, 1, 10, 100, 1000, 10000].filter((t) => t >= lo && t <= hi);
        return (
          <svg width={w} height={height} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={X(t)} x2={X(t)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--grid)" }} />
                <text x={X(t)} y={height - 6} textAnchor="middle">{unit(t)}</text>
              </g>
            ))}
            {valid.map((r, i) => {
              const cy = M.t + i * rowH + rowH / 2;
              const p50 = r.d.p50 as number;
              const p95 = r.d.p95 ?? p50;
              const p99 = r.d.p99 ?? p95;
              return (
                <g key={r.name} data-testid="hop-row">
                  <text x={M.l - 8} y={cy} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink)", fontSize: 11, fontFamily: "var(--font-sans)" }}>{r.name}</text>
                  <rect x={X(p50)} y={cy - 5} width={Math.max(2, X(p99) - X(p50))} height={10} rx={2} style={{ fill: "var(--brand)", opacity: 0.25 }} />
                  <rect x={X(p50)} y={cy - 5} width={Math.max(2, X(p95) - X(p50))} height={10} rx={2} style={{ fill: "var(--brand)", opacity: 0.45 }} />
                  <line x1={X(p50)} x2={X(p50)} y1={cy - 8} y2={cy + 8} style={{ stroke: "var(--brand)" }} strokeWidth={2.5} />
                  <text x={X(p99) + 6} y={cy} dy="0.32em" style={{ fill: "var(--ink-2)" }}>{unit(p50)}</text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </ChartBox>
  );
}
