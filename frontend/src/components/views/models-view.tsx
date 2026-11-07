"use client";

import { useState } from "react";
import { modelColor, ReliabilityDiagram } from "@/components/charts/analytics-charts";
import { Legend } from "@/components/charts/core";
import { Badge, cn, Empty, ErrorNote, Loading, PageHeader, Panel, Segmented, Stats, Table, Td, Th } from "@/components/ui/kit";
import * as api from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { num, pct, signedPct, venueLabel } from "@/lib/format";
import type { Calibration, Report } from "@/lib/types";
import { KumoCard } from "./shared";

export function ModelsView() {
  const models = usePoll(api.getModels, 30000);
  const report = usePoll(api.getReport);
  const [scope, setScope] = useState("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [kErr, setKErr] = useState<string | null>(null);
  const d = models.data;
  if (!d) return (<><PageHeader title="Models" /><ErrorNote error={models.error} />{models.loading ? <Loading /> : null}</>);

  const scopes: { value: string; label: string; cal?: Calibration | null }[] = [
    { value: "all", label: "All", cal: d.all },
    ...Object.entries(d.by_venue ?? {}).map(([k, v]) => ({ value: `venue:${k}`, label: venueLabel(k), cal: v })),
    ...Object.entries(d.by_sym ?? {}).map(([k, v]) => ({ value: `sym:${k}`, label: k, cal: v })),
  ];
  // optional offline evaluation (larger, reconstructed sample) when the backend has one
  const ev = (d.evaluation ?? null) as (Calibration & { all?: Calibration }) | null;
  const evCal = ev?.all?.models ? ev.all : ev?.models ? ev : null;
  if (evCal) scopes.push({ value: "eval", label: "Offline evaluation", cal: evCal });
  const cur = scopes.find((s) => s.value === scope) ?? scopes[0];
  const cal = cur.cal;
  const ms = cal?.models ?? {};
  const labels = { ...(d.labels ?? {}) };
  const keys = Object.keys(ms);
  const mid = ms.mid?.brier;
  const best = keys.filter((k) => k !== "mid").reduce<string | null>((b, k) => (b == null || (ms[k].brier ?? 9) < (ms[b].brier ?? 9) ? k : b), null);

  async function toggleKumo(on: boolean) {
    setBusy(true);
    setKErr(null);
    try {
      await api.putSettings({ kumo_enabled: on });
      await models.refresh();
    } catch (e) {
      setKErr(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Models"
        sub="Are the probabilities honest? Each model's prediction for a contract is scored against how it settled. Lower Brier score and log loss are better; the market mid is the baseline to beat."
        right={
          <Segmented
            value={cur.value}
            onChange={setScope}
            testIdPrefix="scope"
            options={scopes.map((s) => ({ value: s.value, label: s.value.startsWith("sym:") ? <>Underlying: {s.label}</> : s.label }))}
          />
        }
      />
      <ErrorNote error={models.error} />

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Reliability diagram" info="If a model says 30%, the event should happen about 30% of the time. Points on the dashed diagonal mean honest probabilities; above it the model was too pessimistic, below too optimistic." testId="reliability-panel" className="xl:col-span-7" sub="Predicted probability (binned) vs the share of contracts that settled YES. On the diagonal = calibrated. Dot size = snapshots in the bin.">
          {keys.length ? (
            <>
              <ReliabilityDiagram models={ms} labels={labels} hidden={hidden} />
              <div className="mt-2">
                <Legend
                  items={keys.map((k) => ({
                    label: labels[k] ?? ms[k].label ?? k,
                    color: modelColor(k),
                    kind: k === "mid" ? ("dash" as const) : ("line" as const),
                    off: hidden.has(k),
                    testId: `legend-${k}`,
                    onClick: () => setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(k)) n.delete(k);
                      else n.add(k);
                      return n;
                    }),
                  }))}
                />
              </div>
            </>
          ) : <Empty className="h-80">No resolved contracts yet: calibration needs settled markets.</Empty>}
        </Panel>

        <div className="space-y-4 xl:col-span-5">
          <Panel title="Sample" info="How much resolved data the scores are based on. More hourly events = more trustworthy comparison." testId="sample-panel">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Mini label="Snapshots" v={num(cal?.n_snapshots)} />
              <Mini label="Contracts" v={num(cal?.n_contracts)} />
              <Mini label="Hourly events" v={num(cal?.n_events)} />
              <Mini label="Base rate YES" v={pct(cal?.base_rate)} />
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
              Snapshots of one contract, and contracts of one hourly event, are strongly correlated: the effective sample size is closer to the number of events
              ({num(cal?.n_events)}) than to the number of snapshots. Treat small differences between models as noise.
            </p>
          </Panel>
          <Panel title="KumoRFM" info="An optional extra model from Kumo. Off unless an API key is set." testId="kumo-panel" right={d.kumo?.available ? <Badge tone={d.kumo.enabled ? "pos" : "muted"}>{d.kumo.enabled ? "on" : "off"}</Badge> : <Badge tone="muted">disabled</Badge>}>
            <KumoCard kumo={d.kumo} onToggle={toggleKumo} busy={busy} />
            {kErr ? <p className="mt-2 text-[12px] text-neg">{kErr}</p> : null}
          </Panel>
        </div>
      </div>

      <Panel title={`Scores · ${cur.label}`} info="Brier score and log loss measure probability error; lower is better. Skill vs mid compares each model with the market price itself: positive means the model forecast better than the market." testId="scores-table" bodyClass="py-0">
        {keys.length === 0 ? <Empty>No scores yet.</Empty> : (
          <Table>
            <thead>
              <tr><Th>Model</Th><Th right>n</Th><Th right>Brier</Th><Th right>Skill vs mid</Th><Th right>Log loss</Th><Th className="w-[28%]">Brier (lower is better)</Th></tr>
            </thead>
            <tbody>
              {[...keys].sort((a, b) => (ms[a].brier ?? 9) - (ms[b].brier ?? 9)).map((k) => {
                const m = ms[k];
                const skill = mid && m.brier != null && k !== "mid" ? 1 - m.brier / mid : null;
                const maxB = Math.max(...keys.map((x) => ms[x].brier ?? 0));
                return (
                  <tr key={k} data-testid="score-row" className={cn("hover:bg-panel-2", k === best && "bg-brand-soft/50")}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="inline-block size-2.5 rounded-[2px]" style={{ background: modelColor(k) }} />
                        <span className="font-medium">{labels[k] ?? m.label ?? k}</span>
                        {k === best ? <Badge tone="brand">best</Badge> : null}
                        {k === "mid" ? <Badge tone="muted">baseline</Badge> : null}
                      </span>
                    </Td>
                    <Td right className="text-ink-3">{num(m.n)}</Td>
                    <Td right className={cn(k === best && "font-semibold")}>{m.brier?.toFixed(4) ?? "—"}</Td>
                    <Td right className={cn(skill == null ? "text-ink-3" : skill > 0 ? "text-pos" : "text-neg")}>{skill == null ? "—" : signedPct(skill, 1)}</Td>
                    <Td right>{m.log_loss?.toFixed(4) ?? "—"}</Td>
                    <Td>
                      <div className="h-1.5 overflow-hidden rounded-full bg-grid">
                        <div className="h-full rounded-full" style={{ width: `${((m.brier ?? 0) / (maxB || 1)) * 100}%`, background: modelColor(k) }} />
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="py-2 text-[11px] text-ink-3">Skill vs mid = 1 − Brier(model) / Brier(market mid). Positive means the model beat the market’s own price as a forecast.</p>
      </Panel>

      {report.data ? <ReportPanel report={report.data} /> : null}
    </div>
  );
}

function Mini({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-[20px] bg-panel-2 px-2.5 py-2">
      <div className="num text-[16px] font-medium">{v}</div>
      <div className="text-[10.5px] uppercase tracking-wide text-ink-3">{label}</div>
    </div>
  );
}

/** The optional evaluation report (GET /api/report): scalar fields as a table, text as prose. */
function ReportPanel({ report }: { report: Report }) {
  const scalars = Object.entries(report).filter(([, v]) => v == null || ["string", "number", "boolean"].includes(typeof v));
  const text = scalars.filter(([, v]) => typeof v === "string" && (v as string).length > 80);
  const short = scalars.filter(([k]) => !text.find(([t]) => t === k));
  return (
    <Panel title="Evaluation report" testId="report-panel">
      {text.map(([k, v]) => <p key={k} className="mb-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{String(v)}</p>)}
      {short.length ? <Stats rows={short.map(([k, v]) => [k.replace(/_/g, " "), typeof v === "number" ? num(v, Number.isInteger(v) ? 0 : 4) : String(v ?? "—")])} className="max-w-xl" /> : null}
      {!text.length && !short.length ? <p className="text-[12.5px] text-ink-3">Report available via the API (structured data).</p> : null}
    </Panel>
  );
}
