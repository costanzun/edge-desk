"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { ProbabilityCurve, curveModel } from "@/components/charts/probability-curve";
import {
  Badge, cn, Dot, Empty, ErrorNote, Kpi, Loading, PageHeader, Panel, Segmented, SideChip, Signed, Stats, Table, Td, Th, VenueTag,
} from "@/components/ui/kit";
import { useDesk } from "@/lib/desk-context";
import {
  age, cents, compact, contractLabel, edgeCents, ms, num, pct, strike as fmtStrike, toMs, tte, tteLong, usd, utcTime,
} from "@/lib/format";
import type { Desk, Opportunity } from "@/lib/types";

export function DeskView() {
  const { desk, error, loading } = useDesk();
  if (!desk) return (<><PageHeader title="Desk" /><ErrorNote error={error} />{loading ? <Loading label="Connecting to the desk" /> : null}</>);
  const s = desk.summary ?? {};
  const ret = s.equity != null && s.bankroll ? s.equity / s.bankroll - 1 : null;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Desk"
        sub="Kalshi and Polymarket “Bitcoin above $X” contracts against the probability implied by Deribit options. Every quote, model output, signal and paper order is an event in one replayable log."
        right={<DeskStatus desk={desk} />}
      />
      <ErrorNote error={error} />
      <div data-testid="kpis" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Net P&L after fees" value={<Signed value={s.net_total}>{usd(s.net_total, { sign: true })}</Signed>} sub={`settled ${usd(s.net_settled, { digits: 0 })} · open ${usd(s.unrealized, { digits: 0 })}`} />
        <Kpi label="Fees paid" value={usd(s.fees)} sub={s.cost ? `${pct((s.fees ?? 0) / s.cost)} of cost` : undefined} />
        <Kpi label="Trades" value={num(s.trades)} sub={`${num(s.settled)} settled · ${num(s.open)} open`} />
        <Kpi label="Win rate" value={pct(s.win_rate)} sub="settled trades" />
        <Kpi label="Equity" value={usd(s.equity, { digits: 0 })} sub={<Signed value={ret}>{ret != null ? `${ret >= 0 ? "+" : "−"}${pct(Math.abs(ret))} on ${usd(s.bankroll, { digits: 0 })}` : "—"}</Signed>} />
        <Kpi label="Signals → orders" value={`${compact(s.signals)} → ${compact(s.orders)}`} sub="paper orders" />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <CurvePanel desk={desk} />
        <div className="space-y-4 xl:col-span-4">
          <FeedHealth desk={desk} />
          <ConfigPanel desk={desk} />
        </div>
      </div>

      <Opportunities rows={desk.opportunities ?? []} now={desk.t} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SignalsFeed desk={desk} />
        <OrdersFeed desk={desk} />
      </div>
    </div>
  );
}

function DeskStatus({ desk }: { desk: Desk }) {
  const d = desk.desk ?? {};
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
      <span className="num">engine {utcTime(desk.t)}</span>
      <span aria-hidden>·</span>
      <span className="num">{compact(d.records)} events</span>
      {d.lag_s != null ? <><span aria-hidden>·</span><span className="num">lag {age(d.lag_s)}</span></> : null}
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
  return (
    <Panel
      testId="curve-panel"
      className="xl:col-span-8"
      title={c ? `P(${c.sym} above strike at ${utcTime(c.expiry_ms, false)})` : "Probability curve"}
      sub={c ? `${m.label} model vs live venue quotes · spot ${num(c.spot, 2)}` : undefined}
      right={
        curves.length > 1 ? (
          <Segmented
            value={String(idx)}
            onChange={(v) => setSel(Number(v))}
            testIdPrefix="curve-tab"
            options={curves.map((cv, i) => ({ value: String(i), label: <span className="num">{cv.sym} · {tteLong(cv.tte_s)}</span> }))}
          />
        ) : null
      }
    >
      {c ? <ProbabilityCurve key={`${c.sym}-${c.expiry_ms}`} curve={c} tradeModel={desk.config?.trade_model} /> : <Empty className="h-[360px]">No live contracts with both a venue quote and an options-implied price yet.</Empty>}
    </Panel>
  );
}

