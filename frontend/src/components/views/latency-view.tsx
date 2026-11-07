"use client";

import { EdgeDecayChart } from "@/components/charts/analytics-charts";
import { Histogram, RangeBars } from "@/components/charts/bars";
import { venueColor } from "@/components/charts/probability-curve";
import { Badge, Empty, ErrorNote, Loading, PageHeader, Panel, Signed, Table, Td, Th } from "@/components/ui/kit";
import * as api from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { addedLatency, compact, ms, num, pct, us, usd } from "@/lib/format";
import type { DecayRow, Dist } from "@/lib/types";

const HOP_ORDER = ["parse", "guard", "model", "signal", "risk", "order"];
const HOP_HINT: Record<string, string> = {
  parse: "decode the venue message",
  guard: "ingest guards: dedupe, schema, ordering, staleness",
  model: "reprice the contract (options smile / realized vol)",
  signal: "edge vs fees and band",
  risk: "15 pre-trade checks",
  order: "paper order state machine",
};

/** One-line takeaway computed from the sweep. */
export function decayTakeaway(rows: DecayRow[]): string | null {
  const d = rows.filter((r) => r.net != null).sort((a, b) => a.added_ms - b.added_ms);
  if (d.length < 2) return null;
  const base = d[0].net as number;
  if (!base) return null;
  const usdS = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (base < 0) {
    const last = d[d.length - 1];
    return `There is no positive edge to decay: net is ${usdS(base)} with no added latency and ${usdS(last.net as number)} at ${addedLatency(last.added_ms)}. Speed is not the problem here; the model or the costs are.`;
  }
  const at = (msv: number) => d.find((r) => r.added_ms === msv) ?? d.filter((r) => r.added_ms <= msv).pop();
  const one = at(1000);
  const ten = at(10000);
  const neg = d.find((r) => (r.net as number) < 0);
  const parts: string[] = [];
  if (one) parts.push(`${pct((one.net as number) / base, 0)} of P&L survives ${addedLatency(one.added_ms)} of extra latency`);
  if (ten && ten !== one) parts.push(`${pct((ten.net as number) / base, 0)} at ${addedLatency(ten.added_ms)}`);
  parts.push(neg ? `it turns negative by ${addedLatency(neg.added_ms)}` : "it stays positive across the sweep");
  return `${parts.join(", ")}.`;
}

