"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Crosshair, Radio, ReceiptText, Rows3, SlidersHorizontal, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { ProbabilityCurve, curveModel } from "@/components/charts/probability-curve";
import {
  Badge, Button, CardLabel, cn, Empty, ErrorNote, feedStatus, Info, Kpi, Loading, PageHeader, Panel, Pie, Segmented, SideChip, StatusPill,
  Table, Td, Th, VenueTag,
} from "@/components/ui/kit";
import { Explainer } from "./explainer";
import { useDesk } from "@/lib/desk-context";
import {
  age, cents, compact, contractLabel, edgeCents, ms, num, pct, strike as fmtStrike, symName, toMs, tte, tteLong, usd, utcTime, venueLabel,
} from "@/lib/format";
import type { Desk, Opportunity } from "@/lib/types";

export function DeskView() {
  const { desk, error, loading } = useDesk();
  if (!desk) return (<><PageHeader title="Desk" /><ErrorNote error={error} />{loading ? <Loading label="Connecting to the desk" /> : null}</>);
  const s = desk.summary ?? {};
  const ret = s.equity != null && s.bankroll ? s.equity / s.bankroll - 1 : null;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Desk"
        sub="Live comparison of prediction-market prices with the probability implied by the options market, and the paper trades that follow."
        right={<DeskStatus desk={desk} />}
      />
      <ErrorNote error={error} />
      <div data-testid="kpis" className="space-y-3">
        <PnlHero desk={desk} ret={ret} />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <LiveCard desk={desk} />
          <Kpi
            shape="pill"
            className="xl:col-start-2 xl:row-start-1"
            label="Equity"
            hint="Paper bankroll plus everything won or lost so far. Above the starting bankroll is good."
            value={num(s.equity, 0)}
            unit="USD"
            sub={ret != null ? `${ret >= 0 ? "+" : "−"}${pct(Math.abs(ret))} on ${usd(s.bankroll, { digits: 0 })}` : "—"}
          />
          <Kpi
            shape="pill"
            className="xl:col-start-2 xl:row-start-2"
            label="Trades"
            hint="Paper orders that bought at least one contract. Settled = the hour has resolved."
            value={num(s.trades)}
            sub={`${num(s.settled)} settled · ${num(s.open)} open`}
          />
          <Kpi
            surface="white"
            className="row-span-2 xl:col-start-3 xl:row-start-1"
            label="Fees paid"
            icon={<ReceiptText />}
            hint="Venue taker fees, about 7% × price × (1 − price) per contract. Lower is better; fees eat most small gaps."
            value={num(s.fees, 2)}
            unit="USD"
            sub={s.cost ? `${pct((s.fees ?? 0) / s.cost)} of money spent` : undefined}
          />
          <Kpi
            surface="grey"
            className="row-span-2 xl:col-start-4 xl:row-start-1"
            label="Signals → orders"
            icon={<Waypoints />}
            hint="Signals are price gaps big enough to act on; orders are the ones that passed the 15 risk checks and got a non-zero size."
            value={<>{compact(s.signals)} <span className="text-ink-3">→</span> {compact(s.orders)}</>}
            sub="gaps found → paper orders"
          />
        </div>
      </div>
      <Explainer />

      <div className="grid items-start gap-5 xl:grid-cols-12">
        <CurvePanel desk={desk} />
        <div className="space-y-5 xl:col-span-4">
          <FeedHealth desk={desk} />
          <ConfigPanel desk={desk} />
        </div>
      </div>

      <Opportunities rows={desk.opportunities ?? []} now={desk.t} />

      <div className="grid gap-5 lg:grid-cols-2">
        <SignalsFeed desk={desk} />
        <OrdersFeed desk={desk} />
      </div>
    </div>
  );
}

