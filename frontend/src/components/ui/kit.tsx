"use client";

import { clsx, type ClassValue } from "clsx";
import { ArrowDownRight, ArrowUpRight, Loader2, Minus } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { venueLabel } from "@/lib/format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {sub ? <p className="mt-0.5 max-w-3xl text-[13px] leading-relaxed text-ink-2">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function Panel({
  title, right, children, className, bodyClass, testId, sub,
}: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; testId?: string; sub?: ReactNode;
}) {
  return (
    <section data-testid={testId} className={cn("min-w-0 rounded-md border border-line bg-panel", className)}>
      {title || right ? (
        <header className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3.5 py-2">
          <div className="min-w-0">
            <h2 className="label">{title}</h2>
            {sub ? <p className="mt-0.5 text-[12px] text-ink-3">{sub}</p> : null}
          </div>
          {right ? <div className="flex items-center gap-2">{right}</div> : null}
        </header>
      ) : null}
      <div className={cn("p-3.5", bodyClass)}>{children}</div>
    </section>
  );
}

export function Kpi({
  label, value, sub, tone, testId, icon,
}: { label: string; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg" | "brand"; testId?: string; icon?: ReactNode }) {
  return (
    <div data-testid={testId ?? "kpi"} className="min-w-0 rounded-md border border-line bg-panel px-3.5 py-3">
      <div className="label flex items-center gap-1.5">{icon}{label}</div>
      <div
        className={cn(
          "num mt-1.5 truncate text-[22px] font-medium leading-none tracking-tight",
          tone === "pos" && "text-pos", tone === "neg" && "text-neg", tone === "brand" && "text-brand",
        )}
      >
        {value}
      </div>
      {sub ? <div className="num mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-ink-3">{sub}</div> : null}
    </div>
  );
}

/** Coloured signed value with an arrow, so gain/loss never relies on colour alone. */
export function Signed({ value, children, arrow = true, className }: { value: number | null | undefined; children: ReactNode; arrow?: boolean; className?: string }) {
  const s = value == null || !Number.isFinite(value) ? 0 : value > 0 ? 1 : value < 0 ? -1 : 0;
  const Icon = s > 0 ? ArrowUpRight : s < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn("num inline-flex items-center gap-0.5 whitespace-nowrap", s > 0 && "text-pos", s < 0 && "text-neg", s === 0 && "text-ink-2", className)}>
      {arrow && value != null ? <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.4} /> : null}
      {children}
    </span>
  );
}

export function VenueTag({ venue, short }: { venue?: string | null; short?: boolean }) {
  const k = venue === "kalshi";
  const p = venue === "polymarket";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-2">
      <span
        aria-hidden
        className={cn("inline-block size-2 shrink-0 rounded-[2px]", k && "bg-kalshi", p && "bg-poly", !k && !p && "bg-ink-3")}
      />
      {short ? (k ? "KX" : p ? "PM" : venueLabel(venue)) : venueLabel(venue)}
    </span>
  );
}

export function SideChip({ side, testId }: { side?: string | null; testId?: string }) {
  if (!side) return <span className="text-ink-3">—</span>;
  const yes = side === "yes";
  return (
    <span
      data-testid={testId}
      className={cn(
        "num inline-flex shrink-0 items-center whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide",
        yes ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg",
      )}
    >
      BUY {yes ? "YES" : "NO"}
    </span>
  );
}

export function Badge({ children, tone = "muted", className, testId }: { children: ReactNode; tone?: "muted" | "brand" | "pos" | "neg" | "warn"; className?: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]",
        tone === "muted" && "border-line bg-panel-2 text-ink-2",
        tone === "brand" && "border-brand/30 bg-brand-soft text-brand",
        tone === "pos" && "border-pos/30 bg-pos-soft text-pos",
        tone === "neg" && "border-neg/30 bg-neg-soft text-neg",
        tone === "warn" && "border-warn/30 bg-warn-soft text-warn",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ ok, warn, className }: { ok?: boolean | null; warn?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", ok ? (warn ? "bg-warn" : "bg-pos") : "bg-neg", className)}
    />
  );
}

export function Button({
  variant = "default", size = "md", className, loading, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-8 px-3 text-[13px]",
        size === "lg" && "h-11 px-5 text-[14px]",
        variant === "default" && "border-line bg-panel text-ink hover:bg-panel-2",
        variant === "primary" && "border-brand bg-brand text-brand-ink hover:opacity-90",
        variant === "danger" && "border-kill bg-kill text-white hover:opacity-90",
        variant === "ghost" && "border-transparent bg-transparent text-ink-2 hover:bg-panel-2 hover:text-ink",
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value, onChange, options, testIdPrefix, size = "sm",
}: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; testIdPrefix?: string; size?: "sm" | "md" }) {
  return (
    <div role="tablist" className="no-scrollbar inline-flex max-w-full overflow-x-auto rounded-[5px] border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "whitespace-nowrap rounded-[3px] px-2.5 font-medium transition-colors",
            size === "sm" ? "h-6 text-[12px]" : "h-7 text-[13px]",
            value === o.value ? "bg-panel text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-24 items-center justify-center px-4 py-6 text-center text-[12.5px] text-ink-3", className)}>{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" data-testid="api-error" className="mb-3 rounded-md border border-neg/30 bg-neg-soft px-3 py-2 text-[12.5px] text-neg">
      {error}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 text-[12.5px] text-ink-3">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

/** Key/value rows in a compact definition list. */
export function Stats({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]", className)}>
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="num truncate text-right text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Horizontal usage bar (exposure vs cap). */
export function UsageBar({ used, cap, testId }: { used: number; cap: number; testId?: string }) {
  const r = cap > 0 ? used / cap : 0;
  const tone = r >= 0.9 ? "bg-neg" : r >= 0.7 ? "bg-warn" : "bg-pos";
  return (
    <div data-testid={testId} className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-grid" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, r * 100))}%` }} />
      </div>
      <span className="num w-10 text-right text-[11px] text-ink-2">{Math.round(r * 100)}%</span>
    </div>
  );
}

/* Tables -------------------------------------------------------------------------------------- */

export function Table({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={cn("-mx-3.5 overflow-x-auto", className)}>
      <table data-testid={testId} className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  );
}

export function Th({ children, right, className, ...rest }: { children?: ReactNode; right?: boolean; className?: string } & React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      className={cn(
        "label whitespace-nowrap border-b border-line bg-panel-2 px-2 py-1.5 font-semibold first:pl-3.5 last:pr-3.5",
        right ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, right, className, mono, ...rest }: { children?: ReactNode; right?: boolean; className?: string; mono?: boolean } & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...rest}
      className={cn(
        "whitespace-nowrap border-b border-line/70 px-2 py-[5px] first:pl-3.5 last:pr-3.5",
        right && "text-right",
        (mono || right) && "num",
        className,
      )}
    >
      {children}
    </td>
  );
}
