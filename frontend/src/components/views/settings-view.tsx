"use client";

import { ExternalLink, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { Button, cn, ErrorNote, Loading, PageHeader, Panel } from "@/components/ui/kit";
import * as api from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import type { Limits, Settings, SettingsUpdate } from "@/lib/types";
import { KumoCard } from "./shared";

const inputCls = "num h-9 w-full rounded-full border border-transparent bg-panel-2 px-3.5 text-[13px] outline-none focus:border-ink-3";

type Field = { key: keyof SettingsUpdate; label: string; hint: string; scale?: number; step?: number; unit?: string };
const FIELDS: Field[] = [
  { key: "min_edge", label: "Min edge", hint: "after fees and band, per contract", scale: 100, step: 0.5, unit: "¢" },
  { key: "band_k", label: "Band multiplier k", hint: "edge must clear k × model error band", step: 0.25 },
  { key: "kelly_fraction", label: "Kelly fraction", hint: "share of full Kelly to bet", scale: 100, step: 5, unit: "%" },
  { key: "bankroll", label: "Bankroll", hint: "paper money", step: 1000, unit: "$" },
  { key: "added_latency_ms", label: "Added latency", hint: "extra delay on every order", step: 50, unit: "ms" },
  { key: "depth_haircut", label: "Depth haircut", hint: "take at most this share of shown size", scale: 100, step: 5, unit: "%" },
  { key: "lookback_h", label: "Lookback", hint: "hours of log folded at startup", step: 1, unit: "h" },
];

const LIMIT_LABEL: Record<string, string> = {
  max_cost_per_market: "Max cost per market ($)",
  max_cost_per_expiry: "Max cost per expiry ($)",
  max_cost_per_underlying: "Max cost per underlying ($)",
  max_gross: "Max gross exposure ($)",
  max_open_orders: "Max open orders",
  daily_loss_limit: "Daily loss limit ($)",
  max_book_age_s: "Max book age (s)",
  max_spot_age_s: "Max spot age (s)",
  max_chain_age_s: "Max options-chain age (s)",
  min_price: "Min price (0-1)",
  max_price: "Max price (0-1)",
  max_edge: "Max edge (0-1)",
  max_limit_vs_fair: "Max limit vs fair (0-1)",
};

export function SettingsView() {
  const { data, error, loading, refresh } = usePoll(api.getSettings);
  if (!data) return (<><PageHeader title="Settings" /><ErrorNote error={error} />{loading ? <Loading /> : null}</>);
  return <SettingsForm initial={data} onSaved={refresh} />;
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: () => Promise<void> }) {
  const [s, setS] = useState<Settings>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [kBusy, setKBusy] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body: SettingsUpdate = {
        trade_model: s.trade_model, min_edge: s.min_edge, band_k: s.band_k, kelly_fraction: s.kelly_fraction, bankroll: s.bankroll,
        order_style: s.order_style, added_latency_ms: s.added_latency_ms, depth_haircut: s.depth_haircut, lookback_h: s.lookback_h,
        limits: s.limits,
      };
      await api.putSettings(body);
      setMsg({ ok: true, text: "Saved. The desk is re-folding the event log with the new settings." });
      await onSaved();
    } catch (e) {
      setMsg({ ok: false, text: api.errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKumo(on: boolean) {
    setKBusy(true);
    try {
      await api.putSettings({ kumo_enabled: on });
      await onSaved();
    } catch (e) {
      setMsg({ ok: false, text: api.errorMessage(e) });
    } finally {
      setKBusy(false);
    }
  }

  const num = (k: keyof Settings) => (s[k] as number | undefined) ?? 0;
  const models = s.models?.length ? s.models : ["options", "hybrid", "ensemble", "realized"];
  const styles = s.order_styles?.length ? s.order_styles : ["taker", "maker"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        sub="Trading parameters of the paper desk. Saving restarts the desk, which re-folds the event log (the lookback window) with the new settings: past signals, orders and P&L are recomputed, so what you see is always what these settings would have done."
        right={
          <div className="flex gap-2">
            <Button onClick={() => setS(initial)} disabled={!dirty || busy}><RotateCcw className="size-3.5" /> Reset</Button>
            <Button variant="primary" onClick={save} loading={busy} disabled={!dirty} data-testid="settings-save"><Save className="size-3.5" /> Save and re-fold</Button>
          </div>
        }
      />
      {msg ? (
        <div role="status" data-testid="settings-msg" className={cn("rounded-2xl px-4 py-2.5 text-[12.5px]", msg.ok ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg")}>{msg.text}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Strategy" testId="settings-strategy" className="xl:col-span-7">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label">Trade model</span>
              <select data-testid="settings-model" value={s.trade_model ?? "hybrid"} onChange={(e) => setS({ ...s, trade_model: e.target.value })} className={cn(inputCls, "mt-1")}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="mt-0.5 block text-[10.5px] text-ink-3">probability used for signals</span>
            </label>
            <label className="block">
              <span className="label">Order style</span>
              <select value={s.order_style ?? "taker"} onChange={(e) => setS({ ...s, order_style: e.target.value })} className={cn(inputCls, "mt-1")}>
                {styles.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="mt-0.5 block text-[10.5px] text-ink-3">taker = IOC at the touch</span>
            </label>
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="label">{f.label}{f.unit ? ` (${f.unit})` : ""}</span>
                <input
                  data-testid={`settings-${f.key}`}
                  type="number"
                  step={f.step}
                  value={+(num(f.key as keyof Settings) * (f.scale ?? 1)).toFixed(4)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setS({ ...s, [f.key]: v / (f.scale ?? 1) });
                  }}
                  className={cn(inputCls, "mt-1")}
                />
                <span className="mt-0.5 block text-[10.5px] text-ink-3">{f.hint}</span>
              </label>
            ))}
          </div>
        </Panel>
        <div className="space-y-4 xl:col-span-5">
          <Panel title="KumoRFM" testId="settings-kumo">
            <KumoCard kumo={s.kumo} onToggle={toggleKumo} busy={kBusy} />
          </Panel>
          <Panel title="Links">
            <ul className="space-y-1.5 text-[13px]">
              {[
                [`${api.API_URL}/docs`, "API reference (FastAPI / OpenAPI)"],
                [`${api.API_URL}/api/health`, "Health endpoint"],
                [`${api.API_URL}/api/events?limit=50`, "Raw event stream (last 50)"],
              ].map(([href, label]) => (
                <li key={href}>
                  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ink-2 underline-offset-2 hover:text-brand hover:underline">
                    <ExternalLink className="size-3.5" /> {label}
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11.5px] text-ink-3">Data source: <span className="num">{s.source ?? "—"}</span>. Paper only: no exchange accounts, no keys, no real orders.</p>
          </Panel>
        </div>
      </div>

      <Panel title="Risk limits" testId="settings-limits">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(s.limits ?? {}).map(([k, v]) => (
            <label key={k} className="block">
              <span className="text-[11.5px] text-ink-3">{LIMIT_LABEL[k] ?? k}</span>
              <input
                type="number"
                value={v ?? 0}
                step={k.includes("price") || k.includes("edge") || k.includes("fair") ? 0.01 : 1}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setS({ ...s, limits: { ...(s.limits as Limits), [k]: n } });
                }}
                className={cn(inputCls, "mt-0.5")}
              />
            </label>
          ))}
        </div>
      </Panel>
    </div>
  );
}