/** The dot-matrix Net P&L, with the thin secondary figures beneath and a small win-rate pie. */
function PnlHero({ desk, ret }: { desk: Desk; ret: number | null }) {
  const s = desk.summary ?? {};
  const v = s.net_total;
  const loss = v != null && v < 0;
  const thin = (x: number | null | undefined, unit: string, opts: { sign?: boolean; digits?: number; pctv?: boolean } = {}) => (
    <span className="whitespace-nowrap">
      <span className={cn("thin text-[30px] leading-none sm:text-[40px]", x != null && x < 0 && "text-neg")}>
        {x == null ? "—" : opts.pctv ? `${x >= 0 ? "+" : "−"}${(Math.abs(x) * 100).toFixed(1)}` : `${opts.sign && x > 0 ? "+" : x < 0 ? "−" : ""}${num(Math.abs(x), opts.digits ?? 0)}`}
      </span>
      <span className="ml-1.5 text-[13px] font-semibold text-ink sm:text-[15px]">{unit}</span>
    </span>
  );
  return (
    <section aria-label="Net P&L" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-1 pb-3 pt-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2 self-start">
        <span className="inline-flex h-7 items-center rounded-full bg-chip px-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-chip-ink">Net P&amp;L after fees</span>
        <Info text="What the paper account made or lost, after every venue fee. Positive is good." />
        <span
          data-testid="pnl-direction"
          className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]", loss ? "bg-neg-soft text-neg" : "bg-panel text-ink-2")}
        >
          {loss ? <ArrowDown className="size-3" strokeWidth={2.6} /> : <ArrowUp className="size-3" strokeWidth={2.6} />}
          {loss ? "Loss" : "Gain"}
        </span>
      </div>
      <div className="flex shrink-0 items-start gap-3 text-right sm:row-span-2 sm:flex-col sm:items-end sm:gap-2">
        <div className="order-2 sm:order-none">
          <Pie value={s.win_rate} size={76} className="size-12 sm:size-[76px]" />
        </div>
        <div>
          <div className="flex items-center justify-end gap-1"><CardLabel className="text-[10.5px]">Win rate</CardLabel><Info text="Share of settled paper trades that made money. Above 50% is good, but size and price matter too." /></div>
          <div className="thin text-[22px] leading-tight">{pct(s.win_rate)}</div>
          <div className="whitespace-nowrap text-[11px] text-ink-3">of {num(s.settled)} settled</div>
        </div>
      </div>
      <div
        data-testid="pnl-hero"
        className={cn("dot col-span-2 mt-5 whitespace-nowrap text-[clamp(40px,12.5vw,112px)] sm:col-span-1", loss ? "text-neg" : "text-ink")}
      >
        {usd(v, { sign: true })}
      </div>
      <div className="col-span-2">
      <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-3 sm:gap-x-10" data-testid="pnl-detail">
        {thin(s.net_settled, "settled", { sign: true })}
        {thin(s.unrealized, "open", { sign: true })}
        {thin(ret, "% return", { pctv: true })}
      </div>
      <p className="mt-3 text-[12px] text-ink-3">US dollars. Open = still open, at market price. Paper money: no real orders are sent.</p>
      </div>
    </section>
  );
}

/** The single accent card: what the desk could trade right now. */
function LiveCard({ desk }: { desk: Desk }) {
  const opps = desk.opportunities ?? [];
  const nSig = opps.filter((o) => o.signal).length;
  const best = opps.reduce<number | null>((b, o) => (o.best_edge != null && (b == null || o.best_edge > b) ? o.best_edge : b), null);
  const line = (v: React.ReactNode, unit: string) => (
    <div className="flex items-baseline gap-2 whitespace-nowrap">
      <span className="thin text-[30px] leading-[1.15] sm:text-[34px]">{v}</span>
      <span className="text-[12px] font-semibold">{unit}</span>
    </div>
  );
  return (
    <section data-testid="live-card" className="row-span-2 flex xl:col-start-1 xl:row-start-1 min-w-0 flex-col rounded-[24px] bg-brand px-5 py-4.5 text-white [--ink-3:rgba(255,255,255,0.8)] [--ink:#fff]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <CardLabel className="text-white">Opportunities</CardLabel>
            <Info text="Open Kalshi and Polymarket contracts the desk is pricing right now, how many clear the bar for a paper trade (live signals), and the best edge after fees and safety margin." />
          </div>
          <div className="text-[12.5px] text-white/80">Now</div>
        </div>
        <Crosshair aria-hidden className="size-5 shrink-0" strokeWidth={1.6} />
      </div>
      <div className="mt-auto space-y-0.5 pt-6">
        {line(num(nSig), nSig === 1 ? "Signal" : "Signals")}
        {line(best == null ? "—" : `${best > 0 ? "+" : best < 0 ? "−" : ""}${(Math.abs(best) * 100).toFixed(1)}`, "¢ best edge")}
        {line(num(desk.contracts), "Watched")}
        <div className="pt-1 text-[11.5px] text-white/80">{(desk.curves ?? []).length} expiries on the chart</div>
      </div>
    </section>
  );
}

