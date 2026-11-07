"use client";

import {
  Activity, BookOpen, ChevronsLeft, ChevronsRight, FlaskConical, Gauge, History, LayoutGrid, Moon, Scale, Settings2, ShieldAlert, Sun, Timer,
  Wallet, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";
import { cn, feedStatus } from "@/components/ui/kit";
import { API_URL, MOCK } from "@/lib/api";
import { useDesk } from "@/lib/desk-context";
import { age, ms, price } from "@/lib/format";
import { HeaderKillSwitch } from "./kill-switch";

const NAV = [
  { href: "/", label: "Desk", icon: Activity },
  { href: "/how-it-works", label: "How it works", icon: BookOpen },
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
      <circle cx="16" cy="16" r="16" fill="#ff4a1c" />
      {[[10.5, 9.5], [15.5, 9.5], [20.5, 9.5], [10.5, 16], [15.5, 16], [10.5, 22.5], [15.5, 22.5], [20.5, 22.5]].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.8" fill="#fff" />
      ))}
    </svg>
  );
}

function NavLinks({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
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
              "group relative flex h-10 items-center gap-3 rounded-full px-3.5 text-[13.5px] transition-colors",
              active ? "bg-white/[0.07] font-medium text-white" : "text-nav-ink hover:bg-white/[0.04] hover:text-white",
              collapsed && "justify-center px-0",
            )}
          >
            <Icon className={cn("size-[18px] shrink-0", active ? "text-brand" : "text-nav-ink group-hover:text-white")} strokeWidth={active ? 2.2 : 1.8} />
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
          <div className="text-[14px] font-semibold tracking-tight text-white">Edge Desk</div>
          <div className="text-[10.5px] text-nav-ink">prediction markets vs options</div>
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
      className="inline-flex size-8 items-center justify-center rounded-full bg-panel text-ink-2 hover:text-ink"
    >
      <Moon className="size-3.5 dark:hidden" />
      <Sun className="hidden size-3.5 dark:block" />
    </button>
  );
}

/** Charcoal "TODAY"-style chip with the data mode. */
function ModeBadge() {
  const { mode, error } = useDesk();
  const m = error && !MOCK ? "offline" : mode || "…";
  return (
    <span
      data-testid="mode-badge"
      title="Data mode. LIVE: real-time public feeds. REPLAY: recorded data. SYNTHETIC: a generated market. MOCK: demo data for screenshots and tests."
      className={cn(
        "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[11px] font-semibold uppercase tracking-[0.12em]",
        m === "offline" ? "bg-kill text-white" : "bg-chip text-chip-ink",
      )}
    >
      {m === "live" ? <span className="live-dot inline-block size-1.5 rounded-full bg-brand" /> : null}
      {m}
    </span>
  );
}

const SPOT_LABEL: Record<string, string> = { coinbase: "Coinbase", binance: "Binance", deribit: "Deribit idx" };

/** Spot prices and feed lights. */
function Ticker({ testId = "ticker" }: { testId?: string }) {
  const { desk } = useDesk();
  const bySym = new Map<string, [string, number][]>();
  for (const [k, v] of Object.entries(desk?.spots ?? {})) {
    if (v == null) continue;
    const [src, sym = k] = k.split(":");
    bySym.set(sym, [...(bySym.get(sym) ?? []), [src, v]]);
  }
  const feeds = desk?.feeds ?? [];
  const live = feeds.filter((f) => feedStatus(f) === "live").length;
  const worst = feeds.some((f) => feedStatus(f) === "down") ? "down" : feeds.some((f) => feedStatus(f) === "slow") ? "slow" : "live";
  const detail = feeds.map((f) => `${f.label ?? f.name}: ${feedStatus(f)} · updated ${age(f.last_msg_age_s)} ago · ${ms(f.rtt_ms)}`).join("\n");
  return (
    <div data-testid={testId} className="no-scrollbar flex min-w-0 items-center gap-5 overflow-x-auto text-[12.5px]">
      {bySym.size === 0 ? <span className="text-ink-3">waiting for prices…</span> : null}
      {[...bySym.entries()].map(([sym, rows]) => (
        <span key={sym} className="flex shrink-0 items-baseline gap-2" data-testid="spot">
          <span className="font-semibold text-ink">{sym}</span>
          {rows.map(([src, v], i) => (
            <span key={src} className="flex items-baseline gap-1">
              {i > 0 ? <span aria-hidden className="text-ink-3/50">/</span> : null}
              <span className="num text-ink">{price(v, 0)}</span>
              <span className="text-[11px] text-ink-3">{SPOT_LABEL[src] ?? src}</span>
            </span>
          ))}
        </span>
      ))}
      {feeds.length ? (
        <span title={detail} data-testid="feeds-summary" className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2">
          <span className={cn("inline-block size-1.5 rounded-full", worst === "down" ? "bg-neg" : worst === "slow" ? "bg-warn" : "bg-pos live-dot")} />
          {live} of {feeds.length} feeds live
        </span>
      ) : null}
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
      className="mx-3 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[20px] bg-kill px-5 py-2.5 text-[12.5px] text-white sm:mx-6"
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
    <div role="status" className="mx-3 mt-1 rounded-[20px] bg-warn-soft px-5 py-2.5 text-[12.5px] text-warn sm:mx-6">
      {desk ? "Lost contact with the API, showing the last data received. " : ""}
      {error} <span className="text-ink-3">({API_URL})</span>
    </div>
  );
}

