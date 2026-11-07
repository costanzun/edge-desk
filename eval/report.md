# Edge Desk: evaluation report

Generated 2026-11-07 20:29 UTC by `uv run python -m edgedesk.eval.report`. Paper trading only; not investment advice.

## Data

- Recorded period: **2026-11-07 14:21 UTC to 2026-11-07 20:13 UTC** (5.87 h), 199,031 raw messages, 2109 contracts seen.
- Resolved contracts: Kalshi 1457, Polymarket 202.
- Gaps longer than a minute: 2026-11-07 15:00 UTC to 2026-11-07 15:05 UTC (5.7 min), 2026-11-07 15:36 UTC to 2026-11-07 15:39 UTC (3.2 min), 2026-11-07 18:33 UTC to 2026-11-07 18:49 UTC (15.6 min), 2026-11-07 18:50 UTC to 2026-11-07 19:05 UTC (15.2 min), 2026-11-07 19:06 UTC to 2026-11-07 19:22 UTC (16.1 min), 2026-11-07 19:23 UTC to 2026-11-07 19:39 UTC (16.8 min), 2026-11-07 19:40 UTC to 2026-11-07 19:56 UTC (15.8 min), 2026-11-07 19:57 UTC to 2026-11-07 20:13 UTC (15.4 min).
- Determinism: two replays of the period gave the same digest (`b3422218c913e4bc...`).

## Paper P&L (default configuration, not tuned)

Model `hybrid`, min edge 0.02 after fees and 1 error band, quarter Kelly on a $10,000 paper bankroll, one-way latency {'kalshi': 68.6, 'polymarket': 40.5} ms (half the measured median round trip).

| | value |
|---|---|
| Trades (orders with fills) | 293 (260 settled, 33 open) |
| Contracts bought / capital used | 14,275 / $4,581.46 |
| Gross settled P&L | -$356.90 |
| Fees paid | -$127.72 |
| **Net P&L after fees** (settled + open marked) | **-$645.00** |
| Return on capital used | -14.08% |
| Win rate (settled) | 21% |
| Max drawdown | -$1,090.36 |

Attribution of the total (per trade: model edge at decision, minus latency and slippage, minus fees, plus the difference between what happened and the model probability):

| edge at decision | latency | slippage | fees | outcome vs model |
|---|---|---|---|---|
| +$1,019.82 | +$0.00 | -$65.19 | -$127.72 | -$1,471.92 |

Same data, other traded models (default thresholds):

| model | trades | net after fees | fees |
|---|---|---|---|
| options | 65 | -$1,263.34 | -$65.07 |
| hybrid | 293 | -$645.00 | -$127.72 |
| ensemble | 98 | -$173.67 | -$66.23 |
| hybrid (maker orders) | 18 | -$363.17 | +$0.00 |

## Calibration on resolved contracts (recorded data)

4051 snapshots, 206 contracts, 24 expiries, base rate 0.3303. Lower is better.

| model | Brier | log loss |
|---|---|---|
| Options-implied (Deribit) | 0.0376 | 0.1326 |
| Hybrid (Deribit smile + realized vol) | 0.0371 | 0.1300 |
| Realized vol (spot) | 0.0375 | 0.1302 |
| Market ensemble | 0.0374 | 0.1318 |
| Market mid (baseline) | 0.0355 | 0.1323 |

![Reliability, recorded data](figures/reliability_recorded.png)

## Historical study: a week of Kalshi hourly brackets

2802 near-the-money markets in 327 hourly events (2026-10-31T14:00:00Z to 2026-11-07T14:00:00Z), sampled at 45, 30, 15, 5 minutes before expiry. 1-minute top of book, no depth, DVOL as the options proxy (no historical smile).

| horizon | n | Kalshi mid (market) | DVOL implied vol (options proxy) | Realized vol (1-min, EWMA 60 min) | Blend of DVOL and realized |
|---|---|---|---|---|---|
| all | 7803 | 0.1032 | 0.1147 | 0.1070 | 0.1081 |
| 45 min | 2689 | 0.1071 | 0.1190 | 0.1108 | 0.1121 |
| 30 min | 2388 | 0.1013 | 0.1129 | 0.1054 | 0.1065 |
| 15 min | 1793 | 0.0964 | 0.1071 | 0.1007 | 0.1012 |
| 5 min | 933 | 0.1100 | 0.1213 | 0.1120 | 0.1139 |
| BTC | 4545 | 0.1038 | 0.1142 | 0.1074 | 0.1082 |
| ETH | 3258 | 0.1024 | 0.1153 | 0.1063 | 0.1079 |

Brier scores. Threshold rule at the top of book after the Kalshi taker fee (1 contract per signal, decisions at 30 and 15 minutes, hold to settlement; 95% bootstrap interval on P&L per contract):

