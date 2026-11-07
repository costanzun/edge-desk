"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Width of a container, tracked with ResizeObserver. */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.floor(entries[0]?.contentRect.width ?? 0);
      setW((prev) => (prev === cw ? prev : cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export type Scale = ((v: number) => number) & { invert: (px: number) => number; domain: [number, number] };

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  f.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k);
  f.domain = domain;
  return f;
}

/** Symmetric log-ish scale for 0 ms .. 60 s: x -> log10(1 + x / c). */
export function symlog(domain: [number, number], range: [number, number], c = 100): Scale {
  const t = (v: number) => Math.log10(1 + Math.max(0, v) / c);
  const inner = linear([t(domain[0]), t(domain[1])], range);
  const f = ((v: number) => inner(t(v))) as Scale;
  f.invert = (px: number) => (10 ** inner.invert(px) - 1) * c;
  f.domain = domain;
  return f;
}

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function extent(values: (number | null | undefined)[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

export const pathOf = (pts: [number, number][]) =>
  pts.length ? `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}` : "";

/** Container: fixed height, responsive width; renders children only once width is known. */
export function ChartBox({
  height, children, className, testId, label,
}: { height: number; children: (w: number) => ReactNode; className?: string; testId?: string; label?: string }) {
  const [ref, w] = useWidth();
  return (
    <div ref={ref} data-testid={testId} className={`chart relative w-full ${className ?? ""}`} style={{ height }} role="img" aria-label={label}>
      {w > 0 ? children(w) : null}
    </div>
  );
}

/** Floating tooltip inside a ChartBox (positioned relative to it). */
export function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const right = x > w * 0.6;
  return (
    <div
      data-testid="chart-tooltip"
      className="pointer-events-none absolute z-10 min-w-36 rounded-[5px] border border-line bg-panel px-2.5 py-2 text-[11.5px] shadow-lg"
      style={{ left: right ? undefined : x + 14, right: right ? w - x + 14 : undefined, top: Math.max(0, y - 10) }}
    >
      {children}
    </div>
  );
}

export function TipRow({ k, v, color, dash }: { k: ReactNode; v: ReactNode; color?: string; dash?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 leading-5">
      <span className="flex items-center gap-1.5 text-ink-3">
        {color ? (
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: dash ? `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 5px)` : color }} />
        ) : null}
        {k}
      </span>
      <span className="num text-ink">{v}</span>
    </div>
  );
}

/** Horizontal gridlines + left axis labels. */
export function GridY({ ticks, y, x0, x1, fmt, zero }: { ticks: number[]; y: Scale; x0: number; x1: number; fmt: (v: number) => string; zero?: boolean }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} style={{ stroke: zero && t === 0 ? "var(--ink-3)" : "var(--grid)" }} strokeWidth={1} shapeRendering="crispEdges" />
          <text x={x0 - 6} y={y(t)} dy="0.32em" textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
    </g>
  );
}

export function AxisX({ ticks, x, y, fmt, grid, top }: { ticks: number[]; x: Scale; y: number; fmt: (v: number) => string; grid?: boolean; top?: number }) {
  return (
    <g>
      <line x1={x.domain ? x(x.domain[0]) : 0} x2={x(x.domain[1])} y1={y} y2={y} style={{ stroke: "var(--line)" }} shapeRendering="crispEdges" />
      {ticks.map((t) => (
        <g key={t}>
          {grid && top != null ? <line x1={x(t)} x2={x(t)} y1={top} y2={y} style={{ stroke: "var(--grid)" }} shapeRendering="crispEdges" /> : null}
          <line x1={x(t)} x2={x(t)} y1={y} y2={y + 4} style={{ stroke: "var(--line)" }} />
          <text x={x(t)} y={y + 15} textAnchor="middle">{fmt(t)}</text>
        </g>
      ))}
    </g>
  );
}

export function Legend({ items }: { items: { label: ReactNode; color: string; kind?: "line" | "dash" | "box" | "bar" | "whisker"; onClick?: () => void; off?: boolean; testId?: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-ink-2">
      {items.map((it, i) => {
        const swatch =
          it.kind === "box" ? <span className="inline-block h-2.5 w-3.5 rounded-[2px]" style={{ background: it.color }} />
          : it.kind === "bar" ? <span className="inline-block size-2.5 rounded-[2px]" style={{ background: it.color }} />
          : it.kind === "whisker" ? (
            <svg width="10" height="12" aria-hidden><path d="M2 1h6M5 1v10M2 11h6" style={{ stroke: it.color }} strokeWidth="1.8" fill="none" /></svg>
          ) : it.kind === "dash" ? (
            <span className="inline-block h-0.5 w-4" style={{ background: `repeating-linear-gradient(90deg, ${it.color} 0 3px, transparent 3px 6px)` }} />
          ) : <span className="inline-block h-0.5 w-4 rounded" style={{ background: it.color }} />;
        const inner = <>{swatch}<span>{it.label}</span></>;
        return it.onClick ? (
          <button key={i} type="button" data-testid={it.testId} onClick={it.onClick} aria-pressed={!it.off} className={`flex items-center gap-1.5 rounded px-1 hover:bg-panel-2 ${it.off ? "opacity-35" : ""}`}>{inner}</button>
        ) : (
          <span key={i} className="flex items-center gap-1.5">{inner}</span>
        );
      })}
    </div>
  );
}
