"use client";

import { useState } from "react";
import { addedLatency, num, pct, strike as fmtStrike, usd } from "@/lib/format";
import type { AllocationOpp, DecayRow, ModelCal } from "@/lib/types";
import { AxisX, ChartBox, GridY, Legend, linear, niceTicks, pathOf, symlog, Tip, TipRow } from "./core";

/* Edge decay --------------------------------------------------------------------------------- */

/** Net P&L vs added latency on a log-ish axis (0 ms .. 60 s). */
export function EdgeDecayChart({ rows, height = 300, testId = "edge-decay-chart" }: { rows: DecayRow[]; height?: number; testId?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = rows.filter((r) => r.net != null).sort((a, b) => a.added_ms - b.added_ms);
  if (data.length < 2) return <div className="flex h-40 items-center justify-center text-[12.5px] text-ink-3">No edge-decay sweep yet: run one from Replay.</div>;
  return (
    <div>
      <ChartBox height={height} testId={testId} label="Net P&L as extra latency is added">
        {(w) => {
          const M = { l: 62, r: 24, t: 14, b: 32 };
          const maxMs = Math.max(...data.map((d) => d.added_ms), 1000);
          const x = symlog([0, maxMs], [M.l, w - M.r], 100);
          const vals = data.flatMap((d) => [d.net as number, d.expected_edge ?? 0]);
          let lo = Math.min(0, ...vals);
          let hi = Math.max(0, ...vals);
          const pad = (hi - lo || 1) * 0.1;
          lo -= lo < 0 ? pad : 0;
          hi += pad;
          const y = linear([lo, hi], [height - M.b, M.t]);
          const net = pathOf(data.map((d) => [x(d.added_ms), y(d.net as number)]));
          const exp = pathOf(data.filter((d) => d.expected_edge != null).map((d) => [x(d.added_ms), y(d.expected_edge as number)]));
          const base = data[0].net as number;
          const area = `${net}L${x(data[data.length - 1].added_ms)},${y(0)}L${x(data[0].added_ms)},${y(0)}Z`;
          const hd = hover != null ? data[hover] : null;
          function onMove(e: React.PointerEvent<SVGSVGElement>) {
            const r = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - r.left;
            let best = 0;
            data.forEach((d, i) => {
              if (Math.abs(x(d.added_ms) - px) < Math.abs(x(data[best].added_ms) - px)) best = i;
            });
            setHover(best);
          }
          return (
            <>
              <svg width={w} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
                <defs>
                  <clipPath id="decay-pos"><rect x={0} y={0} width={w} height={y(0)} /></clipPath>
                  <clipPath id="decay-neg"><rect x={0} y={y(0)} width={w} height={height} /></clipPath>
                </defs>
                <GridY ticks={niceTicks(lo, hi, 5)} y={y} x0={M.l} x1={w - M.r} fmt={(v) => usd(v, { digits: 0 })} zero />
                <AxisX ticks={data.map((d) => d.added_ms)} x={x} y={height - M.b} fmt={addedLatency} grid top={M.t} />
                <text x={w - M.r} y={height - 2} textAnchor="end">added latency (log scale)</text>
                <path d={area} clipPath="url(#decay-pos)" style={{ fill: "var(--pos)", opacity: 0.12 }} />
                <path d={area} clipPath="url(#decay-neg)" style={{ fill: "var(--neg)", opacity: 0.14 }} />
                {exp ? <path d={exp} fill="none" style={{ stroke: "var(--ink-3)" }} strokeDasharray="4 3" strokeWidth={1.4} /> : null}
                <path d={net} fill="none" style={{ stroke: "var(--brand)" }} strokeWidth={2.2} strokeLinejoin="round" />
                {data.map((d, i) => (
                  <circle
                    key={d.added_ms}
                    data-testid="decay-point"
                    cx={x(d.added_ms)}
                    cy={y(d.net as number)}
                    r={hover === i ? 5 : 3.5}
                    style={{ fill: (d.net as number) >= 0 ? "var(--panel)" : "var(--neg)", stroke: (d.net as number) >= 0 ? "var(--brand)" : "var(--neg)" }}
                    strokeWidth={2}
                  />
                ))}
                {hd ? <line x1={x(hd.added_ms)} x2={x(hd.added_ms)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--ink-3)" }} opacity={0.5} /> : null}
              </svg>
              {hd ? (
                <Tip x={x(hd.added_ms)} y={y(hd.net as number)} w={w}>
                  <div className="num mb-1 font-semibold text-ink">+{addedLatency(hd.added_ms)} latency</div>
                  <TipRow k="net P&L" v={usd(hd.net, { sign: true })} color="var(--brand)" />
                  <TipRow k="vs 0 ms" v={base ? pct((hd.net as number) / base, 0) : "—"} />
                  <TipRow k="expected edge" v={usd(hd.expected_edge)} color="var(--ink-3)" dash />
                  <TipRow k="trades" v={num(hd.trades)} />
                  <TipRow k="fees" v={usd(hd.fees)} />
                  <TipRow k="latency cost" v={usd(hd.latency_cost, { sign: true })} />
                </Tip>
              ) : null}
            </>
          );
        }}
      </ChartBox>
      <div className="mt-2">
        <Legend items={[{ label: "Net P&L after fees", color: "var(--brand)" }, { label: "Expected edge at decision", color: "var(--ink-3)", kind: "dash" }]} />
      </div>
    </div>
  );
}

/* Reliability diagram ------------------------------------------------------------------------ */

export const MODEL_COLOR: Record<string, string> = {
  p_options: "var(--m-options)",
  p_hybrid: "var(--m-hybrid)",
  p_realized: "var(--m-realized)",
  p_ensemble: "var(--m-ensemble)",
  mid: "var(--m-mid)",
  p_kumo: "var(--m-kumo)",
};
export const modelColor = (k: string) => MODEL_COLOR[k] ?? "var(--ink-2)";

export function ReliabilityDiagram({
  models, labels, hidden, height = 380,
}: { models: Record<string, ModelCal>; labels: Record<string, string>; hidden: Set<string>; height?: number }) {
  const [hover, setHover] = useState<{ k: string; i: number } | null>(null);
  const keys = Object.keys(models).filter((k) => !hidden.has(k));
  return (
    <ChartBox height={height} testId="reliability-chart" label="Reliability diagram: predicted probability vs observed frequency">
      {(w) => {
        const M = { l: 44, r: 14, t: 12, b: 36 };
        const size = Math.min(w - M.l - M.r, height - M.t - M.b);
        const x0 = M.l + Math.max(0, (w - M.l - M.r - size) / 2);
        const x = linear([0, 1], [x0, x0 + size]);
        const y = linear([0, 1], [M.t + size, M.t]);
        const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
        const maxN = Math.max(1, ...keys.flatMap((k) => (models[k].bins ?? []).map((b) => b.n)));
        const hb = hover ? models[hover.k]?.bins?.[hover.i] : null;
        return (
          <>
            <svg width={w} height={height} className="block" onPointerLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} style={{ stroke: "var(--grid)" }} />
                  <line x1={x(t)} x2={x(t)} y1={y(0)} y2={y(1)} style={{ stroke: "var(--grid)" }} />
                  <text x={x(0) - 6} y={y(t)} dy="0.32em" textAnchor="end">{t * 100}%</text>
                  <text x={x(t)} y={y(0) + 14} textAnchor="middle">{t * 100}%</text>
                </g>
              ))}
              <text x={x(0.5)} y={y(0) + 30} textAnchor="middle">predicted probability</text>
              <text x={x0 - 34} y={y(0.5)} textAnchor="middle" transform={`rotate(-90 ${x0 - 34} ${y(0.5)})`}>observed frequency</text>
              <line x1={x(0)} x2={x(1)} y1={y(0)} y2={y(1)} style={{ stroke: "var(--ink-3)" }} strokeDasharray="4 4" />
              <text x={x(0.62)} y={y(0.62)} dy={14} textAnchor="middle" transform={`rotate(-45 ${x(0.62)} ${y(0.62)})`} style={{ fontSize: 9.5 }}>perfect calibration</text>
              {keys.map((k) => {
                const bins = (models[k].bins ?? []).filter((b) => b.n > 0 && b.p_mean != null && b.y_rate != null);
                const d = pathOf(bins.map((b) => [x(b.p_mean as number), y(b.y_rate as number)]));
                const c = modelColor(k);
                return (
                  <g key={k} data-testid="reliability-series">
                    <path d={d} fill="none" style={{ stroke: c }} strokeWidth={k === "mid" ? 1.4 : 1.9} strokeDasharray={k === "mid" ? "4 3" : undefined} opacity={hover && hover.k !== k ? 0.3 : 0.95} />
                    {(models[k].bins ?? []).map((b, i) =>
                      b.n > 0 && b.p_mean != null && b.y_rate != null ? (
                        <circle
                          key={i}
                          cx={x(b.p_mean)}
                          cy={y(b.y_rate)}
                          r={2.2 + 3.2 * Math.sqrt(b.n / maxN)}
                          style={{ fill: c, stroke: "var(--panel)" }}
                          strokeWidth={1}
                          opacity={hover && hover.k !== k ? 0.25 : 0.9}
                          onPointerEnter={() => setHover({ k, i })}
                        />
                      ) : null,
                    )}
                  </g>
                );
              })}
            </svg>
            {hover && hb ? (
              <Tip x={x(hb.p_mean ?? 0)} y={y(hb.y_rate ?? 0)} w={w}>
                <div className="mb-1 font-semibold" style={{ color: modelColor(hover.k) }}>{labels[hover.k] ?? hover.k}</div>
                <TipRow k="bin" v={`${pct(hb.lo, 0)}–${pct(hb.hi, 0)}`} />
                <TipRow k="mean predicted" v={pct(hb.p_mean)} />
                <TipRow k="observed" v={pct(hb.y_rate)} />
                <TipRow k="snapshots" v={num(hb.n)} />
              </Tip>
            ) : null}
          </>
        );
      }}
    </ChartBox>
  );
}