| model | threshold | trades | P&L / contract | 95% CI | hit rate |
|---|---|---|---|---|---|
| DVOL implied vol (options proxy) | 0.0 | 3524 | -0.0262 | [-0.0354, -0.0163] | 0.31 |
| DVOL implied vol (options proxy) | 0.02 | 2619 | -0.0292 | [-0.0411, -0.0180] | 0.24 |
| DVOL implied vol (options proxy) | 0.05 | 1807 | -0.0236 | [-0.0381, -0.0097] | 0.20 |
| Realized vol (1-min, EWMA 60 min) | 0.0 | 3235 | -0.0316 | [-0.0425, -0.0209] | 0.32 |
| Realized vol (1-min, EWMA 60 min) | 0.02 | 1791 | -0.0385 | [-0.0543, -0.0242] | 0.20 |
| Realized vol (1-min, EWMA 60 min) | 0.05 | 842 | -0.0430 | [-0.0658, -0.0208] | 0.16 |
| Blend of DVOL and realized | 0.0 | 3253 | -0.0276 | [-0.0382, -0.0171] | 0.28 |
| Blend of DVOL and realized | 0.02 | 2086 | -0.0386 | [-0.0518, -0.0251] | 0.20 |
| Blend of DVOL and realized | 0.05 | 1066 | -0.0354 | [-0.0553, -0.0150] | 0.20 |

Mean DVOL vs mean 1-minute realized vol: {'BTC': {'dvol_mean': 0.3941, 'rv_mean': 0.3992}, 'ETH': {'dvol_mean': 0.5345, 'rv_mean': 0.5074}}. Median vol implied by Kalshi mids: {'BTC': 0.3199, 'ETH': 0.397}.

![Reliability, backfill](figures/reliability_backfill.png)

## Latency

| source | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| binance REST round trip | 6408 | 232 | 250 | 305 |
| coinbase REST round trip | 6346 | 31 | 101 | 141 |
| deribit REST round trip | 6952 | 47 | 74 | 111 |
| kalshi REST round trip | 36448 | 137 | 379 | 408 |
| polymarket REST round trip | 2421 | 81 | 123 | 156 |
| coinbase trade (ws) (receive minus exchange stamp) | 12055 | 19 | 45 | 121 |
| deribit index (ws) (receive minus exchange stamp) | 17082 | -7 | 202 | 720 |
| polymarket book (ws) (receive minus exchange stamp) | 108874 | -12 | 13 | 185 |

Internal hot path per message (µs): guard p50 2.8 / p99 7.0, model p50 16.5 / p99 35.6, signal p50 5.2 / p99 10.0, risk p50 26.6 / p99 56.4, order p50 9.5 / p99 19.5

![Latency](figures/latency.png)

## Edge decay

| added latency | trades | net after fees | model edge at decision | latency cost |
|---|---|---|---|---|
| 0 ms | 293 | -$614.94 | +$1,019.82 | +$0.00 |
| 100 ms | 284 | -$552.65 | +$967.54 | +$0.00 |
| 250 ms | 283 | -$640.76 | +$1,008.10 | +$6.55 |
| 500 ms | 279 | -$569.19 | +$984.71 | +$6.63 |
| 1,000 ms | 277 | -$577.73 | +$982.63 | +$6.74 |
| 2,000 ms | 267 | -$590.73 | +$966.59 | +$9.79 |
| 5,000 ms | 256 | -$593.41 | +$967.50 | -$0.09 |
| 10,000 ms | 224 | -$555.86 | +$746.26 | -$22.68 |
| 30,000 ms | 117 | -$463.15 | +$555.45 | +$49.54 |
| 60,000 ms | 87 | -$373.21 | +$429.12 | +$48.23 |

![Edge decay](figures/edge_decay.png)

## Parameter sweep with out-of-sample check

Chosen on the first half (before 2026-11-07 16:35 UTC), judged on the second half.

| | model | min edge | bands | train net | test net |
|---|---|---|---|---|---|
| best in-sample | hybrid | 0.04 | 2.0 | +$1,343.31 | -$441.26 |
| default | hybrid | 0.02 | 1.0 | +$343.13 | -$570.32 |

## Risk

- 1387 pre-trade risk decisions, 473 reconciliations (all clean), 566 input messages rejected by the ingest guard.
- Halts: daily loss limit hit (-308.81).
- Risk of ruin (bootstrap of 293 trade returns over 500 trades, ruin = -50%): 0.0%; median final equity x0.8963. Assumes independent trades: optimistic.

## Caveats

- A short recording window: hours to days, one market regime. Calibration snapshots of the same contract are correlated; read the contract and expiry counts, not the snapshot count.
- Fills are simulated against recorded books (REST snapshots every 10-15 s on Kalshi, WebSocket on Polymarket) with a 50% depth haircut; we never know our true queue position or market impact.
- Kalshi settles on the CF Benchmarks BRTI 60-second average; Coinbase spot is used as its proxy. Polymarket settles on the Binance BTC/USDT 1-hour close; Binance spot is used.
- Deribit's shortest listed expiry is the next 08:00 UTC; anything shorter is extrapolated (options model) or blended with realized vol (hybrid).
