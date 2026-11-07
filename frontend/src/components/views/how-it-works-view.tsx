"use client";

import {
  Activity, ArrowRight, BookOpenCheck, Calculator, Database, FlaskConical, Gauge, History, Radio, Scale, Settings2, ShieldAlert,
  ShieldCheck, Timer, Wallet, Zap,
} from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { PageHeader, Panel } from "@/components/ui/kit";

const STAGES = [
  { icon: Radio, title: "Public market feeds", body: "Kalshi, Polymarket, Deribit options, Coinbase and Binance prices, all public. Every message is saved to disk." },
  { icon: Calculator, title: "Probability models", body: "Turn options prices and recent volatility into a chance that Bitcoin ends above each strike, with an error band." },
  { icon: Zap, title: "Signal", body: "Compare with what the venue charges. Act only if the gap beats the fee, the error band and a minimum edge." },
  { icon: ShieldAlert, title: "Risk checks (15)", body: "Exposure caps, stale-data guards, price sanity, daily loss limit, kill switch. Kelly sizing on the cautious edge." },
  { icon: FlaskConical, title: "Paper exchange", body: "Simulates the order arriving after network delay, fills against the order book as it was then, charges real fee schedules." },
  { icon: BookOpenCheck, title: "Ledger + reconciliation", body: "A separate double-entry ledger is checked against positions after every fill and settlement. A mismatch halts trading." },
  { icon: History, title: "Event log / replay", body: "Every message, model output and decision is one event in an append-only log. Replaying it reproduces the same trades and fingerprint." },
];

const PAGES = [
  { href: "/", icon: Activity, name: "Desk", what: "What the markets and the model say right now, the gaps, and the latest paper trades." },
  { href: "/positions", icon: Wallet, name: "Positions & P&L", what: "Open paper positions, every trade, and where the profit or loss came from." },
  { href: "/latency", icon: Timer, name: "Latency", what: "How fast data arrives and decisions are made, and how much edge is left if the desk were slower." },
  { href: "/risk", icon: ShieldAlert, name: "Risk", what: "The kill switch, risk limits and how close the book is to them, and why signals were blocked." },
  { href: "/capital", icon: Scale, name: "Capital", what: "How much to bet: a Kelly calculator, sizing for related strikes, and the risk of a deep drawdown." },
  { href: "/models", icon: Gauge, name: "Models", what: "Whether each model's probabilities came true as often as they said, compared with the market's own price." },
  { href: "/replay", icon: History, name: "Replay", what: "Re-run any recorded hours with different settings and check the result is deterministic." },
  { href: "/settings", icon: Settings2, name: "Settings", what: "The trading rules: model, minimum edge, safety margin, limits." },
];

const GLOSSARY: [string, string][] = [
  ["Contract", "A yes/no question such as “Will Bitcoin be above $76,000 at 22:00 UTC?” that pays $1 if yes and $0 if no."],
  ["Price = probability", "A contract trading at 44¢ means the market thinks there is about a 44% chance of yes."],
  ["Bid / ask", "The best price someone will pay (bid) and the best price someone will sell at (ask). You buy at the ask and sell at the bid."],
  ["Spread", "Ask minus bid. A wide spread means trading costs more."],
  ["Fee", "What the venue charges per contract. Kalshi and Polymarket charge takers about 7% × price × (1 − price): up to 1.75¢ per contract at 50¢."],
  ["Edge", "Model probability minus price minus fee minus safety margin, in cents per contract. The desk only trades when it is above the minimum edge."],
  ["Error band", "How unsure the model is about its own probability. The desk requires the gap to clear it."],
  ["Latency", "Time between a price changing and the desk's order reaching the venue. Prices can move meanwhile."],
  ["Kelly sizing", "A rule for how much of the bankroll to bet given the edge and the odds. The desk bets a fraction of it (25% by default), sized on the cautious edge."],
  ["Drawdown", "How far the account has fallen from its highest point. Smaller is better."],
  ["Calibration / Brier score", "Whether things predicted at 30% happen about 30% of the time. Brier score is the average squared error of the probabilities; lower is better."],
  ["Paper trading", "Simulated trading with pretend money against real prices. No order is ever sent to an exchange."],
];

export function HowItWorksView() {
  return (
    <div data-testid="how-it-works" className="space-y-5">
      <PageHeader
        title="How it works"
        sub="Edge Desk asks one question over and over: do prediction markets price Bitcoin's next hour the same way the options market does? Where they disagree by more than costs, it places a paper trade and keeps a complete, replayable record."
      />

      <Panel title="The pipeline" sub="From a public price update to a recorded paper trade. Each box is a stage of the engine; everything flows through one event log." testId="pipeline">
        <ol data-testid="pipeline-diagram" aria-label="Pipeline diagram" className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          {STAGES.map((s, i) => (
            <Fragment key={s.title}>
              <li className="inline-flex items-center gap-2 rounded-full bg-panel-2 py-1 pl-1 pr-3.5 text-[12.5px] font-medium text-ink">
                <span className="flex size-6 items-center justify-center rounded-full bg-panel text-ink"><s.icon className="size-3.5" /></span>
                {s.title}
              </li>
              {i < STAGES.length - 1 ? <li aria-hidden className="text-ink-3"><ArrowRight className="size-4" /></li> : null}
            </Fragment>
          ))}
        </ol>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((s, i) => (
            <li key={s.title} data-testid="pipeline-stage" className="rounded-[20px] bg-panel-2 p-3.5">
              <div className="flex items-center gap-2">
                <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-chip text-[11px] font-semibold text-chip-ink">{i + 1}</span>
                <h3 className="text-[13.5px] font-semibold leading-snug">{s.title}</h3>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
          <li className="flex items-start gap-2 rounded-[20px] border border-dashed border-ink-3/40 p-3.5 text-[12.5px] leading-relaxed text-ink-2">
            <Database className="mt-0.5 size-4 shrink-0 text-ink-3" />
            <span>
              The same engine runs live and in replay: live trading is a replay of the log as it grows. That is why a day can be audited afterwards, and why the
              event-log fingerprint on the Replay page is identical on every run.
            </span>
          </li>
        </ol>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="What each page is for" testId="pages-list" bodyClass="px-0 pt-1 pb-3">
          <ul className="divide-y divide-line">
            {PAGES.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="flex items-start gap-3 px-4 py-3 hover:bg-panel-2">
                  <p.icon className="mt-0.5 size-4 shrink-0 text-ink-2" strokeWidth={1.7} />
                  <span>
                    <span className="block text-[13.5px] font-medium">{p.name}</span>
                    <span className="block text-[12.5px] leading-relaxed text-ink-2">{p.what}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Glossary" testId="glossary">
          <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-[150px_1fr]">
            {GLOSSARY.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-[13px] font-semibold">{k}</dt>
                <dd className="-mt-2 text-[13px] leading-relaxed text-ink-2 sm:mt-0">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <div data-testid="paper-note" className="flex items-center gap-3 rounded-[24px] bg-chip px-5 py-3.5 text-[13px] text-chip-ink">
        <ShieldCheck className="size-5 shrink-0 text-brand" strokeWidth={1.8} />
        <span><span className="font-semibold">Paper only</span> · no real orders · public data · not investment advice.</span>
      </div>
    </div>
  );
}