const BOTTOM_NAV = [NAV[0], NAV[2], NAV[3], NAV[4]];

/** Mobile bottom bar (like the reference): charcoal, rounded, active item in the accent. */
function BottomBar({ onMore }: { onMore: () => void }) {
  const path = usePathname();
  const inMore = !BOTTOM_NAV.some(({ href }) => (href === "/" ? path === "/" : path?.startsWith(href)));
  return (
    <nav
      aria-label="Quick"
      data-testid="bottom-bar"
      className="fixed inset-x-3 bottom-3 z-40 flex h-16 items-center justify-around rounded-[28px] bg-nav px-2 shadow-[0_8px_30px_rgba(0,0,0,0.18)] lg:hidden"
    >
      {BOTTOM_NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            data-testid={`bnav-${href === "/" ? "desk" : href.slice(1)}`}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={cn("flex size-12 items-center justify-center rounded-full", active ? "text-brand" : "text-nav-ink hover:text-white")}
          >
            <Icon className="size-6" strokeWidth={active ? 2.3 : 1.8} />
          </Link>
        );
      })}
      <button
        type="button"
        data-testid="nav-open"
        onClick={onMore}
        aria-label="Open menu: all pages"
        className={cn("flex size-12 items-center justify-center rounded-full", inMore ? "text-brand" : "text-nav-ink hover:text-white")}
      >
        <LayoutGrid className="size-6" strokeWidth={inMore ? 2.3 : 1.8} />
      </button>
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  return (
    <div className="flex min-h-dvh">
      {/* sidebar (desktop): a charcoal rounded panel floating on the page */}
      <aside
        data-testid="sidebar"
        className={cn("hidden shrink-0 p-3 pr-0 lg:block", collapsed ? "w-[84px]" : "w-[236px]")}
      >
       <div className={cn("sticky top-3 flex h-[calc(100dvh-24px)] flex-col rounded-[28px] bg-nav", collapsed ? "px-2.5" : "px-3")}>
        <div className={cn("flex h-16 items-center px-1.5", collapsed && "justify-center px-0")}>
          <Brand collapsed={collapsed} />
        </div>
        <NavLinks collapsed={collapsed} />
        <div className="mt-auto space-y-2 pb-3">
          {collapsed ? null : (
            <div className="rounded-[18px] bg-white/[0.05] px-3.5 py-3 text-[11px] leading-snug text-nav-ink">
              Paper trading research. No real orders, no accounts, public market data only.
            </div>
          )}
          <button
            type="button"
            data-testid="sidebar-collapse"
            onClick={() => setCollapsed((c) => !c)}
            className={cn("flex h-9 w-full items-center gap-2 rounded-full px-3.5 text-[12px] text-nav-ink hover:bg-white/[0.04] hover:text-white", collapsed && "justify-center px-0")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
          </button>
        </div>
       </div>
      </aside>

      {/* drawer (mobile): all pages */}
      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
          <div data-testid="nav-drawer" className="fade-in absolute inset-x-3 bottom-3 flex max-h-[calc(100dvh-24px)] flex-col overflow-y-auto rounded-[28px] bg-nav px-3 pb-3">
            <div className="flex h-16 items-center justify-between px-1.5">
              <Brand />
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded-full p-2 text-nav-ink hover:bg-white/[0.06] hover:text-white">
                <X className="size-5" />
              </button>
            </div>
            <NavLinks onNavigate={() => setDrawer(false)} />
            <p className="px-3.5 pb-1 pt-4 text-[11px] leading-snug text-nav-ink">Paper trading research. No real orders. Public market data only.</p>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
          <div className="flex h-15 items-center gap-3 px-3 sm:px-6">
            <div className="lg:hidden"><Logo className="size-7" /></div>
            <div className="hidden min-w-0 flex-1 md:block"><Ticker /></div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span data-testid="paper-badge" className="hidden h-7 items-center gap-1.5 rounded-full bg-panel px-3 text-[11.5px] font-medium text-ink-2 sm:inline-flex">
                <FlaskConical className="size-3.5" strokeWidth={1.8} /> Paper only · not investment advice
              </span>
              <span className="inline-flex h-7 items-center rounded-full bg-panel px-2.5 text-[11px] font-medium text-ink-2 sm:hidden">Paper only</span>
              <ModeBadge />
              <HeaderKillSwitch />
              <ThemeToggle />
            </div>
          </div>
          <div className="px-3 pb-2 md:hidden"><Ticker testId="ticker-mobile" /></div>
        </header>
        <HaltBanner />
        <OfflineBanner />
        <main id="main" className="mx-auto w-full min-w-0 max-w-[1500px] flex-1 px-3 py-5 sm:px-6 sm:py-6">{children}</main>
        <footer className="px-4 pb-24 pt-3 text-[11.5px] text-ink-3 sm:px-6 lg:pb-5">
          Paper trading research. No real orders. Public market data only. Not investment advice.
          <span className="float-right hidden sm:inline">Edge Desk · Costantino Zunino</span>
        </footer>
      </div>
      <BottomBar onMore={() => setDrawer(true)} />
    </div>
  );
}
