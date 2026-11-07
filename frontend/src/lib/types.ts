// Types derived from the API fixtures in src/mocks. Every field may be missing or null in a
// live response (a fresh desk has no trades, no curves, no calibration yet), so most are optional.

export type Venue = "kalshi" | "polymarket" | (string & {});
export type Side = "yes" | "no";

export interface DeskStatus {
  source?: string | null;
  caught_up?: boolean | null;
  records?: number | null;
  uptime_s?: number | null;
  engine_t?: number | null;
  lag_s?: number | null;
}

export interface Health {
  ok?: boolean;
  paper_only?: boolean;
  source?: string | null;
  desk?: DeskStatus | null;
  recorder?: Record<string, unknown> | null;
  data_hours?: number | null;
  data_from?: string | null;
}

export interface Summary {
  trades?: number;
  settled?: number;
  open?: number;
  contracts?: number;
  cost?: number;
  gross_settled?: number;
  fees?: number;
  net_settled?: number;
  unrealized?: number;
  net_total?: number;
  win_rate?: number | null;
  return_on_cost?: number | null;
  equity?: number;
  bankroll?: number;
  signals?: number;
  orders?: number;
  halted?: boolean;
  halt_reason?: string;
}

export interface Feed {
  name: string;
  ok?: boolean;
  reason?: string | null;
  last_msg_age_s?: number | null;
  rtt_ms?: number | null;
  errors?: number | null;
  messages?: number | null;
  websocket?: boolean | null;
}

export interface Opportunity {
  cid: string;
  venue: Venue;
  sym?: string;
  strike?: number;
  expiry_ms?: number;
  group?: string;
  tte_s?: number | null;
  bid?: number | null;
  ask?: number | null;
  bid_sz?: number | null;
  ask_sz?: number | null;
  book_age_s?: number | null;
  fair?: number | null;
  band?: number | null;
  p_options?: number | null;
  p_hybrid?: number | null;
  p_realized?: number | null;
  p_ensemble?: number | null;
  p_cross?: number | null;
  edge_yes?: number | null;
  edge_no?: number | null;
  best_edge?: number | null;
  signal?: Side | null;
  spot?: number | null;
  ref?: string | null;
}

export interface CurvePoint {
  strike: number;
  venue: Venue;
  cid?: string;
  bid?: number | null;
  ask?: number | null;
  p_options?: number | null;
  p_hybrid?: number | null;
  p_realized?: number | null;
  band?: number | null;
  band_hybrid?: number | null;
}

export interface Curve {
  sym: string;
  expiry_ms: number;
  tte_s?: number | null;
  spot?: number | null;
  venues?: Venue[];
  points?: CurvePoint[];
}

export interface SignalEvent {
  seq?: number;
  t?: number;
  kind?: string;
  cid?: string;
  label?: string;
  venue?: Venue;
  side?: Side;
  px?: number | null;
  fair?: number | null;
  p_side?: number | null;
  band?: number | null;
  fee?: number | null;
  edge?: number | null;
  model?: string;
  tte_s?: number | null;
}

export interface OrderEvent {
  seq?: number;
  t?: number;
  kind?: string;
  oid?: number;
  key?: string;
  venue?: Venue;
  cid?: string;
  label?: string;
  side?: Side;
  limit?: number | null;
  qty?: number | null;
  tif?: string;
  state?: string;
  filled?: number | null;
  avg_px?: number | null;
  fees?: number | null;
  t_new?: number;
  maker?: boolean;
  reason?: string | null;
  event?: string;
  why?: string | null;
}

export interface DeskConfig {
  trade_model?: string;
  min_edge?: number;
  band_k?: number;
  order_style?: string;
  latency_ms?: Record<string, number>;
  added_latency_ms?: number;
}

export interface Desk {
  t?: number;
  mode?: string;
  halted?: boolean;
  halt_reason?: string;
  summary?: Summary | null;
  spots?: Record<string, number | null> | null;
  feeds?: Feed[] | null;
  opportunities?: Opportunity[] | null;
  curves?: Curve[] | null;
  signals?: SignalEvent[] | null;
  orders?: OrderEvent[] | null;
  config?: DeskConfig | null;
  counts?: Record<string, number> | null;
  digest?: string | null;
  contracts?: number | null;
  desk?: DeskStatus | null;
}