/* Joint vs independent allocation ------------------------------------------------------------ */

export function AllocationBars({ opps }: { opps: AllocationOpp[] }) {
  const rows = [...opps].sort((a, b) => a.strike - b.strike);
  const rowH = 30;
  const height = rows.length * rowH + 30;
  return (
    <ChartBox height={height} testId="allocation-chart" label="Kelly stake per strike, independent vs joint">
      {(w) => {
        const M = { l: 112, r: 96, t: 4, b: 22 };
        const max = Math.max(0.001, ...rows.flatMap((r) => [r.independent, r.joint]));
        const x = linear([0, max * 1.05], [M.l, w - M.r]);
        const ticks = niceTicks(0, max * 1.05, Math.max(2, Math.floor(w / 120)));
        return (
          <svg width={w} height={height} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--grid)" }} />
                <text x={x(t)} y={height - 6} textAnchor="middle">{pct(t, t < 0.1 ? 1 : 0)}</text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cy = M.t + i * rowH + rowH / 2;
              return (
                <g key={r.id} data-testid="allocation-row">
                  <text x={M.l - 8} y={cy} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink)", fontSize: 10.5 }}>
                    {r.side.toUpperCase()} &gt;{fmtStrike(r.strike)}
                  </text>
                  <rect x={x(0)} y={cy - 9} width={Math.max(0, x(r.independent) - x(0))} height={8} rx={1.5} style={{ fill: "var(--ink-3)", opacity: 0.55 }} />
                  <rect x={x(0)} y={cy + 1} width={Math.max(0, x(r.joint) - x(0))} height={8} rx={1.5} style={{ fill: "var(--brand)" }} />
                  <text x={x(Math.max(r.independent, r.joint)) + 5} y={cy} dy="0.32em" style={{ fill: "var(--ink-2)", fontSize: 10 }}>
                    {pct(r.independent, 1)} → {pct(r.joint, 1)}
                  </text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </ChartBox>
  );
}
