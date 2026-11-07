"use client";

import { useEffect, useState } from "react";
import { AllocationBars } from "@/components/charts/analytics-charts";
import { EquityChart } from "@/components/charts/equity-chart";
import { Badge, cn, Empty, ErrorNote, Loading, PageHeader, Panel, Segmented, Stats } from "@/components/ui/kit";
import * as api from "@/lib/api";
import { useDesk } from "@/lib/desk-context";
import { useDebounced, usePoll } from "@/lib/hooks";
import { illustrativeAllocation } from "@/lib/kelly";
import { cents, edgeCents, num, pct, signedPct, usd, utcTime } from "@/lib/format";
import type { Allocation, KellyInput, KellyResult } from "@/lib/types";

export function CapitalView() {
  const { data, error, loading } = usePoll(api.getCapital, 15000);
  const { desk } = useDesk();
  if (!data) return (<><PageHeader title="Capital" /><ErrorNote error={error} />{loading ? <Loading /> : null}</>);
  const alloc: Allocation | null =
    data.allocation && (data.allocation.opps ?? []).length
      ? data.allocation
      : illustrativeAllocation((desk?.curves ?? []).slice().sort((a, b) => (b.points?.length ?? 0) - (a.points?.length ?? 0))[0], data.kelly_fraction ?? 0.25);
  const ror = data.risk_of_ruin;
  const st = data.stats;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Capital"
        sub="How much to stake. Fractional Kelly on the conservative edge (model probability minus its error band), joint sizing for strikes that share an underlying and expiry, and what the trade history implies for drawdowns."
      />
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Kelly calculator" testId="kelly-panel" className="xl:col-span-5">
          <KellyCalculator bankroll={data.bankroll ?? 10000} fraction={data.kelly_fraction ?? 0.25} />
        </Panel>
        <Panel
          title="Joint vs independent Kelly"
          testId="allocation-panel"
          className="xl:col-span-7"
          sub={alloc ? `${alloc.sym ?? ""} ${alloc.expiry_ms ? `· expiry ${utcTime(alloc.expiry_ms, false)}` : ""} · ${alloc.venue ?? ""} · fraction of bankroll per strike` : undefined}
          right={alloc?.illustrative ? <Badge tone="warn">illustrative</Badge> : null}
        >
          {alloc && alloc.opps?.length ? (
            <>
              <p className="mb-3 text-[12.5px] leading-relaxed text-ink-2">
                “BTC above $76,500” and “BTC above $77,000” at the same hour are the same bet at two thresholds: one price path settles both.
                Sizing each with its own Kelly fraction treats them as independent and <span className="font-semibold text-ink">over-bets</span>.
                The joint allocation maximises expected log growth over simulated settlement prices, so correlated strikes share one budget.
              </p>
              <AllocationBars opps={alloc.opps} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4 text-[11.5px] text-ink-2">
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-[2px] bg-ink-3/60" /> independent Kelly</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-[2px] bg-brand" /> joint Kelly</span>
                </div>
                <div className="num text-[12.5px]" data-testid="allocation-totals">
                  total <span className="text-ink-2">{pct(alloc.independent_total)}</span> → <span className="font-semibold text-brand">{pct(alloc.joint_total)}</span> of bankroll
                  {alloc.independent_total ? <span className="text-ink-3"> ({pct(1 - (alloc.joint_total ?? 0) / alloc.independent_total, 0)} less)</span> : null}
                </div>
              </div>
              {alloc.illustrative ? (
                <p className="mt-2 text-[11px] text-ink-3">
                  No positive-edge set right now, so this example prices each strike 4¢ under the model on the current curve and solves the same problem in the browser. Not a live allocation.
                </p>
              ) : null}
            </>
          ) : <Empty>No correlated opportunity set to size right now.</Empty>}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Risk of ruin" testId="ruin-panel" className="xl:col-span-5" sub={ror?.n_source_trades ? `Bootstrap of ${num(ror.n_source_trades)} trade returns · ${num(ror.paths)} paths × ${num(ror.n_trades)} trades` : undefined}>
          {ror?.n_source_trades ? (
            <>
              <div className="mb-4 flex items-end gap-6">
                <div>
                  <div className="label">P(ruin)</div>
                  <div data-testid="p-ruin" className={cn("num text-[30px] font-medium leading-tight", (ror.p_ruin ?? 0) > 0.05 ? "text-neg" : "text-ink")}>{pct(ror.p_ruin, 1)}</div>
                  <div className="text-[11px] text-ink-3">equity ever below {pct(ror.ruin_level, 0)} of start</div>
                </div>
                <PercentileStrip label="Final equity × start" lo={ror.final_p5} mid={ror.final_p50} hi={ror.final_p95} fmt={(v) => `${v.toFixed(2)}×`} />
              </div>
              <Stats rows={[
                ["Max drawdown, median path", signedPct(ror.max_dd_p50)],
                ["Max drawdown, worst 5% of paths", signedPct(ror.max_dd_p5)],
                ["Final equity p5 / p50 / p95", `${ror.final_p5?.toFixed(2)}× / ${ror.final_p50?.toFixed(2)}× / ${ror.final_p95?.toFixed(2)}×`],
              ]} />
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">Assumes trades are independent and the past return distribution repeats. Both are optimistic, so read this as a floor on risk, not a forecast.</p>
            </>
          ) : <Empty>Needs settled trades.</Empty>}
        </Panel>
        <Panel title="Per-trade statistics" testId="stats-panel" className="xl:col-span-3">
          <Stats rows={[
            ["Trades", num(st?.n)],
            ["Mean return", signedPct(st?.mean, 2)],
            ["Std dev", pct(st?.sd, 2)],
            ["Sharpe per trade", num(st?.sharpe_per_trade, 2)],
            ["Hit rate", pct(st?.hit_rate)],
          ]} />
          {st?.caveat ? <p data-testid="stats-caveat" className="mt-3 rounded-[5px] border border-warn/30 bg-warn-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-2">{st.caveat}</p> : null}
        </Panel>
        <Panel title="Equity" className="xl:col-span-4" sub={`Max drawdown ${usd(data.max_drawdown)}`}>
          <EquityChart points={data.equity_curve ?? []} bankroll={data.bankroll} height={240} testId="capital-equity" />
        </Panel>
      </div>
    </div>
  );
}