export interface Attr {
  edge?: number;
  latency?: number;
  slippage?: number;
  fees?: number;
  model_luck?: number;
}
export interface AttrRow extends Attr {
  pnl?: number;
  n?: number;
}
export interface Attribution {
  total?: Attr | null;
  by?: Partial<Record<"venue" | "pairing" | "model" | "tte_bucket" | "edge_bucket", Record<string, AttrRow>>> | null;
}

export interface Position {
  cid: string;
  venue: Venue;
  sym?: string;
  strike?: number;
  expiry_ms?: number;
  group?: string;
  side?: Side;
  qty?: number;
  cost?: number;
  avg_px?: number | null;
  fees?: number;
  mark?: number | null;
  unrealized?: number | null;
  fair?: number | null;
}

export interface Trade {
  oid?: number;
  t?: number;
  venue: Venue;
  cid: string;
  sym?: string;
  strike?: number;
  expiry_ms?: number;
  group?: string;
  side?: Side;
  qty?: number;
  avg_px?: number | null;
  fees?: number | null;
  fair?: number | null;
  p_side?: number | null;
  edge?: number | null;
  model?: string;
  tte_s?: number | null;
  touch_decision?: number | null;
  touch_arrival?: number | null;
  outcome?: number | boolean | null;
  settled?: boolean;
  pnl?: number | null;
  attr?: Attr | null;
  state?: string;
  tte_bucket?: string;
  edge_bucket?: string;
}

export interface EquityPoint {
  t: number;
  equity: number;
  drawdown?: number;
  mark?: boolean;
}

export interface Positions {
  positions?: Position[] | null;
  trades?: Trade[] | null;
  summary?: Summary | null;
  equity_curve?: EquityPoint[] | null;
  max_drawdown?: number | null;
  attribution?: Attribution | null;
}

export interface Limits {
  max_cost_per_market?: number;
  max_cost_per_expiry?: number;
  max_cost_per_underlying?: number;
  max_gross?: number;
  max_open_orders?: number;
  daily_loss_limit?: number;
  max_book_age_s?: number;
  max_spot_age_s?: number;
  max_chain_age_s?: number;
  min_price?: number;
  max_price?: number;
  max_edge?: number;
  max_limit_vs_fair?: number;
  [k: string]: number | undefined;
}

export interface RiskCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface RiskDecision {
  seq?: number;
  t?: number;
  kind?: string;
  signal?: number;
  cid?: string;
  ok?: boolean;
  qty?: number;
  limit?: number | null;
  failed?: string[];
  checks?: RiskCheck[];
}

export interface HaltEvent {
  t?: number;
  action?: string;
  reason?: string;
  halted?: boolean;
  [k: string]: unknown;
}

export interface FeedEvent {
  t?: number;
  name?: string;
  feed?: string;
  ok?: boolean;
  reason?: string;
  [k: string]: unknown;
}

export interface Risk {
  halted?: boolean;
  halt_reason?: string;
  limits?: Limits | null;
  exposure?: {
    gross?: number;
    by_underlying?: Record<string, number>;
    by_expiry?: { key: string; sym?: string; expiry_ms?: number; cost?: number }[];
    open_orders?: number;
  } | null;
  day_pnl?: number | null;
  decisions?: { total?: number; accepted?: number; failed_checks?: Record<string, number> } | null;
  recent?: RiskDecision[] | null;
  halts?: HaltEvent[] | null;
  recon?: { checks?: number; ok?: boolean; last?: { t?: number; ok?: boolean; breaks?: unknown[] } | null } | null;
  input_rejects?: Record<string, number> | null;
  feeds?: Feed[] | null;
  feed_events?: FeedEvent[] | null;
}

export interface ControlResult {
  t?: number;
  action?: string;
  reason?: string;
  halted?: boolean;
}

export interface KellyInput {
  p: number;
  price: number;
  venue: string;
  band: number;
  fraction: number;
  bankroll: number;
}

export interface KellyResult {
  cost_per_contract?: number;
  edge?: number;
  edge_conservative?: number;
  kelly_full?: number;
  kelly_conservative?: number;
  fraction_used?: number;
  stake?: number;
  contracts?: number;
  expected_log_growth?: number;
}

export interface AllocationOpp {
  id: string;
  strike: number;
  side: Side;
  cost: number;
  p: number;
  joint: number;
  independent: number;
}

