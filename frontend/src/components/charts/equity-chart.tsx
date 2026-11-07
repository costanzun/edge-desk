"use client";

import { useState } from "react";
import { toMs, usd, utcDate, utcTime } from "@/lib/format";
import type { EquityPoint } from "@/lib/types";
import { ChartBox, extent, GridY, linear, niceTicks, pathOf, Tip, TipRow } from "./core";

/** Equity line (top) with the drawdown underwater area (bottom), shared time axis. */
export function EquityChart({ points, height = 300, bankroll, testId = "equity-chart" }: { points: EquityPoint[]; height?: number; bankroll?: number; testId?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = points
    .map((p) => ({ ...p, t: toMs(p.t) ?? 0 }))
    .filter((p) => Number.isFinite(p.equity))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return <div className="flex h-40 items-center justify-center text-[12.5px] text-ink-3">Not enough fills yet to draw an equity curve.</div>;

  return (
    <ChartBox height={height} testId={testId} label="Equity curve and drawdown">
      {(w) => {
        const M = { l: 62, r: 12, t: 10, b: 26 };
        const ddH = Math.round((height - M.t - M.b) * 0.28);
        const eqBottom = height - M.b - ddH - 14;
        const [t0, t1] = extent(pts.map((p) => p.t));
        const x = linear([t0, t1], [M.l, w - M.r]);
        let [e0, e1] = extent([...pts.map((p) => p.equity), bankroll]);
        const pad = (e1 - e0 || 100) * 0.08;
        e0 -= pad;
        e1 += pad;
        const y = linear([e0, e1], [eqBottom, M.t]);
        const ddMin = Math.min(-1, ...pts.map((p) => p.drawdown ?? 0));
        const yd = linear([ddMin * 1.1, 0], [height - M.b, height - M.b - ddH]);
        const line = pathOf(pts.map((p) => [x(p.t), y(p.equity)]));
        const area = `${line}L${x(t1)},${eqBottom}L${x(t0)},${eqBottom}Z`;
        const dd = `${pathOf(pts.map((p) => [x(p.t), yd(p.drawdown ?? 0)]))}L${x(t1)},${yd(0)}L${x(t0)},${yd(0)}Z`;
        const yt = niceTicks(e0, e1, 4);
        const span = t1 - t0;
        const xt = niceTicks(t0, t1, Math.max(2, Math.floor(w / 140)));
        const fmtT = (t: number) => (span > 36 * 3600e3 ? utcDate(t).replace(" UTC", "") : utcTime(t, false).replace(" UTC", ""));
        const hp = hover != null ? pts[hover] : null;
        const last = pts[pts.length - 1];

        function onMove(e: React.PointerEvent<SVGSVGElement>) {
          const r = e.currentTarget.getBoundingClientRect();
          const t = x.invert(e.clientX - r.left);
          let best = 0;
          for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
          setHover(best);
        }

        return (
          <>
            <svg width={w} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
              <defs>
                <linearGradient id={`${testId}-g`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--brand)" stopOpacity="0.18" />
                  <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <GridY ticks={yt} y={y} x0={M.l} x1={w - M.r} fmt={(v) => usd(v, { digits: 0 })} />
              {bankroll ? (
                <g>
                  <line x1={M.l} x2={w - M.r} y1={y(bankroll)} y2={y(bankroll)} style={{ stroke: "var(--ink-3)" }} strokeDasharray="2 3" />
                  <text x={w - M.r} y={y(bankroll) - 4} textAnchor="end">start {usd(bankroll, { digits: 0 })}</text>
                </g>
              ) : null}
              <path d={area} style={{ fill: `url(#${testId}-g)` }} />
              <path d={line} fill="none" style={{ stroke: "var(--brand)" }} strokeWidth={1.8} strokeLinejoin="round" />
              <circle cx={x(last.t)} cy={y(last.equity)} r={3} style={{ fill: "var(--brand)" }} />
              <text x={M.l - 6} y={yd(0) + 3} textAnchor="end">0</text>
              <text x={M.l - 6} y={yd(ddMin) + 3} textAnchor="end">{usd(ddMin, { digits: 0 })}</text>
              <text x={M.l} y={yd(0) - 4}>drawdown</text>
              <line x1={M.l} x2={w - M.r} y1={yd(0)} y2={yd(0)} style={{ stroke: "var(--line)" }} />
              <path d={dd} style={{ fill: "var(--neg)", opacity: 0.35 }} />
              {xt.map((t) => (
                <text key={t} x={x(t)} y={height - 8} textAnchor="middle">{fmtT(t)}</text>
              ))}
              {hp ? (
                <g>
                  <line x1={x(hp.t)} x2={x(hp.t)} y1={M.t} y2={height - M.b} style={{ stroke: "var(--ink-3)" }} opacity={0.5} />
                  <circle cx={x(hp.t)} cy={y(hp.equity)} r={4} style={{ fill: "var(--panel)", stroke: "var(--brand)" }} strokeWidth={2} />
                </g>
              ) : null}
            </svg>
            {hp ? (
              <Tip x={x(hp.t)} y={y(hp.equity)} w={w}>
                <div className="num mb-1 text-ink-2">{utcDate(hp.t)}</div>
                <TipRow k="equity" v={usd(hp.equity)} color="var(--brand)" />
                <TipRow k="drawdown" v={usd(hp.drawdown ?? 0)} color="var(--neg)" />
                {hp.mark ? <div className="mt-1 text-[10.5px] text-ink-3">includes open positions at mark</div> : null}
              </Tip>
            ) : null}
          </>
        );
      }}
    </ChartBox>
  );
}
