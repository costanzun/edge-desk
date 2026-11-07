"use client";

import { useState } from "react";
import { ATTR_KEYS } from "@/components/charts/bars";
import { Empty, Segmented, Signed, Table, Td, Th } from "@/components/ui/kit";
import { num, usd } from "@/lib/format";
import type { Attribution, KumoStatus } from "@/lib/types";

const DIMS = [
  { value: "venue", label: "Venue" },
  { value: "pairing", label: "Pairing" },
  { value: "tte_bucket", label: "Time to expiry" },
  { value: "edge_bucket", label: "Edge bucket" },
  { value: "model", label: "Model" },
] as const;
type Dim = (typeof DIMS)[number]["value"];

/** Attribution breakdown table with a dimension switch. */
export function AttributionTable({ attribution }: { attribution?: Attribution | null }) {
  const [dim, setDim] = useState<Dim>("venue");
  const by = attribution?.by ?? {};
  const rows = Object.entries(by[dim] ?? {});
  const dims = DIMS.filter((d) => by[d.value]);
  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <Segmented value={dim} onChange={setDim} options={dims.length ? [...dims] : [...DIMS]} testIdPrefix="attr-dim" />
      </div>
      {rows.length === 0 ? <Empty>No trades to attribute yet.</Empty> : (
        <Table testId="attr-table">
          <thead>
            <tr>
              <Th>{DIMS.find((d) => d.value === dim)?.label}</Th>
              <Th right>Trades</Th>
              {ATTR_KEYS.map((k) => <Th key={k.key} right title={k.hint}>{k.label}</Th>)}
              <Th right>Net</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, r]) => (
              <tr key={k} className="hover:bg-panel-2">
                <Td className="font-medium capitalize">{k}</Td>
                <Td right>{num(r.n)}</Td>
                {ATTR_KEYS.map((a) => (
                  <Td key={a.key} right className={(r[a.key] ?? 0) < 0 ? "text-neg" : (r[a.key] ?? 0) > 0 ? "text-ink" : "text-ink-3"}>
                    {usd(r[a.key], { sign: true })}
                  </Td>
                ))}
                <Td right className="font-semibold"><Signed value={r.pnl}>{usd(r.pnl, { sign: true })}</Signed></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** KumoRFM status + toggle; used on /models and /settings. */
export function KumoCard({ kumo, onToggle, busy }: { kumo?: KumoStatus | null; onToggle?: (on: boolean) => void; busy?: boolean }) {
  const available = !!kumo?.available;
  const enabled = !!kumo?.enabled;
  return (
    <div data-testid="kumo-card" className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        KumoRFM is a relational foundation model. When enabled it adds a fifth probability, <span className="num">p_kumo</span>, predicted from the event log
        tables (contracts, quotes, outcomes), scored on the same calibration set. It is optional: everything else runs without it.
      </p>
      <div className="flex items-center justify-between gap-3 rounded-[5px] border border-line bg-panel-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Use KumoRFM predictions</div>
          <div data-testid="kumo-message" className="text-[11.5px] text-ink-3">
            {available ? (kumo?.message || (kumo?.active ? "active" : "available")) : kumo?.message || "Set KUMO_API_KEY in .env to enable"}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="kumo-toggle"
          disabled={!available || busy || !onToggle}
          onClick={() => onToggle?.(!enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${enabled ? "border-brand bg-brand" : "border-line bg-grid"}`}
        >
          <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-[left] ${enabled ? "left-[18px]" : "left-0.5"}`} />
        </button>
      </div>
      {!available ? (
        <p className="text-[11.5px] text-ink-3">
          Disabled: no API key. Add <code className="num rounded bg-panel-2 px-1 text-ink">KUMO_API_KEY=…</code> to <code className="num">.env</code> and restart the API; the builder never enters keys.
        </p>
      ) : null}
    </div>
  );
}
