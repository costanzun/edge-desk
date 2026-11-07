"use client";

import { Check, Copy, Fingerprint, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { EdgeDecayChart } from "@/components/charts/analytics-charts";
import { EquityChart } from "@/components/charts/equity-chart";
import { Waterfall } from "@/components/charts/bars";
import { Badge, Button, cn, Empty, ErrorNote, HeroKpi, Kpi, KpiRow, PageHeader, Panel, Segmented, Signed } from "@/components/ui/kit";
import * as api from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { bytes, compact, num, pct, usd } from "@/lib/format";
import type { ReplayJob, ReplayRequest } from "@/lib/types";
import { AttributionTable } from "./shared";
import { decayTakeaway } from "./latency-view";

const inputCls = "num h-8 w-full rounded-[5px] border border-line bg-panel-2 px-2 text-[13px] outline-none focus:border-brand disabled:opacity-50";
/** "2026-11-07T12:00Z" -> epoch ms */
const hourMs = (h: string) => Date.parse(h);

export function ReplayView() {
  const periods = usePoll(api.getPeriods);
  const hours = periods.data?.hours ?? [];
  const [mode, setMode] = useState<"window" | "synthetic">("window");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [model, setModel] = useState("hybrid");
  const [minEdge, setMinEdge] = useState(2);
  const [bandK, setBandK] = useState(1);
  const [added, setAdded] = useState(0);
  const [decay, setDecay] = useState(false);
  const [lats, setLats] = useState("0, 250, 1000, 5000, 10000, 30000, 60000");
  const [job, setJob] = useState<ReplayJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const fromH = from || hours[0]?.hour || "";
  const toH = to || hours[hours.length - 1]?.hour || "";
  const running = !!job && job.status !== "done" && job.status !== "error";

  useEffect(() => {
    if (!job || !running) return;
    const id = window.setInterval(() => {
      api.getReplay(job.id).then(setJob, (e) => setErr(api.errorMessage(e)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [job, running]);

  async function run() {
    setErr(null);
    setStarting(true);
    const body: ReplayRequest = {
      settings: { trade_model: model, min_edge: minEdge / 100, band_k: bandK, added_latency_ms: added },
    };
    if (mode === "synthetic") body.synthetic = true;
    else if (fromH && toH) {
      body.start_ms = hourMs(fromH);
      body.end_ms = hourMs(toH) + 3600_000;
    }
    if (decay) {
      const xs = lats.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0).slice(0, 12);
      if (xs.length) body.latencies_ms = xs;
    }
    try {
      setJob(await api.startReplay(body));
    } catch (e) {
      setErr(api.errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  const res = job?.status === "done" ? job.result : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Replay"
        sub="Re-run the engine over recorded market data (or a synthetic market) with different settings. The engine is a pure fold over the event log with event-time clocks, so the same input and settings always give the same trades and the same digest."
      />
      <ErrorNote error={periods.error} />

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Recorded hours" testId="periods" className="xl:col-span-4" bodyClass="p-0">
          {hours.length === 0 ? <Empty>No recorded hours yet.</Empty> : (
            <ul className="max-h-[380px] divide-y divide-line border-t border-line overflow-y-auto">
              {hours.map((h) => {
                const inWin = mode === "window" && h.hour >= fromH && h.hour <= toH;
                return (
                  <li key={h.hour} className={cn("flex items-center gap-2.5 px-4 py-2 text-[12.5px]", inWin && "bg-brand-soft/60")}>
                    <span className={cn("inline-block size-1.5 rounded-full", inWin ? "bg-brand" : "bg-line")} />
                    <span className="num">{h.hour.replace("T", " ").replace("Z", " UTC")}</span>
                    <span className="num ml-auto text-ink-3">{bytes(h.bytes)}</span>
                    {h.compressed === false ? <Badge tone="pos">recording</Badge> : <span className="w-[70px] text-right text-[11px] text-ink-3">gz</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Run a replay" testId="replay-form" className="xl:col-span-8">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={mode}
                onChange={setMode}
                size="md"
                testIdPrefix="replay-mode"
                options={[{ value: "window", label: "Recorded window" }, { value: "synthetic", label: "Synthetic market" }]}
              />
              <span className="text-[12px] text-ink-3">
                {mode === "synthetic" ? "4 hours of generated quotes and settlements, fixed seed: useful to test the machinery." : "Real recorded quotes from the venues, replayed in event time."}
              </span>
            </div>
            {mode === "window" ? (
              <div className="grid grid-cols-2 gap-3 sm:max-w-md">
                <label><span className="label">From</span>
                  <select data-testid="replay-from" value={fromH} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, "mt-1")}>
                    {hours.map((h) => <option key={h.hour} value={h.hour}>{h.hour.replace("T", " ").replace("Z", " UTC")}</option>)}
                  </select>
                </label>
                <label><span className="label">To (incl.)</span>
                  <select data-testid="replay-to" value={toH} onChange={(e) => setTo(e.target.value)} className={cn(inputCls, "mt-1")}>
                    {hours.filter((h) => h.hour >= fromH).map((h) => <option key={h.hour} value={h.hour}>{h.hour.replace("T", " ").replace("Z", " UTC")}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
            <div>
              <div className="label mb-1.5">Settings overrides</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label><span className="text-[11.5px] text-ink-3">Model</span>
                  <select data-testid="replay-model" value={model} onChange={(e) => setModel(e.target.value)} className={cn(inputCls, "mt-0.5")}>
                    {["hybrid", "options", "ensemble", "realized"].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label><span className="text-[11.5px] text-ink-3">Min edge (¢)</span>
                  <input type="number" step={0.5} min={0} max={50} value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))} className={cn(inputCls, "mt-0.5")} />
                </label>
                <label><span className="text-[11.5px] text-ink-3">Band k</span>
                  <input type="number" step={0.25} min={0} max={5} value={bandK} onChange={(e) => setBandK(Number(e.target.value))} className={cn(inputCls, "mt-0.5")} />
                </label>
                <label><span className="text-[11.5px] text-ink-3">Added latency (ms)</span>
                  <input type="number" step={50} min={0} value={added} onChange={(e) => setAdded(Number(e.target.value))} className={cn(inputCls, "mt-0.5")} />
                </label>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" data-testid="replay-decay" checked={decay} onChange={(e) => setDecay(e.target.checked)} className="accent-[var(--brand)]" />
                Also sweep edge decay at
              </label>
              <input disabled={!decay} value={lats} onChange={(e) => setLats(e.target.value)} className={cn(inputCls, "w-auto min-w-0 flex-1 sm:max-w-sm")} aria-label="Latencies in ms" />
              <span className="text-[11px] text-ink-3">ms, up to 12</span>
            </div>
            <div className="flex items-center gap-3 border-t border-line pt-3">
              <Button variant="primary" onClick={run} loading={starting || running} disabled={running} data-testid="replay-run">
                {!(starting || running) ? <Play className="size-4" /> : null}
                {running ? `Running (${job?.status})…` : "Run replay"}
              </Button>
              {err ? <span className="text-[12.5px] text-neg">{err}</span> : null}
              {job?.status === "error" ? <span className="text-[12.5px] text-neg">{job.error}</span> : null}
              {job && !running && job.status === "done" ? <span className="num text-[12px] text-ink-3">job {job.id} · {compact(job.records)} records</span> : null}
            </div>
          </div>
        </Panel>
      </div>

      {res ? (
        <div data-testid="replay-result" className="fade-in space-y-4">
          <Digest digest={res.digest} events={res.events} seconds={res.seconds} />
          <KpiRow
            hero={<HeroKpi label="Net P&L after fees" hint="What this replay's paper account made or lost after fees. Positive is good." value={<Signed value={res.summary?.net_total}>{usd(res.summary?.net_total, { sign: true })}</Signed>} detail={<>{usd(res.summary?.net_settled, { sign: true })} settled</>} />}
          >
            <Kpi label="Trades" hint="Paper orders that bought at least one contract." value={num(res.summary?.trades)} sub={`${num(res.summary?.settled)} settled`} />
            <Kpi label="Win rate" hint="Share of settled paper trades that made money." value={pct(res.summary?.win_rate)} />
            <Kpi label="Fees" hint="Venue fees paid in this replay." value={usd(res.summary?.fees)} />
            <Kpi label="Signals → orders" hint="Gaps big enough to act on, and how many became orders after the risk checks." value={`${compact(res.summary?.signals)} → ${compact(res.summary?.orders)}`} />
            <Kpi label="Return on cost" hint="Net P&L divided by money spent on contracts." value={pct(res.summary?.return_on_cost)} />
            <Kpi label="Equity" hint="Final paper account value." value={usd(res.summary?.equity, { digits: 0 })} />
          </KpiRow>
          <div className="grid gap-4 xl:grid-cols-12">
            <Panel title="Equity curve" className="xl:col-span-7"><EquityChart points={res.equity_curve ?? []} bankroll={res.summary?.bankroll} testId="replay-equity" /></Panel>
            <Panel title="Attribution" className="xl:col-span-5">{res.attribution?.total ? <Waterfall total={res.attribution.total} height={300} testId="replay-waterfall" /> : <Empty>No trades.</Empty>}</Panel>
          </div>
          <Panel title="Attribution breakdown" bodyClass="pb-0"><AttributionTable attribution={res.attribution} /></Panel>
          {res.edge_decay?.length ? (
            <Panel title="Edge decay sweep" testId="replay-decay-panel" sub={decayTakeaway(res.edge_decay) ?? undefined}>
              <EdgeDecayChart rows={res.edge_decay} testId="replay-decay-chart" />
            </Panel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Digest({ digest, events, seconds }: { digest?: string; events?: number; seconds?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <section data-testid="replay-digest" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-brand/30 bg-brand-soft px-4 py-3">
      <Fingerprint className="size-6 shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <div className="label">Event-log digest · deterministic: same digest every run</div>
        <div data-testid="digest-value" className="num mt-0.5 break-all text-[13px] text-ink">{digest ?? "—"}</div>
      </div>
      <div className="num text-right text-[12px] text-ink-2">
        {compact(events)} events · {seconds != null ? `${seconds.toFixed(1)} s` : "—"}
        {events && seconds ? <div className="text-[11px] text-ink-3">{compact(events / seconds)} events/s</div> : null}
      </div>
      <Button
        size="sm"
        onClick={() => {
          if (!digest) return;
          navigator.clipboard?.writeText(digest).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }, () => {});
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </Button>
    </section>
  );
}