function DeskStatus({ desk }: { desk: Desk }) {
  const d = desk.desk ?? {};
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3" title="Engine clock = time of the last event processed (event time, UTC).">
      <span>engine clock <span className="num text-ink-2">{utcTime(desk.t)}</span></span>
      <span aria-hidden>·</span>
      <span><span className="num text-ink-2">{compact(d.records)}</span> events</span>
      {d.lag_s != null ? <><span aria-hidden>·</span><span>lag <span className="num text-ink-2">{age(d.lag_s)}</span></span></> : null}
      {d.caught_up === false ? <Badge tone="warn">catching up</Badge> : null}
    </div>
  );
}

function CurvePanel({ desk }: { desk: Desk }) {
  const curves = desk.curves ?? [];
  // default to the expiry with the most quoted strikes: the richest picture
  const richest = curves.reduce((b, cv, i) => ((cv.points?.length ?? 0) > (curves[b]?.points?.length ?? 0) ? i : b), 0);
  const [sel, setSel] = useState<number | null>(null);
  const idx = Math.min(sel ?? richest, Math.max(0, curves.length - 1));
  const c = curves[idx];
  const m = curveModel(desk.config?.trade_model);
  const signals = c ? (desk.opportunities ?? []).filter((o) => o.signal && o.sym === c.sym && o.expiry_ms === c.expiry_ms) : [];
  return (
    <Panel
      testId="curve-panel"
      className="xl:col-span-8"
      title={c ? `Chance ${symName(c.sym)} ends above each price at ${utcTime(c.expiry_ms, false)}` : "Chance of ending above each price"}
      info="Each dot is the model's probability that the price at expiry is above that strike, P(S_T > K), with its error band shaded. The bars are what Kalshi and Polymarket charge for the same contract (bid to ask). A trade needs the bar to sit clearly outside the band, by more than the fee."
      sub={c ? <>{m.label} model vs live venue prices · spot <span className="num">{num(c.spot, 0)}</span> · {tteLong(c.tte_s)} to go</> : undefined}
      right={
        curves.length > 1 ? (
          <Segmented
            value={String(idx)}
            onChange={(v) => setSel(Number(v))}
            testIdPrefix="curve-tab"
            options={curves.map((cv, i) => ({ value: String(i), label: <span>{cv.sym} · <span className="num">{tteLong(cv.tte_s)}</span></span> }))}
          />
        ) : null
      }
    >
      {c ? <ProbabilityCurve key={`${c.sym}-${c.expiry_ms}`} curve={c} tradeModel={desk.config?.trade_model} signals={signals} /> : <Empty className="h-[360px]">No live contracts with both a venue quote and an options-implied price yet.</Empty>}
    </Panel>
  );
}

