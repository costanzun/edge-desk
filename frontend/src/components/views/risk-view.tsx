"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { BigKillSwitch } from "@/components/shell/kill-switch";
import {
  Badge, cn, Dot, Empty, feedStatus, StatusPill, ErrorNote, Loading, PageHeader, Panel, Stats, Table, Td, Th, UsageBar,
} from "@/components/ui/kit";
import * as api from "@/lib/api";
import { useDesk } from "@/lib/desk-context";
import { usePoll } from "@/lib/hooks";
import { age, cents, humanize, ms, num, pct, usd, utcTime } from "@/lib/format";
import type { Limits, Positions, Risk } from "@/lib/types";

type Row = { key: string; label: string; cap: string; used?: number; capN?: number; usedLabel?: string; kind: "usage" | "guard" };

function limitRows(limits: Limits, risk: Risk, pos: Positions | null): Row[] {
  const ex = risk.exposure ?? {};
  const perMarket = new Map<string, number>();
  for (const p of pos?.positions ?? []) perMarket.set(p.cid, (perMarket.get(p.cid) ?? 0) + (p.cost ?? 0));
  const maxMarket = Math.max(0, ...perMarket.values());
  const maxExpiry = Math.max(0, ...(ex.by_expiry ?? []).map((e) => e.cost ?? 0));
  const maxUnder = Math.max(0, ...Object.values(ex.by_underlying ?? {}));
  const loss = Math.max(0, -(risk.day_pnl ?? 0));
  const L = limits;
  const rows: Row[] = [];
  const usage = (key: string, label: string, capN: number | undefined, used: number, fmt: (v: number) => string = (v) => usd(v)) => {
    if (capN == null) return;
    rows.push({ key, label, cap: fmt(capN), capN, used, usedLabel: fmt(used), kind: "usage" });
  };
  usage("max_gross", "Gross exposure", L.max_gross, ex.gross ?? 0);
  usage("max_cost_per_underlying", "Per underlying (largest)", L.max_cost_per_underlying, maxUnder);
  usage("max_cost_per_expiry", "Per expiry (largest)", L.max_cost_per_expiry, maxExpiry);
  usage("max_cost_per_market", "Per market (largest)", L.max_cost_per_market, maxMarket);
  usage("max_open_orders", "Open orders", L.max_open_orders, ex.open_orders ?? 0, (v) => num(v));
  usage("daily_loss_limit", "Daily loss", L.daily_loss_limit, loss);
  const guard = (key: string, label: string, v: number | undefined, fmt: (v: number) => string) => {
    if (v != null) rows.push({ key, label, cap: fmt(v), kind: "guard" });
  };
  guard("max_book_age_s", "Max order-book age", L.max_book_age_s, (v) => `${v} s`);
  guard("max_spot_age_s", "Max spot age", L.max_spot_age_s, (v) => `${v} s`);
  guard("max_chain_age_s", "Max options-chain age", L.max_chain_age_s, (v) => `${v} s`);
  guard("min_price", "Min price", L.min_price, (v) => cents(v));
  guard("max_price", "Max price", L.max_price, (v) => cents(v));
  guard("max_edge", "Max edge (too good to be true)", L.max_edge, (v) => cents(v));
  guard("max_limit_vs_fair", "Max limit vs fair", L.max_limit_vs_fair, (v) => cents(v));
  return rows;
}