function FeedHealth({ desk }: { desk: Desk }) {
  const feeds = desk.feeds ?? [];
  return (
    <Panel title="Feed health" testId="feed-health" bodyClass="p-0">
      {feeds.length === 0 ? <Empty>No feeds reporting.</Empty> : (
        <ul className="divide-y divide-line">
          {feeds.map((f) => {
            const stale = (f.last_msg_age_s ?? 0) > 30;
            return (
              <li key={f.name} className="flex items-center gap-2.5 px-3.5 py-2 text-[12.5px]">
                <Dot ok={f.ok} warn={stale} />
                <span className="w-24 font-medium capitalize">{f.name}</span>
                <span className="text-[11px] text-ink-3">{f.websocket ? "ws" : "rest"}</span>
                <span className="num ml-auto text-ink-2" title="round-trip time">{ms(f.rtt_ms)}</span>
                <span className="num w-14 text-right text-ink-3" title="last message">{age(f.last_msg_age_s)} ago</span>
                <span className={cn("num w-10 text-right", (f.errors ?? 0) > 0 ? "text-warn" : "text-ink-3")} title="errors">{num(f.errors)}✕</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ConfigPanel({ desk }: { desk: Desk }) {
  const c = desk.config ?? {};
  return (
    <Panel title="Strategy" testId="config-panel">
      <Stats
        rows={[
          ["Trade model", <span key="m" className="capitalize">{c.trade_model ?? "—"}</span>],
          ["Min edge (after fees)", edgeCents(c.min_edge)],
          ["Band multiplier k", num(c.band_k, 2)],
          ["Order style", c.order_style ?? "—"],
          ["One-way latency", Object.entries(c.latency_ms ?? {}).map(([k, v]) => `${k.slice(0, 1).toUpperCase()} ${ms(v)}`).join(" · ") || "—"],
          ["Added latency", ms(c.added_latency_ms)],
          ["Contracts tracked", num(desk.contracts)],
          ["Log digest", <span key="d" title={desk.digest ?? ""}>{desk.digest ? `${desk.digest.slice(0, 12)}…` : "—"}</span>],
        ]}
      />
    </Panel>
  );
}

type SortKey = "contract" | "tte" | "bid" | "ask" | "fair" | "edge_yes" | "edge_no" | "best_edge" | "book";
const COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "contract", label: "Contract" },
  { key: "tte", label: "TTE", right: true },
  { key: "bid", label: "Bid × size", right: true },
  { key: "ask", label: "Ask × size", right: true },
  { key: "fair", label: "Fair ± band", right: true },
  { key: "edge_yes", label: "Edge YES", right: true },
  { key: "edge_no", label: "Edge NO", right: true },
  { key: "best_edge", label: "Best", right: true },
  { key: "book", label: "Book age", right: true },
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
  const sorted = useMemo(() => {
    const r = rows.filter((o) => venue === "all" || o.venue === venue);
    return r.sort((a, b) => {
      const va = sortVal(a, sort.key);
      const vb = sortVal(b, sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [rows, sort, venue]);
  const nSignals = rows.filter((o) => o.signal).length;

  return (
    <Panel
      testId="opportunities"
      title={`Opportunities · ${rows.length} contracts`}
      sub={`Edge = model probability − price − fee − k × band, per side. Signal when it clears ${edgeCents(minEdge)}. ${nSignals ? `${nSignals} live signal${nSignals > 1 ? "s" : ""}.` : "No contract clears the bar right now."}`}
      right={
        <Segmented
          value={venue}
          onChange={setVenue}
          testIdPrefix="opps-venue"
          options={[{ value: "all", label: "All" }, { value: "kalshi", label: "Kalshi" }, { value: "polymarket", label: "Polymarket" }]}
        />
      }
      bodyClass="pb-0 pt-0"
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
                      className={cn("inline-flex items-center gap-1 uppercase hover:text-ink", active && "text-ink", c.right && "flex-row-reverse")}
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
            {sorted.map((o) => (
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
      {now ? <p className="num py-2 text-right text-[10.5px] text-ink-3">as of {utcTime(toMs(now))}</p> : null}
    </Panel>
  );
}

function SignalsFeed({ desk }: { desk: Desk }) {
  const rows = (desk.signals ?? []).slice(0, 14);
  return (
    <Panel title="Recent signals" testId="signals-feed" bodyClass="p-0" sub="Model edge cleared the bar; each one goes through the risk checks.">
      {rows.length === 0 ? <Empty>No signals yet.</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((s, i) => (
            <li key={s.seq ?? i} className="flex items-center gap-2.5 px-3.5 py-1.5 text-[12px]">
              <span className="num w-16 shrink-0 text-ink-3">{utcTime(s.t).replace(" UTC", "")}</span>
              <SideChip side={s.side} />
              <VenueTag venue={s.venue} short />
              <span className="num min-w-0 truncate text-ink" title={s.cid}>{shortCid(s.cid)}</span>
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
    <Panel title="Order events" testId="orders-feed" bodyClass="p-0" sub="Paper order state machine: new → acked → filled / partially filled / expired (IOC).">
      {rows.length === 0 ? <Empty>No paper orders yet.</Empty> : (
        <ul className="divide-y divide-line">
          {rows.map((o, i) => (
            <li key={`${o.seq}-${i}`} className="flex items-center gap-2.5 px-3.5 py-1.5 text-[12px]">
              <span className="num w-16 shrink-0 text-ink-3">{utcTime(o.t).replace(" UTC", "")}</span>
              <Badge tone={EVENT_TONE[o.event ?? ""] ?? "muted"} className="w-[70px] justify-center">{(o.event ?? o.state ?? "") === "partially_filled" ? "partial" : (o.event ?? o.state ?? "").replace("_", " ")}</Badge>
              <span className="num shrink-0 text-ink-3">#{o.oid}</span>
              <span className="num min-w-0 truncate text-ink" title={o.cid}>{o.side?.toUpperCase()} {shortCid(o.cid)}</span>
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