export function LatencyView() {
  const { data, error, loading } = usePoll(api.getLatency, 10000);
  if (!data) return (<><PageHeader title="Latency" /><ErrorNote error={error} />{loading ? <Loading /> : null}</>);
  const rtt = data.network?.rtt ?? {};
  const lag = data.network?.feed_lag ?? {};
  const hops = data.hops ?? {};
  const decay = data.edge_decay ?? [];
  const takeaway = decayTakeaway(decay);
  const hopRows = [...HOP_ORDER.filter((h) => hops[h]), ...Object.keys(hops).filter((h) => !HOP_ORDER.includes(h))].map((h) => ({ name: h, d: hops[h] }));
  const p50sum = hopRows.reduce((a, r) => a + (r.d.n ? r.d.p50 ?? 0 : 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Latency"
        sub="How fast the desk sees the market, how long it takes to decide, and how much of the edge is left if it were slower. Order arrival in the simulator = decision time + one-way latency per venue + any added latency."
      />
      <ErrorNote error={error} />

      <Panel
        testId="edge-decay"
        title="Edge decay: net P&L vs added latency"
        sub={data.edge_decay_meta?.data ? `Same event log replayed with extra delay on every order · data: ${String(data.edge_decay_meta.data)}` : "Same event log replayed with extra delay on every order"}
        right={data.one_way_ms ? (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(data.one_way_ms).map(([v, x]) => <Badge key={v} tone="muted"><span style={{ color: venueColor(v) }}>●</span> {v} base {ms(x)}</Badge>)}
          </div>
        ) : null}
      >
        {takeaway ? (
          <p data-testid="decay-takeaway" className="mb-3 rounded-[5px] border border-brand/25 bg-brand-soft px-3 py-2 text-[13px] text-ink">
            <span className="font-semibold">Takeaway:</span> {takeaway}
          </p>
        ) : null}
        <div className="grid gap-4 xl:grid-cols-12">
          <div className="xl:col-span-8"><EdgeDecayChart rows={decay} /></div>
          <div className="xl:col-span-4">
            {decay.length ? (
              <Table testId="decay-table">
                <thead><tr><Th>Added</Th><Th right>Net</Th><Th right>Trades</Th><Th right>Fees</Th></tr></thead>
                <tbody>
                  {[...decay].sort((a, b) => a.added_ms - b.added_ms).map((r) => (
                    <tr key={r.added_ms} className="hover:bg-panel-2">
                      <Td mono>{addedLatency(r.added_ms)}</Td>
                      <Td right><Signed value={r.net}>{usd(r.net, { sign: true, digits: 0 })}</Signed></Td>
                      <Td right>{num(r.trades)}</Td>
                      <Td right className="text-ink-2">{usd(r.fees, { digits: 0 })}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
              Non-monotone is normal on a few hours of data: a later fill can land on a better price by chance. The slope over seconds is the signal; single points are noise.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Network round-trip time" sub="Measured by the recorder per source: request → response (REST) or ping → pong (WebSocket). Bins in ms; label = share of samples." testId="rtt-panel">
        <DistGrid dists={rtt} unit={ms} kind="rtt" />
      </Panel>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Internal per-hop latency" sub={`CPU time per stage of the pipeline (µs). Sum of medians ≈ ${us(p50sum)} per tick; the network dominates.`} className="xl:col-span-7" testId="hops-panel">
          <RangeBars rows={hopRows} unit={us} testId="hops-chart" />
          <p className="mb-2 mt-1 text-[11px] text-ink-3">Bar: p50 → p95 (darker) → p99 (lighter). Label: p50.</p>
          <Table>
            <thead><tr><Th>Hop</Th><Th right>n</Th><Th right>p50</Th><Th right>p95</Th><Th right>p99</Th><Th right>max</Th></tr></thead>
            <tbody>
              {hopRows.map(({ name, d }) => (
                <tr key={name} className="hover:bg-panel-2">
                  <Td><span className="font-medium">{name}</span> <span className="hidden text-[11px] text-ink-3 md:inline">{HOP_HINT[name] ?? ""}</span></Td>
                  <Td right className="text-ink-3">{compact(d.n)}</Td>
                  <Td right>{d.n ? us(d.p50) : "—"}</Td>
                  <Td right>{d.n ? us(d.p95) : "—"}</Td>
                  <Td right>{d.n ? us(d.p99) : "—"}</Td>
                  <Td right className="text-ink-3">{d.n ? us(d.max) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
        <Panel title="Feed lag" sub="Venue event timestamp → local receive time, where the venue provides one. Negative values are clock offset between the venue and this Mac." className="xl:col-span-5" testId="feed-lag-panel">
          <DistGrid dists={lag} unit={ms} kind="lag" cols="single" />
        </Panel>
      </div>
    </div>
  );
}

function DistGrid({ dists, unit, kind, cols }: { dists: Record<string, Dist>; unit: (v: number) => string; kind: string; cols?: "single" }) {
  const entries = Object.entries(dists);
  if (!entries.length) return <Empty>No samples yet.</Empty>;
  return (
    <div className={cols === "single" ? "grid gap-3" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"}>
      {entries.map(([name, d]) => {
        const venue = name.split(" ")[0];
        const color = venueColor(venue) === "var(--ink-3)" ? "var(--brand)" : venueColor(venue);
        return (
          <div key={name} data-testid={`${kind}-card`} className="rounded-[5px] border border-line bg-panel-2/60 p-3">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[13px] font-medium capitalize">
                <span className="inline-block size-2 rounded-[2px]" style={{ background: color }} />
                {name}
              </span>
              <span className="num text-[11px] text-ink-3">n = {compact(d.n)}</span>
            </div>
            <div className="num mb-2 flex gap-3 text-[12px]">
              <span><span className="text-ink-3">p50</span> {unit(d.p50 as number)}</span>
              <span><span className="text-ink-3">p95</span> {unit(d.p95 as number)}</span>
              <span><span className="text-ink-3">p99</span> {unit(d.p99 as number)}</span>
            </div>
            <Histogram dist={d} unit={unit} height={92} color={color} />
          </div>
        );
      })}
    </div>
  );
}