export function RiskView() {
  const { version } = useDesk();
  const risk = usePoll(api.getRisk, 3000, version);
  const pos = usePoll(api.getPositions, 10000);
  const r = risk.data;
  if (!r) return (<><PageHeader title="Risk" /><ErrorNote error={risk.error} />{risk.loading ? <Loading /> : null}</>);
  const rows = r.limits ? limitRows(r.limits, r, pos.data) : [];
  const dec = r.decisions ?? {};
  const failed = Object.entries(dec.failed_checks ?? {}).sort((a, b) => b[1] - a[1]);
  const maxFailed = Math.max(1, ...failed.map(([, n]) => n));
  const rejects = Object.entries(r.input_rejects ?? {}).sort((a, b) => b[1] - a[1]);
  const halts = r.halts ?? [];
  const feedEvents = r.feed_events ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Risk"
        sub="Every signal passes 15 pre-trade checks before it becomes a paper order. Exposure caps, data freshness, price sanity, a daily loss limit, reconciliation, and an operator kill switch."
      />
      <ErrorNote error={risk.error} />

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Kill switch" info="Stops all new paper orders at once. Use it if data looks wrong. Market data keeps recording." className="xl:col-span-7" testId="kill-panel" bodyClass="p-5">
          <BigKillSwitch />
        </Panel>
        <Panel title="Risk decisions" info="Every signal is checked before it becomes an order. Blocked signals are not errors: most are sized to zero by the cautious Kelly rule." className="xl:col-span-5" testId="decisions-panel">
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="Signals checked" v={num(dec.total)} />
            <Stat label="Accepted" v={num(dec.accepted)} tone="pos" />
            <Stat label="Blocked" v={num((dec.total ?? 0) - (dec.accepted ?? 0))} tone="neg" />
          </div>
          <div className="label mb-1.5">Blocked by check</div>
          {failed.length === 0 ? <p className="text-[12px] text-ink-3">Nothing blocked.</p> : (
            <ul className="space-y-1.5" data-testid="failed-checks">
              {failed.map(([k, n]) => (
                <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-3 text-[12px]">
                  <span className="num truncate">{k}</span>
                  <span className="num text-ink-2">{num(n)}</span>
                  <div className="col-span-2 h-1 overflow-hidden rounded-full bg-grid"><div className="h-full rounded-full bg-neg/70" style={{ width: `${(n / maxFailed) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
          {failed.length === 1 && failed[0][0] === "qty_positive" ? (
            <p className="mt-2 text-[11px] leading-snug text-ink-3">qty_positive: the order sized to zero contracts, because Kelly on the conservative edge (p − band) or the room left under the exposure caps allowed nothing. Sizing declining, not a fault.</p>
          ) : null}
        </Panel>
      </div>

      <Panel title="Limits and current usage" info="Caps on how much money can be at risk. Bars show how much of each cap is used; green is comfortable, amber close, red at the limit (new orders there are refused)." testId="limits-table" bodyClass="py-0">
        {rows.length === 0 ? <Empty>No limits reported.</Empty> : (
          <Table>
            <thead><tr><Th>Limit</Th><Th className="hidden md:table-cell">Key</Th><Th right>Current</Th><Th right>Cap</Th><Th className="w-[34%]">Usage</Th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="hover:bg-panel-2">
                  <Td className="font-medium">{row.label}</Td>
                  <Td className="hidden text-[11px] text-ink-3 md:table-cell" mono>{row.key}</Td>
                  <Td right>{row.kind === "usage" ? row.usedLabel : <span className="text-ink-3">per signal</span>}</Td>
                  <Td right>{row.cap}</Td>
                  <Td>{row.kind === "usage" && row.capN ? <UsageBar used={row.used ?? 0} cap={row.capN} testId="usage-bar" /> : <span className="text-[11.5px] text-ink-3">guard: checked on every signal</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Reconciliation" info="An independent ledger re-computes positions and cash and must agree with the trading engine. Agree = good." testId="recon-panel">
          <div className="mb-3 flex items-center gap-2">
            {r.recon?.ok !== false ? <CheckCircle2 className="size-5 text-pos" /> : <XCircle className="size-5 text-neg" />}
            <span className="text-[14px] font-semibold">{r.recon?.ok !== false ? "Books agree" : "Break detected"}</span>
          </div>
          <Stats rows={[
            ["Checks run", num(r.recon?.checks)],
            ["Last check", utcTime(r.recon?.last?.t)],
            ["Breaks at last check", num(r.recon?.last?.breaks?.length ?? 0)],
          ]} />
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">Positions folded from fills are compared with an independent double-entry ledger after every fill and settlement. A break halts trading.</p>
        </Panel>
        <Panel title="Ingest rejects" info="Market data messages thrown away because they were duplicates, malformed, out of order or stale. A few is normal; many means a feed problem." testId="rejects-panel">
          {rejects.length === 0 ? (
            <Empty className="min-h-0 py-3">No rejected messages.</Empty>
          ) : (
            <Stats rows={rejects.map(([k, n]) => [humanize(k), num(n)])} />
          )}
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">Guards on every market-data message: duplicates, schema violations, out-of-order sequence, stale timestamps, clock skew.</p>
        </Panel>
        <Panel title="Halts" info="Times trading was stopped (kill switch, loss limit, reconciliation break) and resumed." testId="halts-panel" bodyClass="px-0 pt-1 pb-3">
          {halts.length === 0 ? <Empty className="min-h-0 py-6">No halts in this session.</Empty> : (
            <ul className="max-h-56 divide-y divide-line overflow-y-auto">
              {[...halts].reverse().map((h, i) => (
                <li key={i} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                  <span className="num w-24 shrink-0 whitespace-nowrap text-ink-3">{utcTime(h.t)}</span>
                  <Badge tone={h.halted ? "neg" : "pos"}>{h.halted ? "halt" : "resume"}</Badge>
                  <span className="truncate text-ink-2">{h.reason || "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Market data feeds" info="Live = messages arriving normally; Slow = quiet for a while; Down = disconnected. Signals on a venue with a stale feed are blocked." testId="risk-feeds" className="xl:col-span-5" bodyClass="py-0">
          <Table>
            <thead><tr><Th>Feed</Th><Th>Status</Th><Th right>Updated</Th><Th right>Latency</Th><Th right>Messages</Th></tr></thead>
            <tbody>
              {(r.feeds ?? []).map((f) => (
                <tr key={f.name}>
                  <Td title={f.reason || undefined}>
                    <div className="font-medium">{f.label ?? f.name}</div>
                    <div className="text-[11px] text-ink-3">{f.transport ?? (f.websocket ? "WebSocket" : "REST")}</div>
                  </Td>
                  <Td><StatusPill status={feedStatus(f)} /></Td>
                  <Td right className="text-ink-2">{age(f.last_msg_age_s)} ago</Td>
                  <Td right>{ms(f.rtt_ms)}</Td>
                  <Td right className="text-ink-3">{num(f.messages)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="label mb-1 mt-3">Transitions</div>
          {feedEvents.length === 0 ? <p className="pb-3 text-[12px] text-ink-3">No feed went down or recovered in this session.</p> : (
            <ul className="pb-3 text-[12px]">
              {feedEvents.slice(-12).reverse().map((e, i) => (
                <li key={i} className="flex gap-2 py-0.5">
                  <span className="num w-24 shrink-0 whitespace-nowrap text-ink-3">{utcTime(e.t)}</span>
                  <Dot ok={e.ok} className="mt-1.5" />
                  <span className="capitalize">{e.name ?? e.feed}</span>
                  <span className="truncate text-ink-3">{e.reason ?? (e.ok ? "recovered" : "down")}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent risk decisions" info="The last signals and whether they passed. Hover a row to see all 15 checks." testId="recent-decisions" className="xl:col-span-7" bodyClass="px-0 pt-1 pb-3">
          {(r.recent ?? []).length === 0 ? <Empty>No decisions yet.</Empty> : (
            <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
              {(r.recent ?? []).slice(0, 30).map((d, i) => (
                <li key={d.seq ?? i} className="flex items-center gap-2.5 px-4 py-2 text-[12px]" title={(d.checks ?? []).map((c) => `${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail ?? ""}`).join("\n")}>
                  <span className="num w-16 shrink-0 text-ink-3">{utcTime(d.t).replace(" UTC", "")}</span>
                  {d.ok ? <Badge tone="pos">pass</Badge> : <Badge tone="neg">block</Badge>}
                  <span className="num min-w-0 truncate">{d.cid}</span>
                  <span className="num ml-auto shrink-0 text-ink-2">{d.ok ? `${num(d.qty)} @ ≤${cents(d.limit)}` : (d.failed ?? []).join(", ")}</span>
                  <span className="num hidden w-16 shrink-0 text-right text-[11px] text-ink-3 sm:inline">{(d.checks ?? []).filter((c) => c.ok).length}/{(d.checks ?? []).length} ok</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <p className="text-[11.5px] text-ink-3">Day P&L used by the loss limit: {usd(r.day_pnl, { sign: true })} · accept rate {dec.total ? pct((dec.accepted ?? 0) / dec.total) : "—"}</p>
    </div>
  );
}

function Stat({ label, v, tone }: { label: string; v: string; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-full bg-panel-2 px-2 py-2.5">
      <div className={cn("thin text-[24px] leading-tight", tone === "pos" && "text-pos", tone === "neg" && "text-neg")}>{v}</div>
      <div className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-2">{label}</div>
    </div>
  );
}
