// Display helpers. Every function accepts null/undefined and returns an em dash.

const DASH = "—";
const MINUS = "−";
type N = number | null | undefined;
const ok = (x: N): x is number => typeof x === "number" && Number.isFinite(x);

/** Engine timestamps are ms or ns; normalise to ms. */
export const toMs = (t: N): number | null => (ok(t) ? (t > 1e15 ? t / 1e6 : t) : null);

/** Contract price in cents: 0.625 -> "62.5¢", 0.68 -> "68¢". */
export function cents(p: N, digits?: number): string {
  if (!ok(p)) return DASH;
  const c = p * 100;
  const d = digits ?? (Math.abs(c - Math.round(c)) < 0.05 ? 0 : 1);
  return `${c.toFixed(d)}¢`;
}

/** Signed cents for edges: 0.0204 -> "+2.0¢". */
export function edgeCents(e: N, digits = 1): string {
  if (!ok(e)) return DASH;
  const c = e * 100;
  const s = c > 0.0001 ? "+" : c < -0.0001 ? MINUS : "";
  return `${s}${Math.abs(c).toFixed(digits)}¢`;
}

export function pct(p: N, digits = 1): string {
  if (!ok(p)) return DASH;
  return `${(p * 100).toFixed(digits)}%`;
}

export function signedPct(p: N, digits = 1): string {
  if (!ok(p)) return DASH;
  const s = p > 0 ? "+" : p < 0 ? MINUS : "";
  return `${s}${Math.abs(p * 100).toFixed(digits)}%`;
}

export function num(x: N, digits = 0): string {
  if (!ok(x)) return DASH;
  return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compact(x: N): string {
  if (!ok(x)) return DASH;
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(x);
}

/** Dollars. sign: true -> "+$2,938.25" / "−$132.33". */
export function usd(x: N, opts: { sign?: boolean; digits?: number } = {}): string {
  if (!ok(x)) return DASH;
  const d = opts.digits ?? 2;
  const body = `$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  if (x < 0 && Math.abs(x) >= 0.5 * 10 ** -d) return `${MINUS}${body}`;
  if (opts.sign && x > 0 && Math.abs(x) >= 0.5 * 10 ** -d) return `+${body}`;
  return body;
}

export function strike(k: N): string {
  if (!ok(k)) return DASH;
  return `$${Math.round(k).toLocaleString("en-US")}`;
}

export function price(x: N, digits = 2): string {
  if (!ok(x)) return DASH;
  return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Time to expiry: "45s", "23m", "4h 10m", "2d 3h". */
export function tte(s: N): string {
  if (!ok(s)) return DASH;
  if (s <= 0) return "expired";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Long form for tabs: "23 min", "1h 24m". */
export function tteLong(s: N): string {
  if (!ok(s)) return DASH;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : tte(s);
}

/** Latency in milliseconds: "124 ms", "1.2 s". */
export function ms(x: N): string {
  if (!ok(x)) return DASH;
  if (Math.abs(x) >= 1000) return `${(x / 1000).toFixed(x % 1000 === 0 ? 0 : 1)} s`;
  if (Math.abs(x) < 10 && x !== 0) return `${x.toFixed(1)} ms`;
  return `${Math.round(x)} ms`;
}

/** Latency in microseconds: "18 µs", "1.2 ms". */
export function us(x: N): string {
  if (!ok(x)) return DASH;
  if (Math.abs(x) >= 1000) return `${(x / 1000).toFixed(1)} ms`;
  if (Math.abs(x) < 10) return `${x.toFixed(1)} µs`;
  return `${Math.round(x)} µs`;
}

/** Edge-decay x labels: 0 -> "0", 250 -> "250 ms", 1000 -> "1 s", 60000 -> "60 s". */
export function addedLatency(x: N): string {
  if (!ok(x)) return DASH;
  if (x === 0) return "0";
  return x >= 1000 ? `${+(x / 1000).toFixed(1)} s` : `${x} ms`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "16:02:38 UTC" */
export function utcTime(t: N, seconds = true): string {
  const m = toMs(t);
  if (m == null) return DASH;
  const d = new Date(m);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${seconds ? `${hm}:${pad(d.getUTCSeconds())}` : hm} UTC`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 7, 16:02 UTC" */
export function utcDate(t: N): string {
  const m = toMs(t);
  if (m == null) return DASH;
  const d = new Date(m);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function age(s: N): string {
  if (!ok(s)) return DASH;
  if (s < 1) return "<1s";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function bytes(b: N): string {
  if (!ok(b)) return DASH;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} kB`;
  return `${b} B`;
}

export const venueLabel = (v: string | null | undefined) =>
  v === "kalshi" ? "Kalshi" : v === "polymarket" ? "Polymarket" : v ? v[0].toUpperCase() + v.slice(1) : DASH;

export const humanize = (k: string) => k.replace(/_/g, " ").replace(/\bs\b/, "(s)");

export const sign = (x: N) => (!ok(x) ? 0 : x > 0 ? 1 : x < 0 ? -1 : 0);

/** Short contract label: "BTC > $76,750 · 16:00". */
export function contractLabel(c: { sym?: string; strike?: number; expiry_ms?: number }): string {
  const exp = c.expiry_ms ? ` · ${utcTime(c.expiry_ms, false).replace(" UTC", "")}` : "";
  return `${c.sym ?? ""} > ${strike(c.strike)}${exp}`.trim();
}

/** "BTC" -> "Bitcoin", "ETH" -> "Ether". */
export const symName = (s?: string | null) => (s === "BTC" ? "Bitcoin" : s === "ETH" ? "Ether" : s ?? "");