function PercentileStrip({ label, lo, mid, hi, fmt }: { label: string; lo?: number; mid?: number; hi?: number; fmt: (v: number) => string }) {
  if (lo == null || mid == null || hi == null) return null;
  const min = Math.min(lo, 1) * 0.9;
  const max = hi * 1.05;
  const X = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className="min-w-0 flex-1">
      <div className="label mb-2">{label}</div>
      <div className="relative h-7">
        <div className="absolute top-3 h-1 w-full rounded-full bg-grid" />
        <div className="absolute top-2.5 h-2 rounded-full bg-brand/35" style={{ left: X(lo), width: `calc(${X(hi)} - ${X(lo)})` }} />
        <div className="absolute top-1.5 h-4 w-0.5 bg-brand" style={{ left: X(mid) }} />
        <div className="absolute top-1.5 h-4 w-px bg-ink-3" style={{ left: X(1) }} title="start" />
      </div>
      <div className="num flex justify-between text-[10.5px] text-ink-3">
        <span>p5 {fmt(lo)}</span><span className="text-ink">p50 {fmt(mid)}</span><span>p95 {fmt(hi)}</span>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-0.5 block text-[10.5px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

const inputCls = "num h-8 w-full rounded-[5px] border border-line bg-panel-2 px-2 text-[13px] outline-none focus:border-brand";

function KellyCalculator({ bankroll, fraction }: { bankroll: number; fraction: number }) {
  const [inp, setInp] = useState<KellyInput>({ p: 0.62, price: 0.55, venue: "kalshi", band: 0.02, fraction, bankroll });
  const [res, setRes] = useState<KellyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useDebounced(inp, 120);

  useEffect(() => {
    let alive = true;
    api.kellyCalc(q).then(
      (r) => alive && (setRes(r), setErr(null)),
      (e) => alive && setErr(api.errorMessage(e)),
    );
    return () => void (alive = false);
  }, [q]);

  const set = (k: keyof KellyInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    setInp((s) => ({ ...s, [k]: k === "p" || k === "price" || k === "band" ? v / 100 : k === "fraction" ? v / 100 : v }));
  };
  const edge = res?.edge ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Model prob. (%)" hint="P(contract pays)">
          <input data-testid="kelly-p" type="number" step="0.5" min={1} max={99} value={+(inp.p * 100).toFixed(2)} onChange={set("p")} className={inputCls} />
        </Field>
        <Field label="Price (¢)" hint="ask you would pay">
          <input data-testid="kelly-price" type="number" step="1" min={1} max={99} value={+(inp.price * 100).toFixed(2)} onChange={set("price")} className={inputCls} />
        </Field>
        <Field label="Venue" hint="fee 7% × P × (1 − P)">
          <Segmented value={inp.venue} onChange={(v) => setInp((s) => ({ ...s, venue: v }))} options={[{ value: "kalshi", label: "Kalshi" }, { value: "polymarket", label: "Polymarket" }]} testIdPrefix="kelly-venue" />
        </Field>
        <Field label="Error band (pp)" hint="sized on p − band">
          <input data-testid="kelly-band" type="number" step="0.5" min={0} max={50} value={+(inp.band * 100).toFixed(2)} onChange={set("band")} className={inputCls} />
        </Field>
        <Field label="Kelly fraction (%)" hint="of full Kelly">
          <input data-testid="kelly-fraction" type="number" step="5" min={1} max={100} value={+(inp.fraction * 100).toFixed(1)} onChange={set("fraction")} className={inputCls} />
        </Field>
        <Field label="Bankroll ($)">
          <input data-testid="kelly-bankroll" type="number" step="1000" min={1} value={inp.bankroll} onChange={set("bankroll")} className={inputCls} />
        </Field>
      </div>
      <input
        aria-label="Model probability"
        type="range"
        min={1}
        max={99}
        step={0.5}
        value={inp.p * 100}
        onChange={set("p")}
        className="w-full accent-[var(--brand)]"
      />
      {err ? <p className="text-[12px] text-neg">{err}</p> : null}
      <div data-testid="kelly-output" className="rounded-[5px] border border-line bg-panel-2 p-3">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label">Buy</div>
            <div className="num text-[26px] font-medium leading-tight">
              <span data-testid="kelly-contracts">{num(res?.contracts)}</span> <span className="text-[13px] text-ink-3">contracts</span>
            </div>
          </div>
          <div className="text-right">
            <div className="label">Stake</div>
            <div data-testid="kelly-stake" className="num text-[20px] font-medium leading-tight text-brand">{usd(res?.stake)}</div>
            <div className="num text-[11px] text-ink-3">{pct(res?.fraction_used, 2)} of bankroll</div>
          </div>
        </div>
        <Stats rows={[
          ["Cost per contract (price + fee)", cents(res?.cost_per_contract, 2)],
          ["Edge (p − cost)", <span key="e" className={cn((edge ?? 0) > 0 ? "text-pos" : "text-neg")}>{edgeCents(res?.edge, 2)}</span>],
          ["Conservative edge (p − band − cost)", edgeCents(res?.edge_conservative, 2)],
          ["Full Kelly", pct(res?.kelly_full, 2)],
          ["Kelly on conservative edge", pct(res?.kelly_conservative, 2)],
          ["Expected log growth / bet", res?.expected_log_growth != null ? res.expected_log_growth.toFixed(5) : "—"],
        ]} />
        {res && (res.contracts ?? 0) === 0 ? <p className="mt-2 text-[11.5px] text-ink-3">No bet: the conservative edge does not cover the price plus fee.</p> : null}
      </div>
    </div>
  );
}
