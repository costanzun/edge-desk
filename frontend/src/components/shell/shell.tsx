"use client";

import {
  Activity, ChevronsLeft, ChevronsRight, FlaskConical, Gauge, History, Menu, Moon, Scale, Settings2, ShieldAlert, Sun, Timer,
  Wallet, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";
import { Badge, cn } from "@/components/ui/kit";
import { API_URL, MOCK } from "@/lib/api";
import { useDesk } from "@/lib/desk-context";
import { age, ms, price } from "@/lib/format";
import { HeaderKillSwitch } from "./kill-switch";

const NAV = [
  { href: "/", label: "Desk", icon: Activity },
  { href: "/positions", label: "Positions & P&L", icon: Wallet },
  { href: "/latency", label: "Latency", icon: Timer },
  { href: "/risk", label: "Risk", icon: ShieldAlert },
  { href: "/capital", label: "Capital", icon: Scale },
  { href: "/models", label: "Models", icon: Gauge },
  { href: "/replay", label: "Replay", icon: History },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--brand)" />
      <path d="M9 8.5h12M9 16h8.5M9 23.5h6.5M9 8.5v15" stroke="var(--brand-ink)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M18.5 22l2.8 2.6 4.4-6.4" stroke="var(--brand-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function NavLinks({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            data-testid={`nav-${href === "/" ? "desk" : href.slice(1)}`}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
            className={cn(
              "group relative flex h-8 items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] transition-colors",
              active ? "bg-brand-soft font-medium text-ink" : "text-ink-2 hover:bg-panel-2 hover:text-ink",
              collapsed && "justify-center px-0",
            )}
          >
            {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-brand" /> : null}
            <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "text-ink-3 group-hover:text-ink-2")} />
            {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="Edge Desk home">
      <Logo className="size-7 shrink-0" />
      {collapsed ? null : (
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight">Edge Desk</div>
          <div className="text-[10.5px] text-ink-3">prediction markets vs options</div>
        </div>
      )}
    </Link>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle light / dark theme"
      className="inline-flex size-7 items-center justify-center rounded-[5px] border border-line bg-panel text-ink-2 hover:text-ink"
    >
      <Moon className="size-3.5 dark:hidden" />
      <Sun className="hidden size-3.5 dark:block" />
    </button>
  );
}

const MODE_TONE: Record<string, "pos" | "brand" | "warn" | "muted"> = { live: "pos", replay: "brand", synthetic: "warn", mock: "muted" };

function ModeBadge() {
  const { mode, error } = useDesk();
  const m = error && !MOCK ? "offline" : mode || "…";
  return (
    <Badge testId="mode-badge" tone={m === "offline" ? "neg" : MODE_TONE[m] ?? "muted"} className="num">
      {m === "live" ? <span className="live-dot inline-block size-1.5 rounded-full bg-pos" /> : null}
      {m}
    </Badge>
  );
}

const SPOT_LABEL: Record<string, string> = { coinbase: "Coinbase", binance: "Binance", deribit: "Deribit idx" };

