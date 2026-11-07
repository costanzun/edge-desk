"use client";

import { useState } from "react";
import { EquityChart } from "@/components/charts/equity-chart";
import { Waterfall } from "@/components/charts/bars";
import {
  Badge, Button, Empty, ErrorNote, HeroKpi, Kpi, KpiRow, Loading, PageHeader, Panel, SideChip, Signed, Table, Td, Th, VenueTag,
} from "@/components/ui/kit";
import * as api from "@/lib/api";
import { useDesk } from "@/lib/desk-context";
import { usePoll } from "@/lib/hooks";
import { cents, edgeCents, num, pct, strike as fmtStrike, tte, usd, utcTime } from "@/lib/format";
import type { Trade } from "@/lib/types";
import { AttributionTable } from "./shared";

export function PositionsView() {
  const { version } = useDesk();
  const { data, error, loading } = usePoll(api.getPositions, 5000, version);
  const [all, setAll] = useState(false);
  if (!data) return (<><PageHeader title="Positions & P&L" /><ErrorNote error={error} />{loading ? <Loading /> : null}</>);
  const s = data.summary ?? {};
  const positions = data.positions ?? [];
  const trades = data.trades ?? [];
  const total = data.attribution?.total;
  const shown = all ? trades : trades.slice(0, 25);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Positions & P&L"
        sub="Paper fills against the venue book at the moment the order would have arrived. Contracts are held to settlement; open positions are marked to the current book."
      />
      <ErrorNote error={error} />
      <KpiRow
        testId="positions-kpis"
        hero={
          <HeroKpi
            label="Net P&L after fees"
            hint="What the paper account made or lost, after every fee, including open positions at today's market price. Positive is good."
            value={<Signed value={s.net_total}>{usd(s.net_total, { sign: true })}</Signed>}
            detail={<>{num(s.trades)} trades · {usd(s.fees)} in fees</>}
            caption="Settled hours plus open positions marked to the market."
          />
        }
      >
        <Kpi label="Settled" hint="Profit or loss on contracts whose hour has resolved. This part is final." value={<Signed value={s.net_settled}>{usd(s.net_settled, { sign: true })}</Signed>} sub={`${num(s.settled)} trades`} />
        <Kpi label="Unrealized" hint="Open positions valued at the current market price. Can still change until the hour resolves." value={<Signed value={s.unrealized}>{usd(s.unrealized, { sign: true })}</Signed>} sub={`${num(s.open)} open`} />
        <Kpi label="Max drawdown" hint="Largest fall from a previous high in account value. Smaller is better." value={<Signed value={data.max_drawdown}>{usd(data.max_drawdown)}</Signed>} sub="peak to trough" />
        <Kpi label="Return on cost" hint="Net P&L divided by the money spent buying contracts. Higher is better." value={pct(s.return_on_cost)} sub={`on ${usd(s.cost, { digits: 0 })} spent`} />
        <Kpi label="Contracts" hint="Total contracts bought across all trades (each pays $1 if it wins)." value={num(s.contracts)} sub={`fees ${usd(s.fees)}`} />
        <Kpi label="Win rate" hint="Share of settled paper trades that made money." value={pct(s.win_rate)} sub="settled trades" />
      </KpiRow>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel title="Equity curve" info="Account value over time. The red area below shows drawdown: how far it sits under its previous high. Rising line and small red area are good." sub="Account value over time; drawdown below." className="xl:col-span-7" testId="equity-panel">
          <EquityChart points={data.equity_curve ?? []} bankroll={s.bankroll} height={300} />
        </Panel>
        <Panel title="Where the P&L came from" info="Edge = profit expected when the trade was made. Latency and slippage = price lost by being slow or filling deeper in the book. Fees = venue fees. Model/luck = what the actual outcomes added or took away versus expectation." sub="Where the money came from: expected edge at decision, then what latency, slippage, fees and the outcome did to it." className="xl:col-span-5" testId="attribution-panel">
          {total ? <Waterfall total={total} height={300} /> : <Empty>No trades yet.</Empty>}
        </Panel>
      </div>

      <Panel title="Breakdown" info="The same attribution split by venue, by venue pair, by time left to expiry and by size of the edge at entry." testId="attribution-breakdown" bodyClass="pb-0">
        <AttributionTable attribution={data.attribution} />
      </Panel>

      <Panel title={`Open positions · ${positions.length}`} info="Contracts held until their hour settles. Unrealized = value at the current market price minus what was paid." testId="positions-table" bodyClass="py-0">
        {positions.length === 0 ? <Empty>Flat: no open paper positions.</Empty> : (
          <Table>
            <thead>
              <tr>
                <Th>Contract</Th><Th>Side</Th><Th right>Qty</Th><Th right>Avg px</Th><Th right>Mark</Th><Th right>Fair</Th>
                <Th right>Cost</Th><Th right>Fees</Th><Th right>Unrealized</Th><Th right>Expiry</Th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={`${p.cid}-${p.side}`} className="hover:bg-panel-2">
                  <Td><span className="flex items-center gap-2"><VenueTag venue={p.venue} short /><span className="num">{p.sym} &gt; {fmtStrike(p.strike)}</span></span></Td>
                  <Td><SideChip side={p.side} /></Td>
                  <Td right>{num(p.qty)}</Td>
                  <Td right>{cents(p.avg_px)}</Td>
                  <Td right>{cents(p.mark)}</Td>
                  <Td right className="text-ink-2">{pct(p.fair)}</Td>
                  <Td right>{usd(p.cost)}</Td>
                  <Td right className="text-ink-2">{usd(p.fees)}</Td>
                  <Td right><Signed value={p.unrealized}>{usd(p.unrealized, { sign: true })}</Signed></Td>
                  <Td right className="text-ink-3">{utcTime(p.expiry_ms, false)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel
        title={`Trade blotter · ${trades.length}`}
        sub="Every paper order that filled at least one contract, newest first. Attribution per trade on hover."
        testId="blotter"
        bodyClass="py-0"
        right={trades.length > 25 ? <Button size="sm" onClick={() => setAll((a) => !a)} data-testid="blotter-toggle">{all ? "Show 25" : `Show all ${trades.length}`}</Button> : null}
      >
        {trades.length === 0 ? <Empty>No trades yet.</Empty> : <Blotter trades={shown} />}
      </Panel>
    </div>
  );
}

function Blotter({ trades }: { trades: Trade[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Time</Th><Th>Contract</Th><Th>Side</Th><Th right>Qty</Th><Th right>Fill</Th><Th right>Model p</Th>
          <Th right>Edge</Th><Th right>TTE</Th><Th right>Fees</Th><Th>Status</Th><Th right>P&L</Th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => {
          const a = t.attr;
          const title = a ? `edge ${usd(a.edge, { sign: true })} · latency ${usd(a.latency, { sign: true })} · slippage ${usd(a.slippage, { sign: true })} · fees ${usd(a.fees, { sign: true })} · model/luck ${usd(a.model_luck, { sign: true })}` : undefined;
          return (
            <tr key={`${t.oid}-${i}`} data-testid="trade-row" className="hover:bg-panel-2" title={title}>
              <Td className="text-ink-3" mono>{utcTime(t.t)}</Td>
              <Td><span className="flex items-center gap-2"><VenueTag venue={t.venue} short /><span className="num">{t.sym} &gt; {fmtStrike(t.strike)}</span></span></Td>
              <Td><SideChip side={t.side} /></Td>
              <Td right>{num(t.qty)}</Td>
              <Td right>{cents(t.avg_px)}</Td>
              <Td right className="text-ink-2">{pct(t.p_side)}</Td>
              <Td right className="text-pos">{edgeCents(t.edge)}</Td>
              <Td right className="text-ink-3">{tte(t.tte_s)}</Td>
              <Td right className="text-ink-2">{usd(t.fees)}</Td>
              <Td>
                {t.settled ? (
                  <Badge tone={(t.pnl ?? 0) > 0 ? "pos" : "neg"}>{(t.pnl ?? 0) > 0 ? "won" : "lost"}</Badge>
                ) : (
                  <Badge tone="muted">open</Badge>
                )}
              </Td>
              <Td right><Signed value={t.pnl}>{usd(t.pnl, { sign: true })}</Signed></Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