function FeedHealth({ desk }: { desk: Desk }) {
  const feeds = desk.feeds ?? [];
  return (
    <section data-testid="feed-health" className="min-w-0">
      <div className="flex items-center justify-between gap-2 px-1 pb-2.5">
        <h2 className="flex items-center gap-1.5">
          <CardLabel>Market data feeds</CardLabel>
          <Info text="Public price feeds the desk listens to. Live = messages arriving normally; Slow = nothing for a while; Down = disconnected. Latency is the measured network round trip." />
        </h2>
        <Radio aria-hidden className="size-5 text-ink" strokeWidth={1.6} />
      </div>
      {feeds.length === 0 ? <Empty className="rounded-[24px] bg-panel">No feeds reporting.</Empty> : (
        <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-1">
          {feeds.map((f) => (
            <li key={f.name} data-testid="feed-row" className="flex items-center gap-3 rounded-full bg-panel py-3 pl-6 pr-4" title={f.reason || undefined}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1 whitespace-nowrap">
                  <span className="thin text-[26px] leading-none">{f.rtt_ms == null ? "—" : num(f.rtt_ms, 0)}</span>
                  <span className="text-[11px] font-semibold uppercase">ms</span>
                </div>
                <div className="mt-1 truncate text-[11px]">
                  <CardLabel className="text-[10.5px]">{f.label ?? venueLabel(f.name)}</CardLabel>
                  <span className="text-ink-3"> / {f.transport ?? (f.websocket ? "WebSocket" : "REST")}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StatusPill status={feedStatus(f)} testId="feed-status" />
                <span className="whitespace-nowrap text-[11px] text-ink-3">updated <span className="num">{age(f.last_msg_age_s)}</span> ago</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MODEL_NAME: Record<string, string> = {
  hybrid: "Hybrid (options smile + recent volatility)",
  options: "Options-implied (Deribit smile)",
  realized: "Recent volatility only (spot prices)",
  ensemble: "Ensemble (models + market prices)",
};

function ConfigPanel({ desk }: { desk: Desk }) {
  const c = desk.config ?? {};
  const delays = Object.entries(c.latency_ms ?? {}).map(([k, v]) => `${venueLabel(k)} ${ms(v)}`).join(", ");
  const rows: [string, React.ReactNode, string][] = [
    ["Pricing model", MODEL_NAME[c.trade_model ?? ""] ?? c.trade_model ?? "—", "Which probability the desk trusts when it compares with market prices."],
    ["Minimum edge after fees", <span key="e" className="num">{edgeCents(c.min_edge)}</span>, "The gap between model and price must beat the fee and the safety margin by at least this much per contract."],
    ["Safety margin", <><span className="num">{num(c.band_k, c.band_k != null && c.band_k % 1 ? 2 : 0)}×</span> model uncertainty</>, "How many error bands the gap has to clear. Higher = fewer, safer trades."],
    ["Order style", c.order_style === "maker" ? "Rest a limit order (maker)" : "Take the best available price (taker)", "Taker orders fill at once at the best price shown, and pay the taker fee."],
    ["Assumed network delay", delays || "—", "One-way delay added between deciding and reaching the venue. Prices can move meanwhile."],
    ["Extra delay (stress test)", <span key="x" className="num">{ms(c.added_latency_ms)}</span>, "Added on purpose to see how much edge survives being slower."],
    ["Event-log fingerprint", <span key="d" className="num" title={desk.digest ?? ""}>{desk.digest ? `${desk.digest.slice(0, 10)}…` : "—"}</span>, "SHA-256 over every event. Replaying the same data with the same settings gives the same fingerprint."],
  ];
  return (
    <Panel title="Strategy settings" icon={<SlidersHorizontal />} testId="config-panel" info="The rules the paper trader follows right now. Change them on Settings; the desk then replays the log with the new rules.">
      <dl className="divide-y divide-line/70">
        {rows.map(([k, v, hint]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
            <dt className="flex shrink-0 items-center gap-1 text-[12.5px] text-ink-3">{k}<Info text={hint} /></dt>
            <dd className="min-w-0 text-right text-[13px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

type SortKey = "contract" | "tte" | "bid" | "ask" | "fair" | "edge_yes" | "edge_no" | "best_edge" | "book";
const COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "contract", label: "Contract" },
  { key: "tte", label: "Time left", right: true },
  { key: "bid", label: "Bid × size", right: true },
  { key: "ask", label: "Ask × size", right: true },
  { key: "fair", label: "Model ± error", right: true },
  { key: "edge_yes", label: "Edge YES", right: true },
  { key: "edge_no", label: "Edge NO", right: true },
  { key: "best_edge", label: "Best edge", right: true },
  { key: "book", label: "Quote age", right: true },
];
const sortVal = (o: Opportunity, k: SortKey): number | string => {
  switch (k) {
    case "contract": return `${o.venue}-${String(Math.round(o.strike ?? 0)).padStart(8, "0")}`;
    case "tte": return o.tte_s ?? Infinity;
    case "bid": return o.bid ?? -1;
    case "ask": return o.ask ?? 2;
    case "fair": return o.fair ?? -1;
    case "edge_yes": return o.edge_yes ?? -9;
    case "edge_no": return o.edge_no ?? -9;
    case "best_edge": return o.best_edge ?? -9;
    case "book": return o.book_age_s ?? Infinity;
  }
};

function EdgeCell({ e, min }: { e?: number | null; min: number }) {
  if (e == null) return <span className="text-ink-3">—</span>;
  const strong = e >= min;
  return (
    <span className={cn("num", e > 0 ? "text-pos" : "text-ink-3", strong && "font-semibold")}>
      {edgeCents(e)}
    </span>
  );
}

function Opportunities({ rows, now }: { rows: Opportunity[]; now?: number }) {
  const { desk } = useDesk();
  const minEdge = desk?.config?.min_edge ?? 0.02;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "best_edge", dir: -1 });
  const [venue, setVenue] = useState<"all" | "kalshi" | "polymarket">("all");
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 15;
  const sorted = useMemo(() => {
    const r = rows.filter((o) => venue === "all" || o.venue === venue);
    return r.sort((a, b) => {
      const va = sortVal(a, sort.key);
      const vb = sortVal(b, sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [rows, sort, venue]);
  const nSignals = rows.filter((o) => o.signal).length;
  const shown = showAll ? sorted : sorted.slice(0, LIMIT);

  return (
    <Panel
      testId="opportunities"
      title="Opportunities"
      icon={<Rows3 />}
      info="Edge = model probability − price − fee − safety margin, for buying YES or buying NO. Positive and above the minimum edge means the desk would trade. Negative means the market price is fair or better than our model, after costs."
      sub={`${rows.length} open contracts, best gaps first. A trade needs an edge above ${edgeCents(minEdge)}. ${nSignals ? `${nSignals} live signal${nSignals > 1 ? "s" : ""}.` : "No contract clears the bar right now: the markets agree with the model, after fees."}`}
      right={
        <Segmented
          value={venue}
          onChange={setVenue}
          testIdPrefix="opps-venue"
          options={[{ value: "all", label: "All" }, { value: "kalshi", label: "Kalshi" }, { value: "polymarket", label: "Polymarket" }]}
        />
      }
      bodyClass="pb-0"
    >
      {rows.length === 0 ? <Empty>No open contracts with a model price.</Empty> : (
        <Table testId="opps-table">
          <thead>
            <tr>
              {COLS.map((c) => {
                const active = sort.key === c.key;
                const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
                return (
                  <Th key={c.key} right={c.right} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button
                      type="button"
                      data-testid={`sort-${c.key}`}
                      onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.key === "contract" || c.key === "tte" || c.key === "book" ? 1 : -1 }))}
                      className={cn("inline-flex items-center gap-1 hover:text-ink", active && "text-ink", c.right && "flex-row-reverse")}
                    >
                      {c.label}
                      <Icon className={cn("size-3", !active && "opacity-40")} />
                    </button>
                  </Th>
                );
              })}
              <Th right>Signal</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.cid} data-testid="opp-row" className={cn("hover:bg-panel-2", o.signal && "bg-brand-soft/60")}>
                <Td>
                  <div className="flex items-center gap-2" title={`${o.cid}${o.ref ? `\nsettles on: ${o.ref}` : ""}`}>
                    <VenueTag venue={o.venue} short />
                    <span className="num text-ink">{o.sym} &gt; {fmtStrike(o.strike)}</span>
                    <span className="num text-[11px] text-ink-3">{utcTime(o.expiry_ms, false).replace(" UTC", "")}</span>
                  </div>
                </Td>
                <Td right className="text-ink-2">{tte(o.tte_s)}</Td>
                <Td right>{cents(o.bid)} <span className="text-ink-3">× {compact(o.bid_sz)}</span></Td>
                <Td right>{cents(o.ask)} <span className="text-ink-3">× {compact(o.ask_sz)}</span></Td>
                <Td right>{pct(o.fair)} <span className="text-ink-3">± {pct(o.band)}</span></Td>
                <Td right><EdgeCell e={o.edge_yes} min={minEdge} /></Td>
                <Td right><EdgeCell e={o.edge_no} min={minEdge} /></Td>
                <Td right data-testid="best-edge" data-value={o.best_edge ?? ""}><EdgeCell e={o.best_edge} min={minEdge} /></Td>
                <Td right className={cn((o.book_age_s ?? 0) > 30 ? "text-warn" : "text-ink-3")}>{age(o.book_age_s)}</Td>
                <Td right>{o.signal ? <SideChip side={o.signal} testId="signal-chip" /> : <span className="text-ink-3">—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="flex items-center justify-between gap-3 py-2.5">
        {sorted.length > LIMIT ? (
          <Button size="sm" variant="ghost" data-testid="opps-toggle" onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show top ${LIMIT}` : `Show all ${sorted.length}`}
          </Button>
        ) : <span />}
        {now ? <p className="text-[11px] text-ink-3">as of <span className="num">{utcTime(toMs(now))}</span></p> : null}
      </div>
    </Panel>
  );
}

function SignalsFeed({ desk }: { desk: Desk }) {
  const rows = (desk.signals ?? []).slice(0, 14);
  return (
    <Panel title="Recent signals" testId="signals-feed" bodyClass="px-0 pt-1 pb-3" sub="Gaps big enough to act on; each goes through the risk checks." info="A signal means model probability minus price minus fee minus safety margin was above the minimum edge. The green number is that edge per contract.">
      {rows.length === 0 ? <Empty>No signals yet.</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((s, i) => (
            <li key={s.seq ?? i} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
              <span className="num w-16 shrink-0 text-ink-3">{utcTime(s.t).replace(" UTC", "")}</span>
              <SideChip side={s.side} />
              <VenueTag venue={s.venue} short />
              <span className="num min-w-0 truncate text-ink" title={s.cid}>{s.label ?? shortCid(s.cid)}</span>
              <span className="num ml-auto shrink-0 text-ink-2">@ {cents(s.px)}</span>
              <span className="num w-14 shrink-0 text-right text-pos">{edgeCents(s.edge)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const EVENT_TONE: Record<string, "pos" | "neg" | "warn" | "muted" | "brand"> = {
  filled: "pos", partially_filled: "brand", expired: "muted", rejected: "neg", canceled: "warn", cancelled: "warn", new: "muted", acked: "muted",
};

function OrdersFeed({ desk }: { desk: Desk }) {
  const rows = (desk.orders ?? []).slice(0, 14);
  return (
    <Panel title="Paper order events" testId="orders-feed" bodyClass="px-0 pt-1 pb-3" sub="Each order goes new → acked → filled, partly filled or expired." info="Orders are immediate-or-cancel: whatever the book can fill at the limit price fills, the rest expires. Nothing is sent to a real exchange.">
      {rows.length === 0 ? <Empty>No paper orders yet.</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((o, i) => (
            <li key={`${o.seq}-${i}`} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
              <span className="num w-16 shrink-0 text-ink-3">{utcTime(o.t).replace(" UTC", "")}</span>
              <Badge tone={EVENT_TONE[o.event ?? ""] ?? "muted"} className="w-[70px] justify-center">{(o.event ?? o.state ?? "") === "partially_filled" ? "partial" : (o.event ?? o.state ?? "").replace("_", " ")}</Badge>
              <span className="num shrink-0 text-ink-3">#{o.oid}</span>
              <span className="num min-w-0 truncate text-ink" title={o.cid}>{o.side?.toUpperCase()} {o.label ?? shortCid(o.cid)}</span>
              <span className="num ml-auto shrink-0 text-ink-2">
                {o.event === "filled" || o.event === "partially_filled" ? `${num(o.filled)} @ ${cents(o.avg_px)}` : `${num(o.qty)} ≤ ${cents(o.limit)}`}
              </span>
              <span className="hidden w-28 truncate text-right text-[11px] text-ink-3 xl:inline" title={o.why ?? o.reason ?? ""}>{o.why ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** "KXBTCD-26NOV0716-T76749.99" -> "BTC > $76,750"; falls back to the id. */
function shortCid(cid?: string) {
  if (!cid) return "—";
  const k = cid.match(/^KX(\w{3})D-.*-T([\d.]+)$/);
  if (k) return contractLabel({ sym: k[1], strike: Number(k[2]) });
  const p = cid.match(/^(bitcoin|ethereum)-above-.*-(\d+)$/);
  if (p) return contractLabel({ sym: p[1] === "bitcoin" ? "BTC" : "ETH", strike: Number(p[2]) });
  return cid;
}