/** Spot prices and feed lights. */
function Ticker({ testId = "ticker" }: { testId?: string }) {
  const { desk } = useDesk();
  const spots = Object.entries(desk?.spots ?? {})
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => (a.split(":")[1] ?? "").localeCompare(b.split(":")[1] ?? "") || a.localeCompare(b));
  const feeds = desk?.feeds ?? [];
  return (
    <div data-testid={testId} className="no-scrollbar flex min-w-0 items-center gap-4 overflow-x-auto text-[12px]">
      {spots.length === 0 ? <span className="text-ink-3">waiting for spot prices…</span> : null}
      {spots.map(([k, v]) => {
        const [src, sym] = k.split(":");
        return (
          <span key={k} className="flex shrink-0 items-baseline gap-1.5" data-testid="spot">
            <span className="font-semibold text-ink">{sym ?? k}</span>
            <span className="num text-ink">{price(v as number)}</span>
            <span className="text-[10.5px] text-ink-3">{SPOT_LABEL[src] ?? src}</span>
          </span>
        );
      })}
      {feeds.length ? <span aria-hidden className="h-4 w-px shrink-0 bg-line" /> : null}
      <span className="flex shrink-0 items-center gap-2.5">
        {feeds.map((f) => {
          const stale = (f.last_msg_age_s ?? 0) > 30;
          return (
            <span
              key={f.name}
              className="flex items-center gap-1 text-[11px] text-ink-2"
              title={`${f.name}: ${f.ok ? "ok" : f.reason || "down"} · last msg ${age(f.last_msg_age_s)} ago · rtt ${ms(f.rtt_ms)}`}
            >
              <span className={cn("inline-block size-1.5 rounded-full", !f.ok ? "bg-neg" : stale ? "bg-warn" : "bg-pos")} />
              {f.name}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function HaltBanner() {
  const { halted, haltReason } = useDesk();
  if (!halted) return null;
  return (
    <div
      role="alert"
      data-testid="halt-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kill/40 bg-kill px-4 py-1.5 text-[12.5px] text-white"
    >
      <span className="font-bold uppercase tracking-[0.1em]">Trading halted</span>
      <span className="opacity-90">{haltReason || "kill switch engaged"}</span>
      <Link href="/risk" className="ml-auto underline underline-offset-2 opacity-90 hover:opacity-100">Risk controls →</Link>
    </div>
  );
}

function OfflineBanner() {
  const { error, desk } = useDesk();
  if (!error || MOCK) return null;
  return (
    <div role="status" className="border-b border-warn/40 bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn">
      {desk ? "Lost contact with the API, showing the last data received. " : ""}
      {error} <span className="text-ink-3">({API_URL})</span>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="flex min-h-dvh">
      {/* sidebar (desktop) */}
      <aside
        data-testid="sidebar"
        className={cn("hidden shrink-0 border-r border-line bg-panel lg:block", collapsed ? "w-[60px]" : "w-[214px]")}
      >
       <div className={cn("sticky top-0 flex h-dvh flex-col", collapsed ? "px-2" : "px-3")}>
        <div className={cn("flex h-14 items-center", collapsed && "justify-center")}>
          <Brand collapsed={collapsed} />
        </div>
        <NavLinks collapsed={collapsed} />
        <div className="mt-auto space-y-2 pb-3">
          {collapsed ? null : (
            <div className="rounded-[5px] border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-snug text-ink-3">
              Paper trading research. No real orders, no accounts, public market data only.
            </div>
          )}
          <button
            type="button"
            data-testid="sidebar-collapse"
            onClick={() => setCollapsed((c) => !c)}
            className={cn("flex h-7 w-full items-center gap-2 rounded-[5px] px-2.5 text-[12px] text-ink-3 hover:bg-panel-2 hover:text-ink", collapsed && "justify-center px-0")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
          </button>
        </div>
       </div>
      </aside>

      {/* drawer (mobile) */}
      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
          <div data-testid="nav-drawer" className="fade-in absolute inset-y-0 left-0 flex w-[260px] flex-col border-r border-line bg-panel px-3">
            <div className="flex h-14 items-center justify-between">
              <Brand />
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded p-1.5 text-ink-2 hover:bg-panel-2">
                <X className="size-4" />
              </button>
            </div>
            <NavLinks onNavigate={() => setDrawer(false)} />
            <p className="mt-auto pb-4 text-[11px] leading-snug text-ink-3">Paper trading research. No real orders. Public market data only.</p>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-panel/95 backdrop-blur supports-[backdrop-filter]:bg-panel/85">
          <div className="flex h-12 items-center gap-3 px-3 sm:px-4">
            <button
              type="button"
              data-testid="nav-open"
              onClick={() => setDrawer(true)}
              aria-label="Open menu"
              className="-ml-1 rounded p-1.5 text-ink-2 hover:bg-panel-2 lg:hidden"
            >
              <Menu className="size-5" />
            </button>
            <div className="lg:hidden"><Logo className="size-6" /></div>
            <div className="hidden min-w-0 flex-1 md:block"><Ticker /></div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Badge testId="paper-badge" tone="brand" className="hidden sm:inline-flex">
                <FlaskConical className="size-3" /> Paper only · not investment advice
              </Badge>
              <Badge tone="brand" className="sm:hidden">Paper only</Badge>
              <ModeBadge />
              <HeaderKillSwitch />
              <ThemeToggle />
            </div>
          </div>
          <div className="border-t border-line px-3 py-1.5 md:hidden"><Ticker testId="ticker-mobile" /></div>
        </header>
        <HaltBanner />
        <OfflineBanner />
        <main id="main" className="min-w-0 flex-1 px-3 py-4 sm:px-5 sm:py-5">{children}</main>
        <footer className="border-t border-line px-4 py-3 text-[11.5px] text-ink-3 sm:px-5">
          Paper trading research. No real orders. Public market data only. Not investment advice.
          <span className="float-right hidden sm:inline">Edge Desk · Costantino Zunino</span>
        </footer>
      </div>
    </div>
  );
}