export interface Allocation {
  sym?: string;
  expiry_ms?: number;
  venue?: Venue;
  opps?: AllocationOpp[];
  joint_total?: number;
  independent_total?: number;
  expected_log_growth?: number;
  converged?: boolean;
  illustrative?: boolean;
}

export interface Capital {
  bankroll?: number;
  kelly_fraction?: number;
  equity_curve?: EquityPoint[] | null;
  max_drawdown?: number | null;
  stats?: {
    n?: number;
    mean?: number;
    sd?: number;
    sharpe_per_trade?: number | null;
    hit_rate?: number;
    caveat?: string;
  } | null;
  risk_of_ruin?: {
    n_source_trades?: number;
    n_trades?: number;
    paths?: number;
    ruin_level?: number;
    p_ruin?: number;
    final_p5?: number;
    final_p50?: number;
    final_p95?: number;
    max_dd_p50?: number;
    max_dd_p5?: number;
  } | null;
  attribution?: Attribution | null;
  allocation?: Allocation | null;
  kelly_example?: KellyResult | null;
}

export interface CalBin {
  lo: number;
  hi: number;
  n: number;
  p_mean?: number | null;
  y_rate?: number | null;
}

export interface ModelCal {
  n?: number;
  brier?: number | null;
  log_loss?: number | null;
  bins?: CalBin[];
  label?: string;
}

export interface Calibration {
  models?: Record<string, ModelCal>;
  n_snapshots?: number;
  n_contracts?: number;
  n_events?: number;
  base_rate?: number | null;
}

export interface KumoStatus {
  enabled?: boolean;
  available?: boolean;
  active?: boolean;
  message?: string;
}

export interface Models {
  all?: Calibration | null;
  by_venue?: Record<string, Calibration> | null;
  by_sym?: Record<string, Calibration> | null;
  kumo?: KumoStatus | null;
  resolved_contracts?: number;
  labels?: Record<string, string>;
  evaluation?: unknown;
}

export interface Dist {
  n?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  mean?: number;
  max?: number;
  hist?: { lo: number; hi: number | null; n: number }[];
}

export interface DecayRow {
  added_ms: number;
  net?: number | null;
  net_settled?: number | null;
  fees?: number | null;
  trades?: number | null;
  contracts?: number | null;
  signals?: number | null;
  expected_edge?: number | null;
  latency_cost?: number | null;
  digest?: string;
}

export interface Latency {
  network?: { rtt?: Record<string, Dist>; feed_lag?: Record<string, Dist> } | null;
  hops?: Record<string, Dist> | null;
  one_way_ms?: Record<string, number> | null;
  added_latency_ms?: number | null;
  edge_decay?: DecayRow[] | null;
  spot_ref?: Record<string, string> | null;
  edge_decay_meta?: { data?: string; base_one_way_ms?: Record<string, number>; [k: string]: unknown } | null;
}

export interface Settings {
  trade_model?: string;
  min_edge?: number;
  band_k?: number;
  kelly_fraction?: number;
  bankroll?: number;
  order_style?: string;
  added_latency_ms?: number;
  depth_haircut?: number;
  lookback_h?: number;
  kumo_enabled?: boolean;
  limits?: Limits;
  kumo?: KumoStatus | null;
  source?: string;
  models?: string[];
  order_styles?: string[];
}

export type SettingsUpdate = Partial<Omit<Settings, "kumo" | "source" | "models" | "order_styles">>;

export interface Periods {
  hours?: { hour: string; bytes?: number; compressed?: boolean }[];
  results?: { edge_decay?: boolean; sweep?: unknown } | null;
}

export interface ReplayRequest {
  start_ms?: number;
  end_ms?: number;
  synthetic?: boolean;
  settings?: SettingsUpdate;
  latencies_ms?: number[];
}

export interface ReplayResult {
  summary?: Summary;
  equity_curve?: EquityPoint[];
  attribution?: Attribution;
  digest?: string;
  events?: number;
  seconds?: number;
  trades?: Trade[];
  calibration?: Calibration | null;
  edge_decay?: DecayRow[];
}

export interface ReplayJob {
  id: string;
  status: string;
  records?: number;
  created?: number;
  request?: ReplayRequest;
  result?: ReplayResult | null;
  error?: string;
}

export type Report = Record<string, unknown>;
