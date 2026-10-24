import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM has no __dirname. State paths MUST anchor to this file's directory, not the
// process cwd -- a run from the repo root previously created a SHADOW ledger
// (root sid-account.json, zeroed) instead of SID/sid-account.json. (2026-09-04)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { createExecutor, resolveTradingMode } from './alpaca-executor.js';
import { rsiTargetPrice } from './rsi-target-price.js';
import * as tg from './telegram-alerts.js';

// ── Config ────────────────────────────────────────────────────────────────────

// Parse an integer env var, falling back to `def` when unset/blank/non-numeric.
// Unlike `parseInt(x) || def`, this correctly preserves a legitimate 0 value
// (needed for rearmCooldownLong, whose validated value IS 0).
function intEnv(raw, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? def : v;
}

const CONFIG = {
  // V2.2: accountUsd is set per-run from the internal ledger (loadAccount)
  // for compounding sizing. The SID_ACCOUNT_USD env var becomes a fallback
  // only when the ledger is unreadable. See top of main() for the override.
  accountUsd:       parseFloat(process.env.SID_ACCOUNT_USD)     || 30000,  // V2.2 fallback only
  riskPct:          parseFloat(process.env.SID_RISK_PCT)         || 0.01,   // V2 default 1% per instructor S3_Ep4
  maxPositionPct:   parseFloat(process.env.SID_MAX_POS_PCT)      || 0.10,   // 10% of account max per trade
  maxOpenPositions: parseInt(process.env.SID_MAX_POSITIONS)      || 5,      // Never hold more than 5 at once (v2.2.6: raised 3→5; 5 × 10% cap = ~50% max deployed)
  maxPerDay:        parseInt(process.env.SID_MAX_PER_DAY)        || 1,      // Max new entries per run
  earningsWindow:   parseInt(process.env.SID_EARNINGS_WINDOW)    || 14,     // Skip if earnings within N days
  rsiNoGoLong:      parseFloat(process.env.SID_RSI_NOGO_LONG)    || 45,     // V2: reject long entry if RSI >= this
  rsiNoGoShort:     parseFloat(process.env.SID_RSI_NOGO_SHORT)   || 55,     // V2: reject short entry if RSI <= this
  useWeeklyDirection: process.env.SID_WEEKLY_DIRECTION !== 'false',         // V2: require weekly RSI OR MACD to align with trade direction (default ON)
  paperTrading:     process.env.SID_PAPER !== 'false',                       // legacy flag — still honoured for trade-log labelling
  tradingMode:      resolveTradingMode(),                                    // 'dry_run' | 'paper' | 'live' — controls Alpaca execution
  // V2.1 dynamic-TP parameters ──────────────────────────────────────────────
  tp1Portion:       parseFloat(process.env.SID_TP1_PORTION)      || 0.50,   // V2.1: fraction of position closed at TP1 (RSI 50)
  tp2TimeoutDays:   parseInt(process.env.SID_TP2_TIMEOUT_DAYS)   || 30,     // V2.1: max trading days to hold remaining 50% after TP1
  useDynamicTp:     process.env.SID_DYNAMIC_TP !== 'false',                  // V2.1: enable TP1+TP2 partial exits (default ON). Set false to revert to v2.0 single-exit behaviour.
  // ── ENTRY ARM state-machine parameters (parity with backtest-sid-bot-parity.py) ──
  // These bring detectEntrySignal into EXACT agreement with the validated
  // backtest config (tier1, 5y → 280 trades / 73.9% WR / PF 3.19 / +$31,426
  // at $200 fixed risk). The old "episode scan" had no arm timeout, no RSI(3)
  // confirmation and no weekly-SMA arm gate — far too loose. See the bar-by-bar
  // replay in detectEntrySignal().
  armTimeoutDays:     intEnv(process.env.SID_ARM_TIMEOUT_DAYS,    3),       // arm expires this many trading days after the oversold/overbought signal if no entry triggers
  rearmCooldownLong:  intEnv(process.env.SID_REARM_COOLDOWN_LONG, 0),       // trading-day lockout before a LONG can re-arm after its arm expires unfired (0 = free re-arm)
  rearmCooldownShort: intEnv(process.env.SID_REARM_COOLDOWN_SHORT,5),       // trading-day lockout before a SHORT can re-arm after its arm expires unfired
  armReplayBars:      intEnv(process.env.SID_ARM_REPLAY_BARS,     40),      // how many trailing daily bars to replay the arm machine over (>> 3d arm + 5d cooldown so today's state is fully determined)
  // ── V2.2.4 SHORT APPROVAL GATE ─────────────────────────────────────────────
  // Live execution-discipline overlay (NOT a signal-logic change). When ON
  // (default), a mechanical SHORT signal on a long-term-bullish asset
  // (longTermBullish(): price>SMA200 AND SMA50>SMA200) is NOT auto-executed —
  // it is logged + Telegram-alerted for Alan to fire manually at the right level
  // (e.g. into a supply zone), via the existing manual one-shot flow. Longs and
  // non-bullish-asset shorts are UNAFFECTED and still auto-fire. Set
  // SID_SHORT_APPROVAL_GATE=false to revert to fully-mechanical bullish-asset shorts.
  shortApprovalGate:  process.env.SID_SHORT_APPROVAL_GATE !== 'false',
  // ── V2.4.0 PDT-SAFE EXECUTION MODE ─────────────────────────────────────────
  // DEFAULT FALSE = the standard "PDT version" (broker GTC stops + resting
  // intraday short-TP1 limit placed from entry — tight, intraday fills). Those
  // broker orders CAN fill the SAME day as entry → a day trade → Pattern Day
  // Trader (PDT) exposure. A margin account under $25,000 making 4+ day trades
  // in 5 business days gets flagged + restricted by Alpaca/FINRA. SID shorts
  // require margin, so sub-$25K followers are PDT-subject.
  //
  // When SID_PDT_SAFE=true (the sub-$25K user OPTS IN), the bot places NO broker
  // order that can fire intraday same-day: it SKIPS maintainV2_2BrokerOrders
  // entirely (no resting GTC stop, no resting intraday short-TP1 limit) AND does
  // not place the entry-time broker stop — for BOTH the normal entry path and
  // the approved-entry path. Positions are then managed SOLELY by the daily-poll
  // in checkPositions (TP1 RSI-50, TP2 SMA50/SMA200/BE/timeout, and a stop breach
  // → market close at the NEXT daily run's open). Because checkPositions only
  // scans bars AFTER the entry date and there are NO broker orders, every exit
  // lands on a LATER calendar day than entry → PDT-immune (v2.0's original
  // design, restored as an opt-in). Honest trade-offs (see SID-README.md
  // "PDT version vs PDT-safe mode"): no intraday stop (a hard mid-day move isn't
  // cut until the next run's open → gap/slippage, expect a modest few-percent
  // profit reduction vs the PDT version), and a missed scheduled run leaves a
  // position unprotected longer (no broker safety net). Both are inherent to
  // PDT-immunity.
  pdtSafe:            process.env.SID_PDT_SAFE === 'true',
  // ── V2.6.0 QUEUE-FOR-OPEN EXITS + OUT-OF-HOURS CYCLES ──────────────────────
  // queueExitsForOpen (default ON): when an EXIT triggers while the market is
  //   CLOSED, don't refuse it — sweep the symbol's resting orders and submit the
  //   exit as a market order the broker executes at the NEXT OPEN, recording a
  //   `pending_exit` block that every later run reconciles first. Set
  //   SID_QUEUE_EXITS_FOR_OPEN=false to restore the pre-v2.6.0 behaviour
  //   (refuse, re-protect, retry next run). ENTRIES ARE NEVER QUEUED.
  // weekendExitQueue (default ON): the weekend guard used to `return` BEFORE
  //   checkPositions, so an exit that ripened on Friday evening (= Saturday UTC)
  //   could not even be queued until Monday. Positions are now still MANAGED at
  //   the weekend (exits queued for Monday's open); only the ENTRY SCAN is
  //   skipped, which is all the guard was ever protecting against (a signal
  //   computed off Friday's stale close). Set SID_WEEKEND_EXIT_QUEUE=false for
  //   the old hard weekend stop.
  // exitsOnly (default OFF): manage positions and skip the entry scan entirely.
  //   Used by the Railway cron runner's cheap out-of-hours cycle, where entries
  //   would be refused anyway — it keeps a 112-ticker Yahoo scan off the clock
  //   ~40 times a day.
  queueExitsForOpen:  process.env.SID_QUEUE_EXITS_FOR_OPEN !== 'false',
  weekendExitQueue:   process.env.SID_WEEKEND_EXIT_QUEUE   !== 'false',
  exitsOnly:          process.env.SID_EXITS_ONLY === 'true',
};

// ── RSI thresholds (named to match backtest-sid-bot-parity.py constants) ─────
// These were previously inline literals throughout the bot. Naming them keeps
// detectEntrySignal's replay byte-for-byte readable against the backtest.
const RSI_PERIOD     = 14;   // daily/weekly RSI lookback (Wilder)
const RSI3_PERIOD    = 3;    // RSI(3) rebound confirmation lookback
const RSI_OVERSOLD   = 30;   // long arm: daily RSI < 30  (and RSI(3) < 30)
const RSI_OVERBOUGHT = 70;   // short arm: daily RSI > 70 (and RSI(3) > 70)  [LOCKED core rule]

// ── V2 Approval Tiers (see SID/docs/V2-TELEGRAM-APPROVAL-SPEC.md) ────────────
// AUTO: 80 tickers proven via 5y V1 backtest — bot fires automatically
// HUMAN: 32 high-vol/crypto/new — Telegram approval required (deferred to v2.1)
const AUTO_APPROVED_TICKERS = new Set([
  'AAPL','ABBV','ABT','ADBE','AMAT','AMD','AMZN','AVGO','AXP','B',
  'BA','BLK','CAT','COST','CRM','CVX','DE','DIA','DIS','EEM',
  'EFA','F','GDX','GE','GLD','GOOG','GS','HD','HON','IBB',
  'IBM','INTC','IWM','IYR','JNJ','JPM','KHC','LLY','LMT','LRCX',
  'MCD','MDLZ','META','MRK','NKE','NOW','NUGT','NVDA','ORCL','PFE',
  'PYPL','QQQ','RIOT','RTX','SBUX','SCHW','SLV','SPY','SQQQ','TGT',
  'TNA','TQQQ','TSLA','TZA','UNH','V','WFC','WMT','XHB','XLC',
  'XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY','XOM',
]);

// ── Bot identity ──────────────────────────────────────────────────────────────
const BOT_NAME    = 'SID';
const BOT_VERSION = 'v2.6.0'; // V2.6.0 QUEUE-FOR-OPEN EXITS + RAILWAY CRON RUNNER (execution plumbing + scheduling ONLY, NOT a signal-logic change). THE LIVE FAILURE: on 2026-09-09 IBM's TP2 (SMA50 touch) ripened in the last ~35 minutes of the session; the next bot run landed 21:06 UTC, an hour after the close, correctly swept the resting stop, then hit `Market closed - refusing to submit close for IBM` (alpaca-executor.js :520), re-protected the runner and gave up until the next run. Alan then did it by hand: cancel the stop, queue a market sell, filled at the next open (2 @ $238.39). With GHA crons landing ~3h late (14:35 -> ~18:15, 18:35 -> ~21:10 UTC) an exit that ripens late in the session can slip for DAYS - and ON-TIME crons would ALSO have missed this one, because the touch came after the last in-hours run. Hence both halves. (1) QUEUE-FOR-OPEN EXITS: when an exit triggers (TP1 partial, TP2, the daily-poll stop, or the v2.0 RSI-50 fallback) and the market is CLOSED, the bot now sweeps every resting order on the symbol (cancelAllOpenOrders + waitForNoOpenOrders - the shares cannot be freed otherwise) and submits the exit as a MARKET order the BROKER executes at the next open, recording a `pending_exit` block (order id, reason, shares, queued timestamp, trigger data) that is the single-fire guard: checkPositions SKIPS a position while one is pending, so a second order can never be queued and a queued TP1 cannot re-fire (tp1_hit only flips when the fill is BOOKED). Every later run reconciles `pending_exit` BEFORE syncPositions (load-bearing ordering - otherwise an overnight fill would be booked twice, once as an 'external' close): filled -> booked through the real-fill path at the price WEIGHTED from the per-fill activity rows (the v2.5.0 6dp-rounding pitfall), pending_exit cleared, and for a TP1 partial the break-even stop restored on the remainder; still open/accepted -> left strictly alone; cancelled/rejected/expired -> cleared, IMMEDIATELY re-protected with a stop, loud alarm. A rejected submission falls back to exactly the pre-v2.6.0 behaviour (re-protect, alert, retry) so a position is never both unprotected and unqueued. VERIFIED AGAINST THE ALPACA DOCS (2026-10-24): tif 'opg' is REJECTED between 09:28 and 19:00 ET and queued to the following day's opening auction after 19:00 - and 21:06 UTC is 17:06 ET, squarely in that dead zone - so queuedExitTif() picks 'opg' where Alpaca accepts it and a plain queued 'day' market order (documented: submitted after 16:00 ET it is 'queued up for release the next trading day') in between, alternating on retry; ET is read from the BROKER clock's own -04:00/-05:00 timestamp, never a hardcoded timezone, so DST is the broker's problem. DOCUMENTED TRADE-OFF: between the sweep and the open the position has NO resting stop, because a stop holds the shares and would block the queued exit; the exposure is the overnight gap on a position we are exiting anyway, and a market-on-open fill is equivalent-or-better than a stop triggering at that same open. ENTRIES ARE NEVER QUEUED - the two entry refusals (:202/:278) are untouched, because a stale entry signal must be re-evaluated against a fresh bar. (2) RAILWAY CRON RUNNER (SID/railway-sid-runner.js): one-shot (pull state from main via the GitHub Contents API -> run the bot once -> push changed state back SHA-aware with a re-pull-and-retry on conflict -> exit), driven by a Railway Cron Schedule rather than an always-on loop, gated on Alpaca's /v2/clock so the cheap out-of-hours cycle (SID_EXITS_ONLY) still reconciles and queues exits without a 112-ticker Yahoo scan. Runs ALONGSIDE the existing GHA crons in Phase 1 - they are NOT disabled in this release. CONCURRENCY IS MADE SAFE AT THE BROKER, not just in local state: every queued exit carries a DETERMINISTIC client_order_id (SID-<SYM>-<tag>-<YYYYMMDD>[-a<attempt>]), so a concurrent second submission is rejected by Alpaca as a duplicate instead of double-selling. (3) The weekend guard no longer returns BEFORE checkPositions - positions are managed at the weekend (a Friday-evening exit is queued for Monday's open; Friday 19:30 ET is Saturday UTC) while the ENTRY SCAN stays blocked, which is all that guard ever protected against. NO canon rule change: RSI 30/70, RSI(3), MACD alignment, the weekly gates, the 45/55 no-go zones, the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, the 14-day earnings blackout, the AUTO/HUMAN tiers and the 50% TP1 portion are byte-for-byte unchanged. Reverts: SID_QUEUE_EXITS_FOR_OPEN=false / SID_WEEKEND_EXIT_QUEUE=false. (paper trading, 2026-10-24)
// V2.5.0 P&L BOOKING FIXES (accounting + execution plumbing, NOT a signal-logic change): the dashboard was reporting the WRONG profit because three independent booking bugs corrupted the stored records. Verified against the real Alpaca paper account on 2026-10-18 (read-only GETs): broker equity +$543.43, our ledger +$512.02. (1) EXTERNAL FULL CLOSE DROPPED A BOT-BOOKED TP1 LEG — recordExternalClose set total_pnl to the closed leg ALONE, while deriveLedger only counts an open position's tp1_pnl WHILE IT IS OPEN; so the instant a runner closed externally, a TP1 half banked by Branch A fell out of the books (IBM lost +$40.76 -> booked +$42.52 vs truth +$82.88; HON lost +$20.58 -> booked -$0.09 vs truth +$19.83). The bot's own TP2 path never had this bug (it already summed tp1_pnl + tp2Pnl). FIX: a full close now carries the TP1 leg into total_pnl, guarded by the new shared tp1LegAlreadyInClosedRecords() so the PYPL pattern — where the TP1 leg was itself written as a separate closed PARTIAL record (is_full_close:false, same id) — can never be counted twice. (2) THE SAME PREDICATE FIXES THE MIRROR DOUBLE-COUNT queued in v2.4.3: deriveLedger was adding a still-open position's tp1_pnl ON TOP of the closed partial record written for that same leg by the broker-OCO path. Both directions land together, each with its own regression witness. (3) STOP EXITS BOOKED THE STOP LEVEL, NOT THE REAL FILL — the daily-poll stop path submits a MARKET close but never overwrote exitPrice with filledAvgPrice, leaving pnl_source:'estimate' (HD booked 3sh @ $304.00 = -$24.96; the real fill was $303.346667 = -$27.01). v2.4.1 had fixed this for TP1/TP2 only; the stop path and the v2.0 RSI-50 fallback path now mirror the identical pollOrderFill/override shape, so NO close path leaves 'estimate' when a real fill exists. (4) ENTRY PRICE WAS THE SIGNAL CLOSE, NOT THE ENTRY FILL — run() stored signal.entry (the bar the rules fired on) for a MARKET order, so every share of entry error multiplied across the whole position and through BOTH exit legs (HON 204.22 vs real 204.44; IBM 217.13 vs 217.23; HD 312.32 vs 312.35; RIOT 19.65 vs 19.665526). approve-trade.js already polled the fill correctly — the main path now mirrors it, storing filledAvgPrice plus entry_source/signal_entry provenance. Share math, the stop level and riskUsd are deliberately NOT recomputed (the order is already submitted and the broker stop already rests at signal.stopLoss). NO canon rule change (RSI 30/70, RSI(3), MACD alignment, weekly gates, the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, the 14-day earnings blackout, AUTO/HUMAN tiers and entry/arm/scan are byte-for-byte unchanged) — this is accounting and execution plumbing only. Ships with the v2.4.3 work (external-close fill-consumption guard, reconcile skipping open positions, the per-run Alpaca snapshot write + sid.yml staging, dashboard stale-snapshot flag) re-badged into this release, and a one-off idempotent record correction (SID/scripts/fix-pnl-booking-2026-10-18.js) that ties the books to the broker: corrected records sum +$543.94, less $0.51 of real TAF/CAT/REG fee activities = +$543.43 = Alpaca equity EXACTLY. (paper trading, 2026-10-18)
// V2.4.3 ACCOUNTING/DISPLAY FIXES (NOT a signal-logic change): (1) DOUBLE-COUNT FIX — recordExternalClose re-scanned ALL of Alpaca's filled exit orders on every external close, so a SECOND external close on the same symbol walked back and re-used fills the FIRST close had already booked. PROVEN on the PYPL short (17sh, entry $60.675): leg 1 banked 9sh @ $52.40 = +$74.47 (correct); leg 2's real fills were 6 @ $56.66 + 2 @ $56.71 (avg $56.6725 → true +$32.02) but the bot booked $57.58 at "exit $53.4775", which decodes EXACTLY as (2 x 56.71 + 6 x 52.40) / 8 — two shares at the correct new price then SIX back-filled at leg 1's already-consumed $52.40. FIX: a consumed-fill ledger (consumedExitFillQty) subtracts, per broker order id, every quantity already stamped into a prior closed record's exit_fills (plus the bot's own TP1 partial-close order, now stamped as tp1_close_order_id) before pricing the new close — mirroring reconcile-account.js's allocateFillsFIFO lot-consumption model rather than inventing a second one. When the surviving fills cover FEWER shares than the close, the record is stamped pnl_source:'estimate' + exit_fill_shortfall instead of silently extrapolating a full-coverage 'alpaca_fill'. (2) STALE-SNAPSHOT FIX — alpaca-account-sid.json (the dashboard's LIVE net-P&L headline) had only ONE writer: reconcile-account.js under an explicit --write. The bot never wrote it, so the dashboard rendered a FROZEN 2026-07-17 equity for 7 weeks. The bot now writes the snapshot every run from its existing preflight account read (equity/startingEquity/netPnl/source/mode/asOf), mode-segregated (paper → alpaca-account-sid.json, live → alpaca-account-<mode>-sid.json) so a paper run can never overwrite a live snapshot; sid.yml now stages the file so the refresh actually reaches the dashboard; and sid-dashboard.js flags a snapshot older than SNAPSHOT_STALE_DAYS (2) as STALE instead of presenting it as current. NO canon rule change (RSI 30/70, MACD alignment, RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, share math, entry/arm/scan and the v2.2.5/2.2.6/v2.4.2 cancel-first + sweep close mechanics are all byte-for-byte unchanged). (paper trading, 2026-09-05)
// V2.4.2 SHORTS-TP1 OCO FIX (broker-order plumbing, NOT a signal-logic change): a v2.2 SHORT's intraday TP1 had no working exit — maintainV2_2BrokerOrders left the full-size entry stop holding ALL shares (it cancelled the wrong id after a blind 800ms sleep, and findOpenOrder's endsWith('-stop')/('-tp1') MISSED the timestamped re-placed orders — the twin of the v2.2.6 closePosition bug), so the runner stop + TP1 OCO failed `insufficient qty available: 0` and, because Branch A skips the daily-poll TP1 for v2.2 shorts, the short could never bank TP1 (live: PYPL 17sh short, RSI ~32.9 << 50, stuck 100% open). FIX: (1) findOpenOrder matches `<suffix>(-\\d+)?$` so timestamped re-places are found; (2) maintain cancels the resting stop by the TRACKED pos.brokerStopOrderId (robust to any client_order_id) + the suffix-found stop + (pre-TP1 short) any resting TP1 OCO, WAITS for release via waitForNoOpenOrders (not a sleep), then places the runner-only stop; (3) the TP1 half is placed as the OCO buy-limit at the RSI-50 target with shares now free — where price has already passed the target (PYPL) it is marketable → fills → banks TP1. (4) Before ANY close/reset the bot sweeps ALL open orders on that ONE symbol (new executor.cancelAllOpenOrders) — incl. a MANUAL break-even stop placed via the Alpaca UI (Alpaca-generated client_order_id, no SID tag) that the tracked-id/suffix cancels can't see and that would otherwise hold the shares + hang waitForNoOpenOrders. Symbol-scoped (never other symbols). NO canon rule change (RSI 30/70, MACD alignment, RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout, share math, entry/arm/scan all byte-for-byte unchanged; the v2.2.5/2.2.6 cancel-first CLOSE mechanics untouched — only a broader symbol-scoped sweep added ahead of them). Ships with the sid.yml cron-redundancy change. (paper trading, 2026-09-01)
// V2.4.1 ACCOUNTING RECONCILE (NOT a signal-logic change): (1) per-close real-fill booking — TP1 (Branch A), TP2 (Branch B), and recordExternalClose now book the CONFIRMED Alpaca filled_avg_price (from pollOrderFill / the closed-order fills) instead of the simulated bar/SMA trigger price; every closed record is stamped pnl_source ('alpaca_fill' when the real fill was read, 'estimate' on fallback) + mode. Falls back to the bar/SMA estimate only when the real fill is unavailable (never silently wrong). (2) The ledger (sid-account.json realizedPnl/tradeCount/accountUsd) is now RE-DERIVED from the on-disk records every close (realizedPnl = Σ closed records of the account's mode + Σ in-flight TP1 partials of that mode; tradeCount = distinct closed records of that mode; accountUsd = startingUsd + realizedPnl) instead of a running `+=` counter — so a deleted/edited record can NEVER leave a phantom loss again (the exact drift the account reconcile fixed retroactively: MCD phantom -$78.14 + inflated tradeCount). PAPER/LIVE SEGREGATED: the ledger sums ONLY the current mode's records; the other mode's records are ignored (a future live ledger starts fresh, mode:live, and never mixes with paper). NO canon rule change — the RSI-50 TP1 trigger, TP2 SMA50/200/BE/timeout exits, share math, cancel-first stop logic, entry/arm/scan logic are all byte-for-byte unchanged; only the exit PRICE source + the ledger DERIVATION changed. Pairs with reconcile-account.js + alpaca-account-sid.json + the dashboard re-point at real Alpaca paper equity. (paper trading, 2026-07-18)
// V2.4.0 PDT-SAFE EXECUTION MODE (new opt-in execution mode, NOT a signal-logic change): adds SID_PDT_SAFE (default FALSE = the standard "PDT version" with broker GTC stops + resting intraday short-TP1 limit). When SID_PDT_SAFE=true, the bot places NO broker order that can fire intraday same-day — it SKIPS maintainV2_2BrokerOrders entirely (no resting GTC stop, no resting intraday short-TP1 limit) AND does not place the entry-time broker stop, for BOTH the normal entry path (openEntryNoStop) AND the approved-entry path (approve-trade.js). PDT-safe positions carry pdt_safe:true + brokerStopOrderId:null → isV2_2Position()===false → they are managed SOLELY by the daily-poll in checkPositions (TP1 RSI-50, TP2 SMA50/SMA200/BE/timeout, and a stop breach → market close at the NEXT run's open). GUARANTEE: because checkPositions only scans bars strictly AFTER the entry date, runs AFTER the entry loop adds the position, and there are no broker orders, no exit can fire on the same calendar day as entry → PDT-immune (v2.0's original design, restored as opt-in for sub-$25K margin accounts, which SID's shorts require). Standard mode (pdtSafe=false) is byte-for-byte unchanged. Honest trade-offs: no intraday stop (a hard mid-day move isn't cut until the next run's open → gap/slippage, ~few-% profit reduction) and a missed run leaves a position unprotected longer. The fresh installer (SID-DEPLOY-PROMPT.md Step 8) now asks the follower's funding size and branches: $25K+ → PDT version (SID_PDT_SAFE=false); under $25K → PDT-safe (true). NO canon rule change (RSI 30/70, MACD alignment, RSI-50 TP1 trigger, earnings blackout, AUTO-80 all untouched); headline backtest numbers unchanged. (paper trading, 2026-07-17)
// Version history:
//   v2.4.3 ACCOUNTING / DISPLAY FIXES (2026-09-05, paper trading):
//        - FIX 1 — recordExternalClose DOUBLE-COUNTED already-booked fills.
//          It queried Alpaca for every FILLED exit order on the symbol since the
//          position opened and consumed them most-recent-first up to sharesClosed
//          — with NO memory of which fills a PREVIOUS close had already booked. So
//          a second external close on the same symbol walked back into leg 1's
//          fills and priced part of leg 2 at leg 1's price.
//          PROVEN (live paper, PYPL short 17sh @ $60.675, closed manually in two
//          legs): leg 1 = 9sh @ $52.40 -> +$74.47 (CORRECT). Leg 2's real fills
//          were 6 @ $56.66 + 2 @ $56.71 (avg $56.6725 -> TRUE +$32.02), but the
//          bot booked +$57.58 at "exit $53.4775" — which decodes EXACTLY as
//          (2 x 56.71 + 6 x 52.40) / 8: two shares at the correct new price, then
//          six shares back-filled at $52.40, the price leg 1 had already consumed.
//          FIX: new consumedExitFillQty() builds a Map<orderId, qtyAlreadyBooked>
//          from (a) every prior closed record's `exit_fills` stamp for that symbol
//          and (b) the bot's own TP1 partial-close order (now stamped on the
//          position as `tp1_close_order_id`, since its fill is already booked as
//          tp1_pnl). recordExternalClose subtracts that from each order's
//          filled_qty and can only draw the REMAINDER — the same per-lot
//          consumption model reconcile-account.js's allocateFillsFIFO already
//          uses, deliberately mirrored rather than re-invented. Every close keeps
//          stamping the exact { orderId, qty, price } it consumed into
//          `exit_fills`, so the exclusion stays deterministic for future closes.
//          HONESTY GUARD: if the surviving (unconsumed) fills cover FEWER shares
//          than the close, the record is stamped pnl_source:'estimate' with
//          `exit_fill_qty` / `exit_fill_shortfall` rather than presenting an
//          extrapolated price as a full-coverage 'alpaca_fill'.
//        - FIX 2 — the dashboard's LIVE net-P&L headline was a FROZEN snapshot.
//          alpaca-account-sid.json had exactly ONE writer: reconcile-account.js,
//          and only under an explicit `--write`. bot-sid.js never wrote it and
//          sid-dashboard.js only reads it, so the dashboard rendered the
//          2026-07-17 equity ($100,182.18) as "current" for SEVEN WEEKS.
//          FIX: run() now writes the snapshot every run straight from the account
//          read the Alpaca preflight ALREADY performs (no extra API call) —
//          { equity, startingEquity, netPnl, source:'alpaca', mode, asOf, writer,
//          botVersion }. MODE-SEGREGATED: paper writes alpaca-account-sid.json
//          (the existing dashboard file), any other mode writes
//          alpaca-account-<mode>-sid.json, so a paper run can NEVER overwrite a
//          live snapshot (or vice-versa). Best-effort: a snapshot write failure
//          logs and is swallowed — it must never abort a trading run.
//          `.github/workflows/sid.yml` now stages the snapshot in its commit step
//          (it previously did not, so even a written refresh never reached the
//          dashboard), and sid-dashboard.js flags any snapshot older than
//          SNAPSHOT_STALE_DAYS (2) as STALE instead of showing it as current.
//        - NOT a signal-logic change. RSI 30/70, RSI(3), MACD alignment, weekly
//          gates, the earnings blackout, the AUTO-tier universe, the RSI-50 TP1
//          trigger, the TP2 SMA50/SMA200/BE/timeout exits, the share math and the
//          v2.2.5 / v2.2.6 / v2.4.2 cancel-first + symbol-scoped-sweep close
//          mechanics are all byte-for-byte unchanged.
//   v2.4.2 SHORTS-TP1 OCO FIX (2026-09-01, paper trading):
//        - ROOT CAUSE: a v2.2 SHORT's intraday TP1 relies SOLELY on the resting
//          broker OCO — checkPositions Branch A `continue`s past the daily-poll TP1
//          for v2.2 shorts (line ~1863). maintainV2_2BrokerOrders was meant to
//          reduce the full-size entry stop to the runner half and place the TP1 OCO
//          on the freed half, but (a) it cancelled `existingStop.id` from a suffix
//          scan that used endsWith('-stop') and so MISSED every timestamped
//          re-placed stop (`${prefix}-stop-${ts}`) — the twin of the v2.2.6
//          closePosition bug — and (b) used a fixed 800ms sleep instead of waiting
//          for share release. So the full-size stop kept holding ALL shares and both
//          the runner stop AND the TP1 OCO failed `insufficient qty available: 0`
//          (only console.warn'd) → the short had NO working TP1 mechanism at all.
//          Live: PYPL 17sh short, RSI ~32.9 << 50, stuck 100% open for days.
//        - FIX (1) findOpenOrder now matches `<suffix>(-\\d+)?$` so bare AND
//          timestamped `-stop`/`-tp1` are found. `-restop-<ts>` is intentionally NOT
//          matched — it's cancelled directly via the tracked brokerStopOrderId.
//        - FIX (2) maintain stop reset: cancel the TRACKED pos.brokerStopOrderId by
//          id (robust to ANY client_order_id) + the suffix-found stop + (pre-TP1
//          short) any resting TP1 OCO, then waitForNoOpenOrders (real release, not a
//          sleep), then place the runner-only stop (shares_total − tp1). Resets only
//          when the stop is missing / wrong-size / wrong-price → no steady-state churn.
//        - FIX (3) the TP1 half is placed as the existing OCO buy-limit at the RSI-50
//          target with its shares now free. Where price has already passed the target
//          (short in profit beyond RSI-50), the buy-limit is marketable → fills
//          immediately → banks TP1 (catch-up).
//        - FIX (4) SYMBOL-SWEEP before ANY close/reset: new
//          executor.cancelAllOpenOrders(symbol) cancels EVERY open order on the ONE
//          symbol — SID-tagged AND a MANUAL/external order (e.g. a break-even stop the
//          user placed via the Alpaca UI: Alpaca-generated client_order_id, no SID tag
//          → invisible to the tracked-id + suffix cancels). Such an order would else
//          hold the shares and hang waitForNoOpenOrders → `insufficient qty available:
//          0`. Wired into maintain's reset AND both close branches (TP1 Branch A, TP2
//          Branch B). Symbol-scoped (re-checks each order's symbol before cancel) +
//          per-order try/catch so one failure can't abort the sweep.
//        - PYPL VALIDATION: on the next market-hours maintain run the 17-share stop
//          → 9-share runner stop + 8-share TP1 OCO @ the RSI-50 target; the OCO is
//          marketable → fills → TP1 banks; syncPositions marks tp1_hit + BE next run.
//        - Also fixes latent twins the same regex miss caused: the short TP1 OCO
//          re-price/dedup (existingTp1 was never found), and long post-TP1 BE-stop
//          maintenance (the timestamped BE stop was never matched).
//        - NO canon rule change (RSI 30/70, MACD alignment, RSI-50 TP1 trigger, TP2
//          SMA50/200/BE/timeout, share math, entry/arm/scan all untouched); the
//          v2.2.5/2.2.6 cancel-first CLOSE paths are byte-for-byte untouched. Broker
//          -order plumbing only. Ships with the cron-redundancy sid.yml change.
//   v2.4.0 PDT-SAFE EXECUTION MODE (2026-07-17, paper trading):
//        - MOTIVATION: the standard bot places broker GTC stops + a resting intraday
//          short-TP1 limit from entry (maintainV2_2BrokerOrders). Those CAN fill the
//          SAME day as entry → a day trade → Pattern Day Trader (PDT) exposure. A
//          margin account under $25,000 making 4+ day trades in 5 business days gets
//          flagged + restricted by Alpaca/FINRA. SID shorts require margin, so
//          sub-$25K followers are PDT-subject. The old v2.0 design (no broker orders,
//          daily-poll exits always land on a LATER day) was PDT-immune — restored here
//          as an OPT-IN mode.
//        - CONFIG: new pdtSafe (env SID_PDT_SAFE), DEFAULT FALSE = the standard "PDT
//          version" (broker stops); the sub-$25K user opts IN with true.
//        - ENTRY (pdtSafe=true): run() calls executor.openEntryNoStop() (market entry
//          ONLY, no GTC stop) instead of openEntry(); approve-trade.js skips its
//          placeStop() call. Both leave brokerStopOrderId=null + clientOrderIdPrefix
//          =null and stamp pdt_safe:true on the position record.
//        - MANAGEMENT (pdtSafe=true): pdt_safe positions get isV2_2Position()===false
//          (guarded explicitly at the top of the fn), so maintainV2_2BrokerOrders is
//          NEVER called and posIsV2_2=false routes them through the daily-poll TP1/TP2/
//          stop close path in checkPositions. The daily-poll's cancel-first close is a
//          no-op on the (null) broker stop, so no cancel is needed.
//        - SAME-DAY GUARANTEE: checkPositions runs BEFORE the entry loop adds the new
//          position (so it isn't scanned on entry day at all) AND, once scanned on the
//          next run, only bars with date STRICTLY > openDate can trigger a close. With
//          no broker orders, syncPositions can't detect a same-day fill either. Earliest
//          possible exit is therefore the NEXT run's open — always a later calendar day.
//        - STANDARD MODE (pdtSafe=false) is byte-for-byte unchanged: the added ternary
//          resolves to openEntry(), the pdt_safe extra is {} (spreads to nothing), and
//          the isV2_2Position guard only fires on pdt_safe===true (never set in standard).
//        - TRADE-OFFS (inherent to PDT-immunity, stated plainly in the docs): no
//          intraday stop (a hard mid-day move isn't cut until the next run's open →
//          gap/slippage, ~few-% profit reduction vs the PDT version); a missed run
//          leaves a position unprotected longer (no broker safety net).
//        - INSTALLER: SID-DEPLOY-PROMPT.md Step 8a now asks the follower's funding size
//          and recommends the PDT version ($25K+) or PDT-safe (under $25K), sets
//          SID_PDT_SAFE accordingly, and explains the PDT rule + the cash-vs-margin fact
//          + a not-financial-advice caveat. sid.yml + sid-approve-trade.yml pass
//          SID_PDT_SAFE through.
//        - NO canon rule change (RSI 30/70, MACD alignment, RSI-50 TP1 trigger,
//          earnings blackout, AUTO-80 all untouched); headline backtest numbers
//          unchanged.
//   v2.3.0 V2.3.0 TELEGRAM YES/NO TRADE-APPROVAL FLOW (2026-07-17, paper trading):
//        - MOTIVATION: v2.2.4 gated bullish-asset shorts but "approve" meant Alan
//          manually ran sid-manual-trade.yml, which creates an UNTRACKED off-strategy
//          position (manual-trades-log.json, no TP1/TP2 bot management). This closes
//          that gap: Approve now enters a fully-tracked bot position.
//        - PENDING QUEUE: new pending-approvals-sid.json. The approval gate appends
//          { id, symbol, side, proposedEntry, proposedStop, proposedShares,
//          signalDate, rsiAtEntry, createdAt, status:'pending' } (de-duped on the
//          deterministic id, pruned after SID_PENDING_TTL_DAYS). Existing log +
//          Telegram alert are unchanged, just extended with buttons.
//        - TELEGRAM BUTTONS: alertShortApprovalNeeded() now sends an inline keyboard
//          [✅ Approve] callback_data=`approve:<id>` / [❌ Skip] callback_data=`skip:<id>`.
//          sendMessage() gained an optional reply_markup passthrough.
//        - CLOUDFLARE WORKER (SID/approval-worker/worker.js): Telegram webhook
//          receiver. SECURITY: rejects unless X-Telegram-Bot-Api-Secret-Token ===
//          WEBHOOK_SECRET (401), and callback_query.from.id === ALLOWED_CHAT_ID
//          (only Alan). On approve → GitHub REST workflow-dispatch of
//          sid-approve-trade.yml (least-privilege fine-grained token, Actions RW on
//          one repo). Answers the callback + edits the message to a confirmation.
//        - APPROVE WORKFLOW (.github/workflows/sid-approve-trade.yml): workflow_dispatch
//          input approval_id → node approve-trade.js → commits state back (open/pending/
//          trades/account/log) with the standard pull --rebase --autostash push.
//        - approve-trade.js: reads the pending record, aborts safely if unknown/
//          actioned/expired, market-hours guard, then ENTERS AT CURRENT PRICE with a
//          recomputed/validated stop, 1% sizing on the live entry→stop distance,
//          logs the proposed-vs-actual delta, writes a FULL v2.3.0 tracked position
//          via the shared buildEntryPositionRecord() factory (so checkPositions/
//          maintainV2_2BrokerOrders manage TP1/TP2 normally), marks the pending
//          record 'approved', appends trades.csv, updates the account ledger, logs an
//          approval_entry, and Telegram-confirms.
//        - SCHEMA-REUSE: new exported buildEntryPositionRecord() is used by BOTH
//          run() and approve-trade.js so the v2.2.x position schema can never drift
//          between the two entry sources. calcPositionSize/fetchDailyCandles/state
//          I/O helpers are exported for the same reason.
//        - SECURITY MODEL (baked in everywhere): only ALLOWED_CHAT_ID can approve;
//          webhook secret_token header required; GitHub token is fine-grained
//          least-privilege (Actions RW, ONE repo); no secrets in code/committed files
//          (wrangler secret put + repo secrets); fires on PAPER only; the workflow
//          aborts on an unknown/stale approval_id (no blind trade).
//        - NO canon rule change. Headline backtest numbers unchanged.
//   v2.2.6 V2.2.6 TP2 CANCEL-FIRST / RUNNER-HELD-SHARES FIX (2026-07-17, paper trading):
//   v2.2.6 V2.2.6 TP2 CANCEL-FIRST / RUNNER-HELD-SHARES FIX (2026-07-17, paper trading):
//        - ROOT CAUSE: exact twin of the v2.2.5 TP1 bug, on the TP2 branch. After
//          TP1 banks, the v2.2 broker design leaves a full-RUNNER GTC break-even
//          stop resting (pos.brokerStopOrderId, client_order_id `...-stop-<ts>`).
//          Alpaca "holds" the runner shares against it, so when checkPositions
//          Branch B fired a legitimate TP2 (SMA50 touch) and called
//          executor.closePosition() → DELETE /v2/positions/SYM, it returned
//          `insufficient qty available (requested: N, available: 0)` EVERY run.
//          The old catch just logged tp2_close_fail and re-queued the position →
//          the same silent retry loop the TP1 fix cured. PYPL (12sh runner, BE
//          $41.41) failed 4×, ADBE (2sh runner, BE $200.79) 2×, 2026-07-13→16.
//          (closePosition's own cleanup only cancels client_order_ids ending in
//          the literal `-stop`, but placeStop/maintainV2_2BrokerOrders append a
//          timestamp, so it never matched — hence the leak.)
//        - TP2 TRIGGER WAS LEGITIMATE, not a false positive: both runners rallied
//          FAVOURABLY up through their SMA50 (PYPL close $56.73 vs SMA50 $44.51 &
//          SMA200 $52.90; ADBE close $235.31 vs SMA50 $230.94). The crossedSMA
//          gap-cross clause fired correctly — the runners genuinely earned a TP2
//          exit and were stuck retrying because the CLOSE failed, not the trigger.
//        - FIX (checkPositions Branch B): mirror the v2.2.5 TP1 cancel-first order
//          of operations — (1) CANCEL the resting BE broker stop
//          (pos.brokerStopOrderId + any lingering -stop) and WAIT for zero open
//          orders to release the runner shares; (2) submit the runner close and
//          POLL the order until it FILLS; (3) TP2 fully closes the runner so no
//          re-stop is needed on SUCCESS. If the close is REJECTED or the fill
//          isn't confirmed, re-place a protective stop on the remaining runner qty
//          and raise a LOUD alarm (tg.alertTp2CloseFailed) — tp2Hit is NOT booked,
//          so it retries next run with the runner protected.
//        - LOUD FAILURE: new tg.alertTp2CloseFailed() Telegram alarm (twin of
//          alertTp1CloseFailed). sid-log tp2_close_fail now carries `reason` +
//          `reprotected` so the exact TP2 trigger + protection state is recorded.
//        - CAP RAISE: CONFIG.maxOpenPositions default 3→5 (env SID_MAX_POSITIONS).
//          Capital: 5 × maxPositionPct 10% = ~50% max deployed (1%-risk sizing is
//          usually well under the 10% cap, so real deployment is lower). No cap
//          on total risk beyond the per-position 10%.
//        - UNIVERSE: BITF removed from watchlist-sid.json (master + HUMAN tier)
//          and asset-classification.json — delisted, returned Alpaca HTTP 404
//          every run and was silently skipped. AUTO-80 tier UNCHANGED (BITF was
//          HUMAN/LOG-only, never auto-fired). Universe 113→112, HUMAN 33→32.
//          (The v2_human_approval_33 JSON key name is left as-is to avoid breaking
//          the Python backtests that read it literally; it now holds 32.)
//        - HOUSEKEEPING: deleted stale one-shot workflow
//          .github/workflows/sid-oneshot-close-unh-2026-07-01.yml — the UNH short
//          it targeted (id d9bca959…, entry $416.52) stopped out on its broker
//          stop 2026-07-01 ($428.05, exit_strategy full_external_fill), so the
//          position no longer exists.
//        - NO SIGNAL-LOGIC CHANGE. RSI 30/70 thresholds, RSI+MACD alignment, the
//          RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier
//          80-ticker universe are ALL untouched. Backtest numbers UNCHANGED —
//          execution-plumbing + config + universe-hygiene fix, not a rule change.
//   v2.2.5 V2.2.5 TP1 CANCEL-FIRST / HELD-SHARES FIX (2026-07-01, paper trading):
//        - ROOT CAUSE: the v2.2 broker design leaves a full-size GTC stop
//          resting from entry (pos.brokerStopOrderId). Alpaca "holds" every
//          share against that stop, so the long TP1 partial close
//          (DELETE /v2/positions/SYM?qty=N) returned `insufficient qty available
//          for order (requested: N, available: 0)` on EVERY run. PYPL (long 23sh
//          @ $41.395, RSI(14) ≥ 50 since 2026-06-26) failed its TP1 for 5 days
//          straight, silently — TP1 profit never banked.
//        - LONG FIX (checkPositions Branch A): correct order of operations —
//          (1) CANCEL the resting broker stop (pos.brokerStopOrderId + any
//          lingering -stop) to release the shares and WAIT for zero open orders;
//          (2) submit the partial close and POLL the order until it FILLS;
//          (3) only then re-place the break-even stop on the RUNNER (remaining
//          shares) at the direction-aware BE price. If the partial fill is NOT
//          confirmed, the FULL remaining qty is re-protected with a stop and a
//          LOUD alarm fires — the position is never left naked.
//        - SHORT FIX (maintainV2_2BrokerOrders): the short-side twin. While TP1
//          is still pending, the resting -stop reserves only the RUNNER half
//          (shares_total - tp1Qty) instead of the full position, so the resting
//          TP1 limit can actually be placed (it used to fail silently with
//          `insufficient qty`). The TP1 half is now an OCO (limit TP1 + stop SL)
//          so BOTH legs are protected — mirrors the documented manual-trade.js
//          OCO pattern. Longs are unaffected (no resting TP1 limit).
//        - LOUD FAILURE: new tg.alertTp1CloseFailed() Telegram alarm on any TP1
//          close failure or unconfirmed fill, so a 5-day silent failure cannot
//          recur. New sid-log kinds: tp1_close_fail carries `reprotected`;
//          be_stop_place_fail when the runner BE stop can't be placed post-TP1.
//        - New executor helpers (alpaca-executor.js): cancelOrderById (best-effort,
//          treats 404/422 as already-gone), waitForNoOpenOrders (poll shares
//          released), pollOrderFill (confirm the market close filled), placeStop
//          (re-place BE / re-protect stop on N shares).
//        - Dashboard (sid-dashboard.js): each OPEN-position card now shows the
//          dynamic EXIT TARGETS — TP1 (current daily RSI(14) vs 50 + tp1_hit / or
//          the short RSI-50 target price), TP2 (SMA50 & SMA200), and the current
//          stop/BE. Additive only.
//        - NO SIGNAL-LOGIC CHANGE. RSI 30/70 thresholds, RSI+MACD alignment, the
//          RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier
//          80-ticker universe are ALL untouched. Backtest numbers UNCHANGED —
//          this is an execution-plumbing + observability fix, not a rule change.
//   v2.2.4 V2.2.4 SHORT APPROVAL GATE (2026-07-01, paper trading):
//        - PRE-ENTRY discipline overlay. A mechanical SHORT signal on a
//          long-term-bullish asset (longTermBullish(): daily price>SMA200 AND
//          SMA50>SMA200) is NO LONGER auto-executed. Instead the bot logs a
//          `short_approval_required` entry to sid-log.json and sends a
//          `tg.alertShortApprovalNeeded()` Telegram alert (symbol, signal date,
//          current price, proposed entry+stop, would-be size, and how to fire it
//          manually). Alan approves by firing the trade himself at the right
//          level (e.g. into a supply zone) via the existing manual one-shot flow
//          (manual-trade.js + sid-manual-trade.yml) — no auto-fire, no
//          reply-to-approve infra for v1.
//        - Motivation: v2.2.2's MANUAL-WATCH flag only FLAGGED bullish-asset
//          shorts for post-TP1 runner review — it did not block entry. So UNH
//          auto-shorted at $416.52 (2026-06-30) far below its 439-440 supply
//          zone. This turns that post-entry flag into a pre-entry gate so
//          discretion is applied BEFORE the position is opened.
//        - Gated in run() AFTER the AUTO/HUMAN tier routing, BEFORE
//          sizing/earnings/PPI/VIX — evaluated via longTermBullish(candles) at
//          signal/entry time. Longs and non-bullish-asset shorts are
//          UNAFFECTED and still auto-fire.
//        - NO SIGNAL-LOGIC CHANGE. RSI 30/70 thresholds, RSI+MACD alignment, the
//          RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier
//          80-ticker universe are ALL untouched. The v2.2.x backtests
//          (280 trades / 73.9% WR / PF 3.19 / +$31,426) INCLUDE these
//          bullish-asset shorts firing mechanically — gating them is a LIVE
//          execution-discipline overlay, so LIVE performance will DELIBERATELY
//          diverge from the pure backtest on this subset. Documented in the
//          README/dashboard/CLAUDE.md so followers understand live != backtest.
//        - Toggle: SID_SHORT_APPROVAL_GATE=false reverts to fully-mechanical
//          bullish-asset shorts (matches the pure backtest). Default ON.
//        - New CONFIG.shortApprovalGate; new tg.alertShortApprovalNeeded().
//   v2.2.3 V2.2.3 ENTRY OVERHAUL (2026-06-28, paper trading):
//        - detectEntrySignal rewritten from a loose one-shot "episode scan"
//          (no arm timeout / no RSI(3) confirm / no weekly-SMA gate — it fired
//          stale signals like a UNH/ADBE long entered days after its oversold
//          signal) into a BOUNDED BAR-BY-BAR REPLAY of the validated backtest's
//          arm/trigger/cooldown state machine. Replays the trailing
//          CONFIG.armReplayBars (default 40) bars from clean state and returns a
//          signal ONLY if a trigger fires on the final (today's) bar.
//        - Restores the three missing entry gates: 3-day arm timeout, RSI(3)
//          rebound confirmation, weekly SMA50/200 arm gate. Adds an Alan
//          refinement from a cooldown sweep — FREE-REARM longs (catch bullish
//          V-shaped recoveries) but a SHORTS-ONLY 5-DAY re-arm cooldown (wait out
//          the recovery so shorts don't re-fire low-quality counter-trend
//          repeats; clean optimum at 5d — short WR 62.9%→72.3%).
//        - New CONFIG knobs (env-overridable): armTimeoutDays=3,
//          rearmCooldownLong=0, rearmCooldownShort=5, armReplayBars=40. intEnv()
//          helper preserves a legitimate 0 (rearmCooldownLong).
//        - The scan data fetch was bumped 2y→5y so the weekly-SMA gate (needs
//          ~200 weekly bars) actually applies live.
//        - EXITS UNCHANGED — still the v2.2.1 HYBRID model (close-based long TP1,
//          intraday-touch short TP1, broker GTC stops). Only the ENTRY changed.
//        - Backtest (SID/backtest-sid-bot-parity.py, tier1, 5y, $200 fixed risk):
//            280 trades, 73.9% WR, PF 3.19, +$31,426 — Pareto-dominates v2.2.1
//            (+$2,091 / +0.50 PF / +2.9pp WR). Investigation + reference entries
//            CSV: SID/strategy-test-vault/bot-parity-experiment/.
//   v2.2.2 V2.2.2 MANUAL-WATCH FLAG (2026-06-13, paper trading):
//        - Monitoring aid ONLY — no trade-logic change. The bot now flags any
//          open SHORT on a long-term-bullish asset (price > 200-day SMA AND
//          50-day SMA > 200-day SMA) for manual S/R review, because on bullish
//          names the mechanical TP2 has a blind spot (RSI rarely reaches daily
//          oversold before the bounce; the SMA exit can round-trip to BE).
//        - Surfaces three ways: a dashboard WATCH badge, a ⚠ MANUAL-WATCH bot-log
//          line, and a consolidated Telegram reminder each run. TP1 still banks
//          mechanically; only the runner half needs the eye. Helper:
//          longTermBullish() in bot-sid.js. Trade logic + backtest identical to
//          v2.2.1.
//   v2.2.1 V2.2.1 HYBRID (2026-06-09, paper trading):
//        - Side-asymmetric TP1. Per-side decomposition of v2.2 showed shorts
//          strictly benefit from intraday-touch (+WR AND +PnL — the bullish drift
//          of US equities punishes shorts that round-trip through 50), but longs
//          LOSE PnL under pure v2.2 because the bullish drift WORKS FOR longs
//          (letting price CLOSE past 50 books a bigger TP1 partial).
//          • LONGS  → revert to v2.1 close-based TP1 (RSI(14) ≥ 50 on daily close).
//          • SHORTS → keep v2.2 intraday-touch TP1 via a resting GTC limit at the
//            solved RSI-50 target price (SID/rsi-target-price.js).
//          Both sides keep the broker-enforced GTC stop on Alpaca from entry.
//        - Sizing compounds off an internal sid-account.json ledger rather than
//          Alpaca paper equity. Pine sister: SID/pine/sid-strategy-v2.2.1-hybrid.pine.
//        - Backtest: 303 trades, 71.3% WR, PF 2.72, +$29,528 — Pareto-dominates
//          v2.1 on every metric (+1.7pp WR / +0.10 PF / +$211 PnL / same trades).
//          Vault: SID/strategy-test-vault/v2.2.1-hybrid-shorts-intraday/.
//   v1.0 initial RSI(14) + MACD(12,26,9), daily, US stocks/ETFs
//   v1.1 15-min intraday entry confirmation
//   v1.2 instructor-aligned: sticky RSI signal, MACD direction-align entry
//   v1.3 RSI overbought 70->75, RSI(3) rebound-zone confirm
//   v1.4 weekly 50/200 SMA trend filter (locked at tag sid-v1.4-baseline)
//   v1.5 earnings rule clarified to pre-only (block 14 days BEFORE earnings)
//   v1.6 PPI blackout + REFINED 47 watchlist (locked at tag sid-v1.6-baseline)
//   v1.7 VIX >= 30 gate + 80-ticker tier1 expansion (locked at sid-v1-method-baseline)
//   v2.1 V2.1 DYNAMIC TP LAUNCH (2026-05-18, paper trading):
//        - Entry rules unchanged from v2.0 (v2-weekly-or remains the entry stack)
//        - NEW EXIT MODEL — TP1 + TP2 partial exits per instructor S3_P1 / S3_P2:
//          • TP1 = RSI 50 → close 50% of position. Move stop to break-even on
//            remaining 50%. Locks in the half-position profit guaranteed by
//            the v2.0 exit while keeping a runner for the bigger move.
//          • TP2 = whichever fires first on the remaining 50%:
//              - Price touches 50-day SMA (instructor's "first MA target")
//              - Price touches 200-day SMA (instructor's "trend MA target")
//              - Break-even stop hit (price returns to entry)
//              - 30-trading-day timeout (close at next-day open)
//        - Backtest validation on tier1 80-ticker AUTO universe, 5 years
//          (1% risk per trade, fixed $200 risk in the simulator):
//            V2.0 baseline: 296 trades, 70.3% WR, PF 2.57, total +$26,750
//            V2.1 dynamic : 302 trades, 69.5% WR, PF 2.55, total +$28,046
//          V2.1 BEATS V2 by +$1,296 (+4.8%) over 5 years with essentially the
//          same trade count. TP2 uplift on winners is +$24,733 (+115% more
//          than what V2 captures by closing fully at RSI 50). The 14-day-
//          timeout variant adds another +$403 (+0.1pp WR).
//          NOTE: an earlier version of the V2.1 backtest reported only 67
//          trades / +$7,759 — that was a data-window bug (insufficient
//          indicator warmup) in the backtest's main() loop, not a strategy
//          issue. Fixed 2026-05-18 to match V2's 10y download (5y warmup +
//          5y trade window). The live bot's entry detection in this file
//          was always correct.
//        - SCHEMA CHANGE — open-positions-sid.json entries gain:
//            tp1_hit, tp1_date, tp1_price, tp1_shares, tp1_pnl, tp1_idx,
//            shares_total, shares_remaining, orig_stop
//          Legacy v2.0 positions are upgraded on first read (tp1_hit=false).
//        - SCHEMA CHANGE — closed-positions-sid.json adds:
//            tp1_*, tp2_*, total_pnl, exit_strategy
//        - Toggle: SID_DYNAMIC_TP=false reverts to v2.0 single-exit at RSI 50.
//        - DEFERRED to v2.2: Rating engine, short counter-trend gate, Telegram
//          approval flow for HUMAN tier, dashboard Signal Watch widget.
//   v2.0 V2 METHOD LAUNCH (2026-05-16, paper trading):
//        - RSI 70 not 75 (already in bot from v1.3)
//        - NEW: RSI 45/55 no-go zone at entry (instructor S2_Ep3)
//        - NEW: 1% risk default (instructor S3_Ep4)
//        - NEW: AUTO/HUMAN tier routing — HUMAN tier currently LOG-only,
//          Telegram approval flow deferred to v2.1
//        - NEW: PDT-IMMUNE DESIGN — bot manages stops itself instead of
//          submitting Alpaca stop orders. Stop checks happen on each daily
//          run; if breached, the bot submits a market close at next-day
//          open. Guarantees entry and exit are on different calendar days
//          → no day trades ever → no PDT classification at sub-$25K
//          accounts. Trade-off: stop fills at next-morning open price,
//          ±1-2% slippage vs the exact stop level.
//        - NEW: WEEKLY RSI / MACD DIRECTION CHECK at entry (OR mode):
//          require either weekly RSI rising OR weekly MACD rising for
//          longs (mirror for shorts). Resampling groups daily candles by
//          their Monday-key so the in-progress week is addressable. This
//          completes the full V2 method (v2-weekly-or backtest variant):
//          64.9% WR / PF 2.04 / 34.7% CAGR / 7.95% max DD over 5y on
//          113-ticker universe.
//        - Toggle: SID_WEEKLY_DIRECTION=false to disable the weekly gate
//          (falls back to v2-nogo-only behaviour: ~56% WR / more trades).
//        - DEFERRED to v2.1: Telegram approval flow for HUMAN-tier signals
//          (currently LOG-only).

const TRADES_PATH     = path.join(__dirname, 'trades-sid.csv');
const POSITIONS_PATH  = path.join(__dirname, 'open-positions-sid.json');
const CLOSED_PATH     = path.join(__dirname, 'closed-positions-sid.json');
const ACCOUNT_PATH    = path.join(__dirname, 'sid-account.json');
const SAFETY_LOG_PATH = path.join(__dirname, 'sid-log.json');
const WATCHLIST_PATH  = path.join(__dirname, 'watchlist-sid.json');
const EVENT_DATES_PATH= path.join(__dirname, 'event-dates.json');
const PENDING_PATH    = path.join(__dirname, 'pending-approvals-sid.json');  // v2.3.0: Telegram Yes/No approval queue

// v2.3.0: how many days a pending approval stays actionable before it's pruned
// as stale. Approvals CAN legitimately arrive days later (Alan waits for price
// to reach his level), but a setup older than this is no longer the same trade.
const PENDING_TTL_DAYS = intEnv(process.env.SID_PENDING_TTL_DAYS, 5);

// ── Watchlist (loaded from watchlist-sid.json — currently REFINED 47) ─────────
// The watchlist file is the canonical trade list. Edit watchlist-sid.json's
// top-level `tickers` array to change what the bot trades; the bot picks it up
// automatically on the next run. Falls back to a hardcoded list if the file is
// missing / malformed (so the bot is robust to deploy issues).
const HARDCODED_FALLBACK_WATCHLIST = [
  'DIA','IWM','QQQ','SPY','AAPL','AMD','AMZN','BA','CAT','COST',
  'DIS','GOOG','GS','HD','IBM','INTC','JPM','META','MCD','PYPL',
  'TGT','TSLA','WMT','XLC','XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY',
];
function loadWatchlist() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    if (Array.isArray(j.tickers) && j.tickers.length > 0) {
      console.log(`Watchlist : loaded ${j.tickers.length} tickers from ${WATCHLIST_PATH} (version ${j.version || '?'})`);
      return j.tickers;
    }
  } catch (err) {
    console.warn(`⚠  Could not load ${WATCHLIST_PATH}: ${err.message} — using hardcoded fallback`);
  }
  return HARDCODED_FALLBACK_WATCHLIST;
}
const WATCHLIST = loadWatchlist();

// ── Macro event dates (PPI only — FOMC/CPI tested and REJECTED in backtest) ──
// PPI dates are loaded from event-dates.json. The 14-day PRE-PPI blackout
// blocks ARMING during the run-up to a PPI release; trading is permitted
// the day after each release.
//
// FOMC and CPI windows were tested in the v1.7 validation backtest and found
// to be HARMFUL (drops WR from 60% -> 49% on 5-year favourites sample). They
// are intentionally NOT consumed by the bot even though the dates are in the
// event-dates.json file (preserved for future research).
function loadPPIDates() {
  try {
    const j = JSON.parse(fs.readFileSync(EVENT_DATES_PATH, 'utf8'));
    if (Array.isArray(j.ppi)) {
      console.log(`Macro     : loaded ${j.ppi.length} PPI dates from ${EVENT_DATES_PATH}`);
      return j.ppi;
    }
  } catch (err) {
    console.warn(`⚠  Could not load PPI dates from ${EVENT_DATES_PATH}: ${err.message} — PPI filter disabled`);
  }
  return [];
}
const PPI_DATES = loadPPIDates();

// ── v1.7 VIX gate ────────────────────────────────────────────────────────────
// Block new entries on high-fear days (VIX >= 30). VIX is the market's
// implied-volatility / fear index — when it spikes, indices are pricing in
// big moves. Historically, oversold bounces during VIX>=30 regimes are
// disproportionately false bounces (e.g. Sept 2022 FOMC + UK crisis cluster
// in our backtest). The gate doesn't close existing positions — it only
// blocks new ARMing for the day.
//
// Per-run check: bot wakes once a day, checks yesterday's VIX close. If
// >= 30, no new entries today. Tomorrow morning: re-check fresh.
const VIX_GATE_THRESHOLD = 30.0;

async function fetchVixYesterdayClose() {
  // Fetches VIX history and returns most-recent close + ISO date.
  // Returns { vix: number, date: string } or null on failure.
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/^VIX?interval=1d&range=10d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('no chart data');
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    // Find most recent non-null close
    for (let i = ts.length - 1; i >= 0; i--) {
      if (closes[i] != null && !isNaN(closes[i])) {
        return {
          vix: parseFloat(closes[i].toFixed(2)),
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`⚠  VIX fetch failed: ${err.message} — VIX gate skipped (trade normally)`);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(entry) {
  let log = [];
  if (fs.existsSync(SAFETY_LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(SAFETY_LOG_PATH, 'utf8')); } catch {}
  }
  log.unshift({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(SAFETY_LOG_PATH, JSON.stringify(log.slice(0, 500), null, 2));
}

function appendTrade(row) {
  const header = 'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy';
  if (!fs.existsSync(TRADES_PATH)) fs.writeFileSync(TRADES_PATH, header + '\n');
  fs.appendFileSync(TRADES_PATH, row + '\n');
}

function countTodayTrades() {
  if (!fs.existsSync(TRADES_PATH)) return 0;
  const today = todayString();
  const lines = fs.readFileSync(TRADES_PATH, 'utf8').trim().split('\n');
  return lines.slice(1).filter(l => l.startsWith(today)).length;
}

// ── Compounding Account State ─────────────────────────────────────────────────
// The account value grows (or shrinks) with every closed trade.
// Position sizing always uses the CURRENT account value so gains compound
// automatically over time. Starting value is $5,000; each exit updates the balance.

function loadAccount() {
  try {
    if (fs.existsSync(ACCOUNT_PATH)) return JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
  } catch {}
  // First run — seed with the configured starting amount
  const initial = {
    accountUsd:    CONFIG.accountUsd,
    startingUsd:   CONFIG.accountUsd,
    realizedPnl:   0,
    tradeCount:    0,
    lastUpdated:   todayString(),
  };
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(initial, null, 2));
  return initial;
}

// Direction-aware realised P&L for a closed leg. Long profits when exit > entry;
// short profits when entry > exit. Single source of truth for the exit-P&L
// formula used by TP1 / TP2 / external-close booking (accounting only — no rule).
function realisedPnlFor(side, entry, exit, shares) {
  const pnl = side === 'long'
    ? (exit - entry) * shares
    : (entry - exit) * shares;
  return parseFloat(pnl.toFixed(2));
}

// The record's mode (records with no mode are legacy PAPER — the V2 paper launch
// predates the field). Used to keep the ledger segregated: the paper ledger sums
// ONLY paper records; a future live ledger sums only live records.
function recordMode(r) { return String(r?.mode || 'paper').toLowerCase(); }

// ── v2.5.0: is a position's TP1 leg ALREADY booked in a closed record? ───────
// A TP1 half can reach the books by two completely different routes:
//
//   (a) THE BOT banked it (checkPositions Branch A). No closed record is written
//       — the leg lives only on the still-open position as `tp1_pnl`, and Branch A
//       stamps the broker order that did it as `tp1_close_order_id`.
//   (b) THE BROKER banked it (a v2.2 resting TP1 OCO filling intraday). syncPositions
//       sees a PARTIAL close -> recordExternalClose writes a CLOSED record for that
//       leg (`is_full_close:false`, same position `id`) AND the v2.2 TP1-detection
//       block in run() ALSO stamps `tp1_pnl` on the live position for the SAME shares.
//
// So "position has tp1_pnl" does NOT imply "the leg is unbooked". Two bugs flow
// from conflating them, and this ONE predicate guards both:
//   * deriveLedger would add the open position's tp1_pnl ON TOP of the closed
//     partial record -> the leg is counted twice on every run (route b).
//   * recordExternalClose's full close must ADD the tp1_pnl leg to total_pnl for
//     route (a) (else the leg silently vanishes when the position closes — the
//     live IBM -$40.76 / HON -$21.02 bug) but must NOT for route (b).
//
// Returns TRUE when a closed PARTIAL record for this position already carries the
// leg. Only `is_full_close === false` records qualify — a full-close record IS the
// trade total, not a separate leg. When the bot banked TP1 itself (we hold the
// order id) and the partial record was priced from OTHER broker orders, the leg is
// NOT in that record, so we keep looking. Ambiguity defaults to TRUE (treat as
// already booked) — for an accounting fix, never inflate.
function tp1LegAlreadyInClosedRecords(pos, closedRecords = []) {
  if (!pos?.tp1_hit || !pos?.id) return false;
  const tp1OrderId = pos.tp1_close_order_id || null;
  for (const r of (closedRecords || [])) {
    if (!r || r.id !== pos.id) continue;
    if (r.is_full_close !== false) continue;   // only a PARTIAL record is a separate leg
    if (tp1OrderId) {
      const fills = Array.isArray(r.exit_fills) ? r.exit_fills : [];
      const usesTp1Order =
        fills.some(f => f?.orderId === tp1OrderId) || r.tp1_close_order_id === tp1OrderId;
      if (!usesTp1Order) continue;             // this partial priced OTHER shares
    }
    return true;
  }
  return false;
}

// Re-derive the ledger for the CURRENT trading mode straight from the on-disk
// records — NEVER a running `+=` counter (that carried a phantom loss when a
// record was later deleted but its delta wasn't reversed; see SID/CLAUDE.md
// § accounting reconcile). realizedPnl = Σ closed records of this mode +
// Σ in-flight TP1 partials on still-open positions of this mode (so a banked
// TP1 compounds into sizing before the runner's record exists). tradeCount =
// distinct CLOSED records of this mode. accountUsd = startingUsd + realizedPnl.
// Paper/live are summed independently — the other mode's records are ignored.
// `sources` lets a caller pass the IN-MEMORY closed/open arrays when the on-disk
// files are not yet saved (checkPositions books P&L in-loop but persists the
// arrays only at the end). Defaults to the on-disk files (recordExternalClose,
// approve-trade, etc. save first, then call updateAccount).
function deriveLedger(mode, sources = {}) {
  const m = String(mode || 'paper').toLowerCase();
  const closedAll = sources.closed ?? loadClosedPositions();
  const openAll   = sources.open   ?? loadOpenPositions();
  const closed = closedAll.filter(r => recordMode(r) === m);
  const open   = openAll.filter(r => recordMode(r) === m);
  const closedSum = closed.reduce((s, r) => s + (r.total_pnl ?? r.realizedPnl ?? 0), 0);
  // In-flight TP1 partials: a still-open runner whose TP1 already banked. Its
  // total_pnl record doesn't exist yet, so add the booked tp1_pnl leg.
  // v2.5.0: ...UNLESS a closed PARTIAL record already carries that same leg (the
  // broker-OCO TP1 path writes one via recordExternalClose AND the v2.2 detection
  // block stamps tp1_pnl on the live position — counting both double-books the
  // leg on every subsequent run). tp1LegAlreadyInClosedRecords is the single
  // shared predicate; recordExternalClose uses the SAME one for the mirror case.
  const openTp1Sum = open.reduce((s, r) => {
    if (!r.tp1_hit) return s;
    if (tp1LegAlreadyInClosedRecords(r, closedAll)) return s;
    return s + (r.tp1_pnl || 0);
  }, 0);
  const realizedPnl = parseFloat((closedSum + openTp1Sum).toFixed(2));
  return { realizedPnl, tradeCount: closed.length };
}

// Re-derive + persist the ledger for the current mode. Called after each close
// booking (the record is written/pushed FIRST, then this re-derives from it) and
// after each TP1 partial (open-position tp1_pnl is set first). The first arg is a
// legacy delta hint that is now IGNORED — the value is always the record-derived
// truth, so a phantom can never accumulate. Pass `sources` = { closed, open }
// (the in-memory arrays) when the on-disk files aren't saved yet.
function updateAccount(_deltaHintIgnored, sources = {}) {
  const account = loadAccount();
  const mode    = String(account.mode || CONFIG.tradingMode || 'paper').toLowerCase();
  const startingUsd = account.startingUsd ?? CONFIG.accountUsd;
  const { realizedPnl, tradeCount } = deriveLedger(mode, sources);
  account.startingUsd = startingUsd;
  account.realizedPnl = realizedPnl;
  account.tradeCount  = tradeCount;
  account.accountUsd  = parseFloat((startingUsd + realizedPnl).toFixed(2));
  account.mode        = mode;
  account.lastUpdated = todayString();
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(account, null, 2));
  return account;
}

// ── v2.4.3: REAL Alpaca account snapshot (dashboard headline source) ─────────
// alpaca-account-sid.json is what sid-dashboard.js renders as the LIVE net-P&L
// headline ("Paper account (simulated) · $X on $Y base"). Until v2.4.3 its ONLY
// writer was reconcile-account.js, and only under an explicit `--write` — the
// bot never wrote it and the dashboard only reads it. Result: the dashboard
// showed a FROZEN 2026-07-17 equity ($100,182.18) as "current" for SEVEN WEEKS
// while the real paper account had moved on. The bot already reads the account
// in its Alpaca preflight, so writing the snapshot costs ZERO extra API calls.
//
// PAPER/LIVE SEGREGATION: paper writes the existing alpaca-account-sid.json;
// any other mode writes alpaca-account-<mode>-sid.json. A paper run can
// therefore NEVER overwrite a live snapshot (or vice-versa) — the same hard
// separation reconcile-account.js applies to the records themselves.
function alpacaSnapshotPathForMode(mode) {
  const m = String(mode || 'paper').toLowerCase();
  return m === 'paper'
    ? path.join(__dirname, 'alpaca-account-sid.json')
    : path.join(__dirname, `alpaca-account-${m}-sid.json`);
}

// Baseline the net-P&L is measured against. Precedence:
//   1. the existing snapshot's startingEquity (never drifts once established)
//   2. SID_ALPACA_STARTING_EQUITY env override
//   3. paper -> 100000 (Alpaca's paper base, which cannot be set lower)
//      other -> the CURRENT equity, i.e. the first live run establishes the
//               baseline so netPnl starts at 0 rather than a bogus six figures.
function alpacaStartingEquityFor(mode, currentEquity, existing) {
  const fromSnap = Number(existing?.startingEquity);
  if (Number.isFinite(fromSnap) && fromSnap > 0) return fromSnap;
  const fromEnv = parseFloat(process.env.SID_ALPACA_STARTING_EQUITY || '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (String(mode || 'paper').toLowerCase() === 'paper') return 100000;
  return Number.isFinite(currentEquity) ? currentEquity : 0;
}

// Write the snapshot. BEST-EFFORT: any failure is logged and swallowed — a
// dashboard-display write must never abort or alter a trading run.
function writeAlpacaSnapshot({ equity, mode }) {
  try {
    if (!Number.isFinite(equity)) return null;
    const p = alpacaSnapshotPathForMode(mode);
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    const startingEquity = alpacaStartingEquityFor(mode, equity, existing);
    const snapshot = {
      equity:         parseFloat(equity.toFixed(2)),
      startingEquity: parseFloat(Number(startingEquity).toFixed(2)),
      netPnl:         parseFloat((equity - startingEquity).toFixed(2)),
      source:         'alpaca',
      mode:           String(mode || 'paper').toLowerCase(),
      asOf:           new Date().toISOString(),
      writer:         'bot-sid',
      botVersion:     BOT_VERSION,
    };
    fs.writeFileSync(p, JSON.stringify(snapshot, null, 2));
    return snapshot;
  } catch (err) {
    console.warn(`[snapshot] Could not write Alpaca account snapshot: ${err.message}`);
    return null;
  }
}

// ── Position Tracking ─────────────────────────────────────────────────────────

function loadOpenPositions() {
  try {
    if (fs.existsSync(POSITIONS_PATH)) return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveOpenPositions(p) {
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(p, null, 2));
}

function loadClosedPositions() {
  try {
    if (fs.existsSync(CLOSED_PATH)) return JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveClosedPositions(p) {
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(p, null, 2));
}

function addOpenPosition(pos) {
  const open = loadOpenPositions();
  if (open.some(p => p.id === pos.id)) return;
  open.push(pos);
  saveOpenPositions(open);
}

// ── v2.3.0: Telegram approval queue (pending-approvals-sid.json) ─────────────
// When the SHORT APPROVAL GATE fires (bullish-asset short not auto-executed),
// the bot appends a PENDING record here. The Telegram alert carries [Approve]
// [Skip] buttons whose callback_data references the record's stable id. Tapping
// Approve dispatches sid-approve-trade.yml with the id → approve-trade.js reads
// this file, finds the record, and enters the trade as a properly tracked bot
// position. The id is DETERMINISTIC (`${symbol}-${signalDate}-${side}`) so the
// same setup can't be queued twice and callback_data stays ≤64 bytes.

function pendingApprovalId(symbol, signalDate, side) {
  return `${symbol}-${signalDate}-${side}`;
}

function loadPendingApprovals() {
  try {
    if (fs.existsSync(PENDING_PATH)) {
      const arr = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {}
  return [];
}

function savePendingApprovals(arr) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(arr, null, 2));
}

// Drop pending records older than PENDING_TTL_DAYS (by createdAt) and any that
// are already actioned (status !== 'pending'). Returns the surviving array.
function prunePendingApprovals(arr, ttlDays = PENDING_TTL_DAYS) {
  const cutoffMs = Date.now() - ttlDays * 86400000;
  return arr.filter(r => {
    if (!r || r.status !== 'pending') return false;
    const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
    if (Number.isFinite(created) && created < cutoffMs) return false;
    return true;
  });
}

// Append a pending approval, de-duping on the deterministic id. Prunes stale
// records in the same write so the file never grows unbounded. Returns the
// record's id.
function addPendingApproval(rec) {
  let arr = prunePendingApprovals(loadPendingApprovals());
  if (!arr.some(r => r.id === rec.id)) arr.unshift(rec);
  savePendingApprovals(arr);
  return rec.id;
}

// ── v2.3.0: shared entry-record factory (schema single source of truth) ──────
// Builds the FULL open-positions-sid.json record for a new entry. Used by BOTH
// the bot's normal entry path (run()) AND the approval flow (approve-trade.js)
// so the v2.2.x schema (shares_total, shares_remaining, orig_stop, tp1_hit,
// brokerStopOrderId, clientOrderIdPrefix, strategy, etc.) can NEVER drift
// between the two entry sources. checkPositions()/maintainV2_2BrokerOrders()
// then manage TP1/TP2 identically regardless of which path opened the position.
//
// `extra` merges on top (e.g. manual_watch:true, approved_via, entry_delta) —
// approval-entered positions carry provenance without changing the core schema.
function buildEntryPositionRecord({
  id, symbol, side, entry, stopLoss, shares, totalUsd, riskUsd,
  signalDate, openDate, openTime, mode, strategyTag,
  brokerStopOrderId = null, clientOrderIdPrefix = null,
}, extra = {}) {
  return {
    id,
    symbol,
    side,                              // 'long' | 'short'
    entry,
    stopLoss,
    shares,                            // legacy field — kept for back-compat
    shares_total:     shares,          // V2.1: immutable original size
    shares_remaining: shares,          // V2.1: drops to 50% after TP1
    orig_stop:        stopLoss,        // V2.1: kept; stopLoss migrates to BE after TP1
    tp1_hit:          false,           // V2.1: flips true at RSI 50
    totalUsd,
    riskUsd,
    signalDate,
    openDate,
    openTime,
    mode,
    strategy:         strategyTag,     // e.g. `SID v2.3.0`
    // V2.2: broker-order tracking for the resting stop + intraday TP1 limit.
    // Setting brokerStopOrderId also makes isV2_2Position() return true, so the
    // position is managed by the v2.2 broker-order path (the tracked-bot path).
    brokerStopOrderId,
    clientOrderIdPrefix,
    ...extra,
  };
}

// ── v2.4.3: consumed-fill ledger (external-close double-count guard) ─────────
// recordExternalClose prices an external close by reading Alpaca's FILLED exit
// orders for the symbol. Before v2.4.3 it re-scanned ALL of them every time with
// no memory of which fills a PREVIOUS close had already booked, so a second
// external close on the same symbol walked back into the first close's fills.
//
// PROVEN on the live paper PYPL short (17 sh, entry $60.675, closed manually in
// two legs):
//   leg 1 — 9 sh @ $52.40                       -> +$74.47  (CORRECT)
//   leg 2 — real fills 6 @ $56.66 + 2 @ $56.71  -> TRUE +$32.02
//           but the bot booked +$57.58 at "exit $53.4775", which decodes
//           EXACTLY as (2 x 56.71 + 6 x 52.40) / 8: two shares at the correct
//           new price, then SIX shares back-filled at $52.40 — leg 1's price.
//
// This builds Map<orderId, qtyAlreadyBooked> so the new close can only draw each
// broker order's REMAINING quantity. It is deliberately the same per-lot
// consumption model that reconcile-account.js's allocateFillsFIFO already uses
// (draw() decrements lot.qtyLeft) rather than a second, divergent scheme.
//
// Sources of "already booked":
//   1. Every prior CLOSED record for this symbol stamps the exact
//      { orderId, qty, price } it consumed in `exit_fills` — that stamp is the
//      deterministic exclusion key (and is why each close keeps writing it).
//   2. The bot's OWN TP1 partial close (Branch A). Its fill is already booked as
//      tp1_pnl, so re-using it to price the runner would double-count. v2.4.3
//      stamps that order id on the position/record as `tp1_close_order_id`.
// Positions/records for OTHER symbols are ignored (symbol-scoped).
function consumedExitFillQty(symbol, { closedRecords = [], positions = [] } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const consumed = new Map();
  const add = (orderId, qty) => {
    if (!orderId) return;                       // no id -> can't exclude deterministically
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return;
    consumed.set(orderId, (consumed.get(orderId) || 0) + q);
  };
  for (const r of (closedRecords || [])) {
    if (!r || String(r.symbol || '').toUpperCase() !== sym) continue;
    for (const f of (Array.isArray(r.exit_fills) ? r.exit_fills : [])) add(f?.orderId, f?.qty);
    add(r.tp1_close_order_id, r.tp1_shares);
  }
  for (const p of (positions || [])) {
    if (!p || String(p.symbol || '').toUpperCase() !== sym) continue;
    add(p.tp1_close_order_id, p.tp1_shares);
  }
  return consumed;
}

// ── External close recorder (FIX tasks #25 + #26, 2026-06-05) ────────────────
// When syncPositions detects that Alpaca closed shares we didn't fire ourselves
// (stop fills, OCO fills, manual broker-side closes), this records the close
// properly in: closed-positions-sid.json, trades-sid.csv, sid-account.json +
// Telegram alert. Queries Alpaca's filled orders to find the actual exit
// price; falls back to the position's stop level if order history is
// unavailable.
async function recordExternalClose({ pos, sharesClosed, alpacaClient, reasonKind, isFullClose }) {
  // ── Find the actual exit price from Alpaca's order history ─────────
  let exitPrice = null;
  let fillsUsed = [];
  let qtyPriced = 0;               // v2.4.3: shares actually priced from REAL, unconsumed fills
  const fillsSkipped = [];         // v2.4.3: fills excluded because a prior close already booked them
  // v2.4.3: closed records are needed BOTH for the consumed-fill ledger below and
  // for the append further down — load once and reuse (single read, single truth).
  const closed = loadClosedPositions();
  const consumedFills = consumedExitFillQty(pos.symbol, {
    closedRecords: closed,
    positions:     [pos],
  });
  try {
    const oppositeSide = pos.side === 'long' ? 'sell' : 'buy';
    const afterIso = pos.openDate ? `${pos.openDate}T00:00:00Z` : undefined;
    const orders = await alpacaClient.listOrders({
      symbols: pos.symbol,
      status:  'closed', // includes filled + canceled
      after:   afterIso,
      limit:   100,
    });
    const fills = (orders || []).filter(o =>
      o &&
      String(o.side || '').toLowerCase() === oppositeSide &&
      String(o.status || '').toLowerCase() === 'filled' &&
      parseFloat(o.filled_qty || 0) > 0
    );
    if (fills.length > 0) {
      // For a PARTIAL external close, use the most recent fill closest to
      // sharesClosed. For a FULL close, weighted-average across all fills
      // up to sharesClosed.
      let qtyCounted = 0;
      let costCounted = 0;
      const sortedFills = fills.sort((a, b) => new Date(b.filled_at || b.updated_at || b.created_at) - new Date(a.filled_at || a.updated_at || a.created_at));
      for (const f of sortedFills) {
        if (qtyCounted >= sharesClosed - 1e-9) break;
        const q = parseFloat(f.filled_qty);
        const p = parseFloat(f.filled_avg_price);
        if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p <= 0) continue;
        // v2.4.3 DOUBLE-COUNT GUARD: an earlier close on this symbol may already
        // have booked part (or all) of this broker order. Only the REMAINDER is
        // available — never re-price shares that are already in the books.
        const alreadyBooked = consumedFills.get(f.id) || 0;
        const available     = q - alreadyBooked;
        if (available <= 1e-9) {
          fillsSkipped.push({ orderId: f.id, qty: q, alreadyBooked, reason: 'already booked by an earlier close' });
          continue;
        }
        const take = Math.min(available, sharesClosed - qtyCounted);
        qtyCounted += take;
        costCounted += take * p;
        fillsUsed.push({
          orderId: f.id,
          filledAt: f.filled_at || f.updated_at,
          qty: take,
          price: parseFloat(p.toFixed(4)),
        });
      }
      if (qtyCounted > 0) exitPrice = costCounted / qtyCounted;
      qtyPriced = qtyCounted;
    }
  } catch (err) {
    console.warn(`[recordExternalClose] Failed to query Alpaca orders for ${pos.symbol} exit price: ${err.message}`);
  }

  // pnl_source: 'alpaca_fill' when we read real fills off Alpaca (the normal
  // case here — this path exists precisely because Alpaca closed the position);
  // 'estimate' only on the stopLoss fallback when no fills were returned.
  let pnlSource = fillsUsed.length > 0 ? 'alpaca_fill' : 'estimate';

  // v2.4.3 HONESTY GUARD: with the double-count guard in place, the unconsumed
  // fills can legitimately cover FEWER shares than this close (e.g. Alpaca's
  // order window didn't return one leg). The weighted average of what we DID
  // find is still the best available price, but extrapolating it across shares
  // we never saw a fill for is an ESTIMATE — label it as one rather than
  // presenting it as a full-coverage real fill. Never silently wrong.
  const fillShortfall = parseFloat((sharesClosed - qtyPriced).toFixed(4));
  if (fillsUsed.length > 0 && fillShortfall > 1e-9) {
    pnlSource = 'estimate';
    console.warn(
      `[recordExternalClose] ${pos.symbol}: real (unconsumed) fills cover only ` +
      `${qtyPriced}/${sharesClosed} sh` +
      (fillsSkipped.length ? ` (${fillsSkipped.length} order(s) skipped — already booked by an earlier close)` : '') +
      ` — pricing the remainder at the found average $${(exitPrice ?? 0).toFixed(4)} and flagging pnl_source:"estimate".`
    );
  }

  // Fallback: use the bot's tracked stop level. For Alpaca-side stops set at
  // bot's stopLoss, this is usually within a few cents of actual fill.
  if (exitPrice === null || !Number.isFinite(exitPrice)) {
    exitPrice = pos.stopLoss;
    pnlSource = 'estimate';
    console.warn(`[recordExternalClose] No Alpaca fills found for ${pos.symbol} — using stopLoss $${exitPrice} as approximation`);
  }

  // ── Compute realised P&L ───────────────────────────────────────────
  const entry = pos.entry;
  const pnlRounded = realisedPnlFor(pos.side, entry, exitPrice, sharesClosed);
  const pnl = pnlRounded;
  const exitPriceRounded = parseFloat(exitPrice.toFixed(4));

  // ── v2.5.0 FIX: carry the bot-booked TP1 leg into total_pnl ─────────────────
  // `exit_pnl` is THIS leg. `total_pnl` is THE TRADE — and the ledger sums
  // total_pnl. Before v2.5.0 a full external close set total_pnl to the closed
  // leg ALONE, while deriveLedger only counts an open position's tp1_pnl WHILE
  // IT IS OPEN. So the instant the runner closed, a TP1 half banked by Branch A
  // silently dropped out of the books:
  //   IBM  TP1 2sh @ 237.51 = +$40.76 LOST -> trade booked +$42.52, truth +$82.88
  //   HON  TP1 2sh @ 214.73 = +$20.58 LOST -> trade booked  -$0.09, truth +$19.83
  // (The bot's OWN TP2 path never had this bug — it already does tp1_pnl + tp2Pnl.)
  //
  // MUST NOT double-count the PYPL pattern, where the TP1 leg was itself written
  // as a separate closed PARTIAL record (`is_full_close:false`, same id) — that
  // record already carries it. tp1LegAlreadyInClosedRecords is the shared guard
  // (the same one deriveLedger uses for the mirror case).
  const tp1LegPnl       = Number(pos.tp1_pnl) || 0;
  const tp1AlreadyBooked = tp1LegAlreadyInClosedRecords(pos, closed);
  const includeTp1Leg   = Boolean(isFullClose && pos.tp1_hit && tp1LegPnl !== 0 && !tp1AlreadyBooked);
  const tradeTotalPnl   = includeTp1Leg
    ? parseFloat((tp1LegPnl + pnlRounded).toFixed(2))
    : pnlRounded;
  if (includeTp1Leg) {
    console.log(
      `    [v2.5.0] ${pos.symbol}: carrying the bot-booked TP1 leg into the trade total — ` +
      `TP1 ${tp1LegPnl >= 0 ? '+' : ''}$${tp1LegPnl.toFixed(2)} + this close ` +
      `${pnlRounded >= 0 ? '+' : ''}$${pnlRounded.toFixed(2)} = ${tradeTotalPnl >= 0 ? '+' : ''}$${tradeTotalPnl.toFixed(2)}`
    );
  }
  // Combined provenance: 'alpaca_fill' only when BOTH legs were real fills —
  // identical rule to the TP2 branch's combinedSource.
  if (includeTp1Leg) {
    const tp1Src = pos.tp1_pnl_source || 'estimate';
    if (!(tp1Src === 'alpaca_fill' && pnlSource === 'alpaca_fill')) pnlSource = 'estimate';
  }

  // ── Append to closed-positions-sid.json ─────────────────────────────
  // (`closed` was loaded at the top of this function — it also feeds the
  //  v2.4.3 consumed-fill ledger, so it is deliberately read only once.)
  const closedRec = {
    ...pos,
    closeDate: todayString(),
    closeTime: new Date().toISOString().slice(11, 19),
    exit_strategy: reasonKind,
    exit_price:    exitPriceRounded,
    exit_pnl:      pnlRounded,
    exit_shares:   sharesClosed,
    // v2.4.3: `exit_fills` is the DETERMINISTIC exclusion key a later close on
    // this symbol uses to avoid re-booking these same shares. Keep stamping it.
    exit_fills:    fillsUsed,
    exit_fill_qty:       parseFloat(qtyPriced.toFixed(4)),
    exit_fill_shortfall: fillShortfall > 1e-9 ? fillShortfall : 0,
    ...(fillsSkipped.length ? { exit_fills_skipped: fillsSkipped } : {}),
    // v2.5.0: total_pnl is THE TRADE (this leg + any bot-booked TP1 leg not
    // already carried by a closed partial record); exit_pnl stays THIS leg.
    total_pnl:     tradeTotalPnl,
    realizedPnl:   tradeTotalPnl,
    ...(includeTp1Leg ? { tp1_pnl_included: true } : {}),
    ...(isFullClose && pos.tp1_hit && tp1AlreadyBooked
      ? { tp1_pnl_included: false, tp1_leg_in_prior_record: true }
      : {}),
    is_full_close: isFullClose,
    pnl_source:    pnlSource,
    mode:          pos.mode || CONFIG.tradingMode,
  };
  closed.push(closedRec);
  saveClosedPositions(closed);

  // ── Append row to trades-sid.csv ────────────────────────────────────
  const totalUsd = (sharesClosed * entry).toFixed(2);
  const riskPct  = ((pnl / (sharesClosed * entry)) * 100).toFixed(2);
  appendTrade([
    todayString(),
    new Date().toISOString().slice(11, 19),
    'Alpaca/' + (pos.mode || 'paper'),
    pos.symbol,
    `${pos.side}-extclose`,
    sharesClosed,
    entry.toFixed(2),
    pos.stopLoss != null ? pos.stopLoss.toFixed(2) : '',
    totalUsd,
    pnlRounded,
    riskPct,
    pos.signalDate || '',
    `EXT-${pos.symbol}-${Date.now()}`,
    pos.mode || 'paper',
    pos.strategy || 'SID v2.1',
  ].join(','));

  // ── Update account state ────────────────────────────────────────────
  // Re-derive from records (closed file was just saved above). Exclude the
  // just-closed position from the open set — the caller saves the trimmed
  // open-positions file only AFTER this returns, so reading it from disk would
  // still contain this position and double-count its in-flight TP1 leg.
  const openMinusClosed = loadOpenPositions().filter(p => p.id !== pos.id);
  updateAccount(null, { open: openMinusClosed });

  // ── Telegram alert ──────────────────────────────────────────────────
  // v2.5.0: headline the TRADE total, not just this leg — a HON-style close is a
  // small negative on the runner leg but a WIN on the trade (+$19.83).
  const pnlEmoji = tradeTotalPnl >= 0 ? '📈' : '📉';
  const sign = pnlRounded >= 0 ? '+' : '';
  try {
    await tg.sendMessage(
      `${pnlEmoji} <b>SID external close detected</b>\n\n` +
      `${pos.symbol} ${pos.side.toUpperCase()} ${sharesClosed}sh ${isFullClose ? '(FULL)' : '(PARTIAL)'}\n` +
      `Entry: $${entry.toFixed(2)}  Exit: $${exitPriceRounded.toFixed(2)}\n` +
      `Realized P&amp;L: <b>${sign}$${pnlRounded.toFixed(2)}</b>\n` +
      (includeTp1Leg
        ? `TP1 leg: ${tp1LegPnl >= 0 ? '+' : ''}$${tp1LegPnl.toFixed(2)}\n` +
          `<b>Trade total: ${tradeTotalPnl >= 0 ? '+' : ''}$${tradeTotalPnl.toFixed(2)}</b>\n`
        : '') +
      `Reason: ${reasonKind}\n\n` +
      `Trade journal + account auto-updated. Position freed for new entries.`
    );
  } catch (e) {
    console.warn(`[recordExternalClose] Telegram alert failed: ${e.message}`);
  }

  writeLog({
    kind:        'external_close_recorded',
    symbol:      pos.symbol,
    sharesClosed,
    exitPrice:   exitPriceRounded,
    pnl:         pnlRounded,
    totalPnl:    tradeTotalPnl,     // v2.5.0 — incl. any carried TP1 leg
    tp1LegPnl,
    includeTp1Leg,
    tp1AlreadyBooked,
    reason:      reasonKind,
    isFullClose,
    fillsUsed,
    pnlSource,
    fillsSkipped,          // v2.4.3 — visibility into the double-count guard
    fillShortfall,
  });
}

// ── V2.2: Broker order maintenance ─────────────────────────────────────────────
// Helpers that keep the broker-side resting stop + intraday TP1 limit in sync
// with what the bot expects. Run each bot cycle for every v2.2 position.

const V2_2_PRICE_DRIFT_TOLERANCE = 0.05;   // dollar threshold for "materially different" TP1 limit price
const V2_2_TP1_RECOMPUTE_RSI     = 50;

/** Is this position managed by V2.2 broker-side orders? */
function isV2_2Position(pos) {
  // V2.4.0 PDT-SAFE: a pdt_safe position has NO broker orders by design — it must
  // ALWAYS be managed by the daily-poll (TP1/TP2/stop on a later day = PDT-immune),
  // NEVER the broker-order path. Return false unconditionally, even if some future
  // code accidentally stamped a brokerStopOrderId on it. This is the hard guarantee
  // that maintainV2_2BrokerOrders is never called for a pdt_safe position.
  if (pos.pdt_safe === true) return false;
  // Either explicitly tagged v2.2 OR has a brokerStopOrderId stamped at entry.
  // V2.1 GOOG runner (pre-migration) has neither → returns false → keeps legacy
  // daily-poll management.
  return (typeof pos.strategy === 'string' && pos.strategy.includes('v2.2'))
      || !!pos.brokerStopOrderId;
}

/** Find an open Alpaca order by client_order_id suffix (e.g. "-tp1" or "-stop"). */
async function findOpenOrder(alpacaClient, symbol, clientOrderIdSuffix) {
  // v2.4.2 FIX — match the suffix at end-of-id OR immediately before a trailing
  // `-<digits>`. placeStop()/maintainV2_2BrokerOrders() label RE-PLACED orders
  // `${prefix}-stop-${Date.now()}` / `${prefix}-tp1-${Date.now()}`, so the old
  // `endsWith('-stop')` / `endsWith('-tp1')` MISSED every re-placed order (they end
  // in digits) — the exact twin of the v2.2.6 closePosition `-stop` bug. That miss
  // is why maintain lost track of its own reduced stop, fell into the placement
  // branch, and hit `insufficient qty available: 0` on the v2.2 short. Now
  // `-stop(-\d+)?$` matches both the bare entry stop AND the timestamped re-places.
  // NOTE: `-restop-<ts>` (the re-protect tag) is deliberately NOT matched here — it
  // is cancelled directly via the tracked pos.brokerStopOrderId in the callers.
  const escaped = clientOrderIdSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}(-\\d+)?$`);
  try {
    const orders = await alpacaClient.listOrders({ status: 'open', symbols: symbol, limit: 50 });
    return (orders || []).find(o =>
      o && typeof o.client_order_id === 'string' &&
      re.test(o.client_order_id)
    );
  } catch (err) {
    console.warn(`[V2.2] findOpenOrder failed for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * V2.2 — Maintain the broker-side resting stop and intraday TP1 limit for a
 * single open position. Called from checkPositions once per run per v2.2 position.
 *
 * Semantics:
 *   - Stop side: opposite of the entry. Stop price = pos.entry if tp1_hit (BE
 *     on the runner) else pos.stopLoss.
 *   - TP1 limit: only placed while tp1_hit === false. Price is recomputed each
 *     run via rsiTargetPrice(closes, 14, 50) — the level the next bar's close
 *     would have to print for RSI to equal 50. If the existing -tp1 order's
 *     limit_price drifts more than V2_2_PRICE_DRIFT_TOLERANCE from the new
 *     target, cancel and resubmit.
 *
 * Idempotent — safe to call every run.
 */
async function maintainV2_2BrokerOrders(pos, executor, closes) {
  if (!executor || !pos.clientOrderIdPrefix) {
    // Either dry_run or missing prefix (legacy position). Skip.
    return;
  }
  const client = executor.client;
  const exitSide = pos.side === 'long' ? 'sell' : 'buy';
  const prefix = pos.clientOrderIdPrefix;

  // ── Resting stop ────────────────────────────────────────────────────────
  const expectedStopPrice = pos.tp1_hit ? parseFloat(pos.entry.toFixed(2)) : pos.stopLoss;
  const existingStop = await findOpenOrder(client, pos.symbol, '-stop');
  // ── SHORT held-shares fix (v2.2.5) ──────────────────────────────────────
  // For a v2.2 SHORT the TP1 exit is a resting GTC limit placed further down.
  // If the resting stop reserves the FULL position, Alpaca "holds" every share
  // against it and the subsequent TP1 limit submit fails with `insufficient qty
  // available` (silently — only a console.warn). This is the short-side twin of
  // the PYPL long TP1 bug. FIX: while TP1 is still pending on a SHORT, the stop
  // reserves only the RUNNER half (shares_total - tp1Qty), leaving the TP1 half
  // free for the resting limit. Once tp1_hit, the stop reverts to the runner
  // (shares_remaining) at BE — unchanged. LONGS are unaffected (they carry no
  // resting TP1 limit — long TP1 is the cancel-first daily-poll close), so a
  // long keeps a full-size stop until its close cancels it.
  let stopShares = pos.shares_remaining ?? pos.shares;
  if (pos.side === 'short' && !pos.tp1_hit) {
    const pendingTp1Qty = Math.floor((pos.shares_total ?? pos.shares) * CONFIG.tp1Portion);
    const runnerShares  = (pos.shares_total ?? pos.shares) - pendingTp1Qty;
    if (runnerShares >= 1) stopShares = runnerShares;
  }

  // ── (Re)establish the resting stop at the correct size/price ──────────────
  // v2.4.2 ROBUST RESET — fixes the "insufficient qty available: 0" trap that left
  // a v2.2 SHORT with a full-size entry stop holding ALL shares, so the runner stop
  // + TP1 OCO could never be placed → the short had NO working TP1 (Branch A skips
  // the daily-poll TP1 for v2.2 shorts). The OLD code cancelled `existingStop.id` (a
  // suffix scan that MISSED timestamped stops) then slept a fixed 800ms — under a
  // pending_cancel / closed-market race the re-submit hit `insufficient qty` and only
  // console.warn'd. NOW: cancel the TRACKED stop BY ID (robust to ANY client_order_id,
  // incl. -restop / timestamped), then the suffix-found stop, then — for a pre-TP1
  // SHORT — any resting TP1 OCO, then WAIT for Alpaca to actually release the shares
  // (waitForNoOpenOrders, not a blind sleep), THEN place the correctly-sized stop.
  // The TP1 OCO (short) is re-placed in the section below once its shares are free.
  const existingStopPrice = existingStop ? parseFloat(existingStop.stop_price) : null;
  const existingStopQty   = existingStop ? parseInt(existingStop.qty, 10)      : null;
  const stopPriceOk = existingStop && Math.abs(existingStopPrice - expectedStopPrice) <= V2_2_PRICE_DRIFT_TOLERANCE;
  const stopQtyOk   = existingStop && existingStopQty === stopShares;

  if (!existingStop || !stopPriceOk || !stopQtyOk) {
    if (existingStop) {
      console.log(`  [V2.2] Resetting stop for ${pos.symbol}: ${existingStopQty}sh @ $${existingStopPrice} → ${stopShares}sh @ $${expectedStopPrice}`);
    }
    try {
      // (1) Free the shares reliably before placing the correctly-sized stop.
      if (pos.brokerStopOrderId) await executor.cancelOrderById(pos.brokerStopOrderId);
      if (existingStop && existingStop.id !== pos.brokerStopOrderId) await executor.cancelOrderById(existingStop.id);
      if (pos.side === 'short' && !pos.tp1_hit) {
        // Cancel any resting TP1 OCO too so waitForNoOpenOrders can reach zero; the
        // OCO is re-placed below with all its shares free.
        const restingTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
        if (restingTp1) await executor.cancelOrderById(restingTp1.id);
      }
      // v2.4.2 SWEEP — also cancel any MANUAL/external order on this symbol (e.g. a
      // break-even stop the user placed via the Alpaca UI: Alpaca-generated
      // client_order_id, no SID tag → invisible to the tracked-id + suffix cancels
      // above). Left uncancelled it holds the shares and hangs waitForNoOpenOrders →
      // `insufficient qty available: 0`. Symbol-scoped only (never other symbols).
      await executor.cancelAllOpenOrders(pos.symbol);
      await executor.waitForNoOpenOrders(pos.symbol);
      // (2) Place the correctly-sized stop (runner-only for a pre-TP1 short).
      const stopOrder = await client.submitOrder({
        symbol:          pos.symbol,
        qty:             stopShares,
        side:            exitSide,
        type:            'stop',
        stop_price:      expectedStopPrice,
        time_in_force:   'gtc',
        client_order_id: `${prefix}-stop-${Date.now()}`,
      });
      pos.brokerStopOrderId = stopOrder.id;
      console.log(`  [V2.2] Placed stop for ${pos.symbol}: ${stopShares}sh @ $${expectedStopPrice} (id ${stopOrder.id})`);
    } catch (err) {
      console.warn(`  [V2.2] Stop (re)placement failed for ${pos.symbol}: ${err.message}`);
    }
  }

  // ── V2.2.1 HYBRID: resting TP1 limit is SHORT-only ─────────────────────
  // Per-side backtest decomposition: shorts strictly benefit from intraday-touch
  // TP1 (higher WR AND PnL), but longs gave up $2.3k of PnL on the v2.2 model
  // because the bullish equity drift books a bigger TP1 partial when price
  // closes past 50 than when it locks exactly at 50 intraday. So longs revert
  // to v2.1 close-based TP1 (handled in checkPositions Branch A daily-poll):
  if (pos.side === 'long') {
    // Belt-and-braces: cancel any stale TP1 limit from v2.2-era state
    const staleTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
    if (staleTp1) {
      console.log(`  [V2.2.1] Cancelling stale -tp1 limit for ${pos.symbol} (long uses v2.1 close-based TP1)`);
      try { await client.cancelOrder(staleTp1.id); } catch (_) {}
    }
    return;
  }

  // ── Resting TP1 limit (SHORT only, while tp1_hit === false) ──────────────
  if (pos.tp1_hit) {
    // Belt-and-braces: kill any stale TP1 order if somehow still active
    const staleTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
    if (staleTp1) {
      console.log(`  [V2.2] Cancelling stale -tp1 order for ${pos.symbol} (tp1_hit=true)`);
      try { await client.cancelOrder(staleTp1.id); } catch (_) {}
    }
    return;
  }

  // Compute the RSI-50 target price for the next bar
  const tp1Target = rsiTargetPrice(closes, 14, V2_2_TP1_RECOMPUTE_RSI);
  if (!Number.isFinite(tp1Target) || tp1Target <= 0) {
    console.warn(`  [V2.2] rsiTargetPrice returned ${tp1Target} for ${pos.symbol} — TP1 limit not placed this run`);
    return;
  }

  const tp1Qty = Math.floor(pos.shares_total * CONFIG.tp1Portion);
  if (tp1Qty < 1) {
    console.warn(`  [V2.2] ${pos.symbol} share count too small to split — no TP1 limit placed`);
    return;
  }

  // v2.2.5: the SHORT TP1 half is placed as an OCO (limit TP1 + stop SL) so it is
  // ALSO stop-protected. Previously the TP1 was a bare limit while the resting
  // -stop reserved the full position — the two couldn't coexist (one always
  // failed with `insufficient qty`). Now the runner-only -stop (above) protects
  // the runner half, and this OCO protects the TP1 half on BOTH legs: the TP1
  // limit books profit at the RSI-50 target, its bundled stop covers the adverse
  // case. Only one OCO leg fires; the other auto-cancels. Mirrors the documented
  // manual-trade.js OCO pattern (SID/CLAUDE.md § "insufficient qty" OCO write-up).
  const tp1StopPrice = parseFloat(Number(pos.stopLoss).toFixed(2));
  const submitTp1Oco = async () => client.submitOrder({
    symbol:          pos.symbol,
    qty:             tp1Qty,
    side:            exitSide,
    type:            'limit',
    limit_price:     tp1Target,
    time_in_force:   'gtc',
    order_class:     'oco',
    take_profit:     { limit_price: tp1Target },
    stop_loss:       { stop_price:  tp1StopPrice },
    client_order_id: `${prefix}-tp1-${Date.now()}`,
  });

  const existingTp1 = await findOpenOrder(client, pos.symbol, '-tp1');
  if (!existingTp1) {
    try {
      const tp1Order = await submitTp1Oco();
      console.log(`  [V2.2] Placed TP1 OCO for ${pos.symbol}: ${tp1Qty}sh limit $${tp1Target} / stop $${tp1StopPrice} (id ${tp1Order.id})`);
    } catch (err) {
      console.warn(`  [V2.2] TP1 OCO placement failed for ${pos.symbol}: ${err.message}`);
    }
  } else {
    const existingTp1Price = parseFloat(existingTp1.limit_price);
    if (Math.abs(existingTp1Price - tp1Target) > V2_2_PRICE_DRIFT_TOLERANCE) {
      console.log(`  [V2.2] TP1 limit drift on ${pos.symbol}: was $${existingTp1Price} → now $${tp1Target} (re-pricing)`);
      try {
        await client.cancelOrder(existingTp1.id);
        await new Promise(r => setTimeout(r, 800));
        await submitTp1Oco();
      } catch (err) {
        console.warn(`  [V2.2] TP1 OCO refresh failed for ${pos.symbol}: ${err.message}`);
      }
    } else {
      // Already at the right price — leave it
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// V2.6.0 — QUEUE-FOR-OPEN EXITS
// ═════════════════════════════════════════════════════════════════════════════
//
// THE LIVE FAILURE THIS PREVENTS (2026-09-09, IBM runner). TP2 (SMA50 touch)
// ripened in the last ~35 minutes of the session. The next bot run landed at
// 21:06 UTC, an hour after the close. It correctly swept the resting stop, then
// hit `Market closed — refusing to submit close for IBM` (alpaca-executor.js
// :520), re-protected the runner and gave up until the next run. Alan then did
// it by hand: cancel the stop, queue a market sell, filled at the next open
// (2 @ $238.39). With GHA crons landing ~3h late, an exit that ripens late in
// the session can slip for DAYS. Note carefully: ON-TIME crons would ALSO have
// missed this, because the touch came after the last in-hours run — which is why
// queue-for-open and the Railway runner are both needed.
//
// WHAT CHANGES: when an exit triggers and the market is CLOSED, instead of
// refusing, the bot (1) sweeps every resting order on the symbol, (2) submits the
// exit as a market order the BROKER executes at the next open, and (3) records a
// `pending_exit` block on the position. Every later run reconciles that block
// BEFORE anything else. ENTRIES ARE UNTOUCHED — a stale entry signal must be
// re-evaluated against a fresh bar, never queued.
//
// ⚠ THE ONE REAL TRADE-OFF, STATED PLAINLY: between the sweep and the open the
// position has NO resting stop, because a stop HOLDS the shares and would block
// the queued exit (`insufficient qty available: 0` — the v2.2.5/v2.2.6/v2.4.2
// held-shares family of bugs). The exposure is the overnight gap on a position we
// are exiting anyway, and a market-on-open fill is equivalent-or-better than a
// stop triggering at that same open. The window only ever exists while the market
// is CLOSED, so there is no intraday price action to be unprotected against.
//
// WHAT ALPACA ACTUALLY DOES WITH AN OVERNIGHT QUEUED EXIT (verified 2026-10-24
// against https://docs.alpaca.markets/docs/orders-at-alpaca):
//   • tif 'opg' — "eligible to execute only in the market opening auction ...
//     OPG orders submitted after 9:28am but before 7:00pm ET will be REJECTED.
//     OPG orders submitted after 7:00pm will be queued and routed to the
//     following day's opening auction."
//   • tif 'day' — "If submitted after the close, it is queued and submitted the
//     following trading day", and "Orders not eligible for extended hours
//     submitted after 4:00pm ET will be queued up for release the next trading
//     day."
//   So OPG has a DEAD ZONE of 09:28–19:00 ET, and 21:06 UTC — the exact IBM
//   failure — is 17:06 ET, squarely inside it. `executor.queuedExitTif()` picks
//   OPG where Alpaca accepts it and `day` in the dead zone; both execute at the
//   next open. A Friday-evening queue lands at MONDAY's open (OPG routes to "the
//   following day's opening auction", `day` to "the next trading day").
//   If a submission is rejected anyway we fall back to EXACTLY today's behaviour
//   (re-protect with a stop, alert, retry next run) and alternate the tif.
//
// SINGLE-FIRE GUARANTEE — two independent layers:
//   (local)  `pos.pending_exit` makes checkPositions SKIP the position entirely,
//            so no second order can ever be queued while one is pending.
//   (broker) every queued exit carries a DETERMINISTIC client_order_id
//            (`SID-<SYM>-<tag>-<YYYYMMDD>`), so a concurrent second submission —
//            the Railway cron and a GHA cron overlapping — is rejected BY ALPACA
//            as a duplicate rather than double-selling. Local state can be stale;
//            the broker id cannot.

// Short, stable tags for the client_order_id. Deliberately 3 chars so the whole
// id stays far inside Alpaca's client_order_id limit.
const EXIT_TAG = {
  tp1_rsi50:          'tp1',
  tp2_sma50_touch:    'tp2',
  tp2_sma200_touch:   'tp2',
  tp2_breakeven_stop: 'tp2',
  tp2_timeout:        'tp2',
  stop:               'stp',
  v20_rsi50:          'r50',
};

function exitTagFor(reason) {
  return EXIT_TAG[reason] || 'xit';
}

/**
 * The DETERMINISTIC broker idempotency key for a queued exit.
 *
 * Deterministic in (symbol, exit kind, calendar date, attempt) and NOTHING else —
 * no timestamp, no PID, no random — so two processes that both decide to queue
 * the same exit compute the SAME id and Alpaca rejects the second as a duplicate.
 * That is the only double-sell guard that survives stale local state.
 *
 * Why the date is in it: it lets ONE legitimate re-queue per calendar day (e.g.
 * yesterday's queued order was cancelled by the exchange) while blocking a
 * same-day duplicate. Why `attempt` is in it: a REJECTED order still consumes its
 * client_order_id at Alpaca, so a retry needs a fresh one — and because the
 * attempt counter lives in COMMITTED state, both processes still compute the same
 * id on the same attempt.
 */
function exitClientOrderId(symbol, tag, yyyymmdd, attempt = 1) {
  const base = `SID-${String(symbol || '').toUpperCase()}-${tag}-${yyyymmdd}`;
  const n = Number(attempt) || 1;
  return (n > 1 ? `${base}-a${n}` : base).slice(0, 48);
}

/** Is the broker's market open right now? Reads the preflight clock, never a local clock. */
function marketIsOpen(executor) {
  return executor?.clock?.is_open === true;
}

/** Should this exit be queued for the open instead of refused? */
function shouldQueueExitForOpen(executor) {
  return !!executor && CONFIG.queueExitsForOpen && !marketIsOpen(executor);
}

/**
 * Sweep the symbol, submit the exit for the next open, and stamp `pending_exit`.
 *
 * MUTATES `pos` (pending_exit / brokerStopOrderId / exit_queue_attempts). The
 * CALLER persists it — every call site pushes `pos` back into `stillOpen` so the
 * usual saveOpenPositions() at the end of checkPositions writes it.
 *
 * @returns {{ queued: boolean, pendingExit?: Object, error?: string, reprotected?: boolean }}
 */
async function queueExitForOpen({ pos, executor, qty, isFullClose, reason, booking = {} }) {
  const attempt  = (Number(pos.exit_queue_attempts) || 0) + 1;
  const tag      = exitTagFor(reason);
  const dateStr  = todayString().replace(/-/g, '');
  const clientId = exitClientOrderId(pos.symbol, tag, dateStr, attempt);
  const tif      = executor.queuedExitTif(attempt);
  pos.exit_queue_attempts = attempt;

  // ── (1) SWEEP FIRST — a resting order HOLDS the shares ────────────────────
  // Same cancel-first ordering as the v2.2.5 TP1 / v2.2.6 TP2 close paths, incl.
  // the v2.4.2 symbol-scoped sweep that also catches a MANUAL stop placed via the
  // Alpaca UI (no SID client_order_id → invisible to the targeted cancels, and it
  // would hang waitForNoOpenOrders). Alan's standing requirement, and the shares
  // cannot be freed otherwise.
  try {
    if (pos.brokerStopOrderId) await executor.cancelOrderById(pos.brokerStopOrderId);
    const lingeringStop = await findOpenOrder(executor.client, pos.symbol, '-stop');
    if (lingeringStop) await executor.cancelOrderById(lingeringStop.id);
    await executor.cancelAllOpenOrders(pos.symbol);
    await executor.waitForNoOpenOrders(pos.symbol);
    pos.brokerStopOrderId = null;   // swept — do not keep a dead id on the record
  } catch (err) {
    console.log(`\n    ⚠ Could not fully sweep resting orders on ${pos.symbol} before queueing the exit: ${err.message} — attempting the queue anyway`);
  }

  // ── (2) SUBMIT the queued exit ────────────────────────────────────────────
  try {
    const res = await executor.queueExitAtOpen({
      localPos: pos, qty, reason, clientOrderId: clientId, timeInForce: tif,
    });
    const pendingExit = {
      order_id:        res.orderId,
      client_order_id: res.clientOrderId,
      time_in_force:   res.timeInForce,
      status:          'queued',
      reason,                                   // tp1_rsi50 | tp2_sma50_touch | stop | ...
      kind:            isFullClose ? 'full' : 'partial',
      shares:          qty,
      queued_at:       new Date().toISOString(),
      queued_for:      'next_market_open',
      attempt,
      broker_status:   res.status || null,
      mode:            pos.mode || CONFIG.tradingMode,
      bot_version:     BOT_VERSION,
      booking,                                  // everything the reconcile needs to book it
    };
    pos.pending_exit = pendingExit;
    writeLog({
      kind: 'exit_queued_for_open', symbol: pos.symbol, side: pos.side,
      reason, shares: qty, order_id: res.orderId, client_order_id: res.clientOrderId,
      time_in_force: res.timeInForce, attempt,
    });
    tg.alertExitQueuedForOpen({
      symbol: pos.symbol, side: pos.side, shares: qty, reason,
      timeInForce: res.timeInForce, orderId: res.orderId,
      mode: pos.mode || CONFIG.tradingMode,
    }).catch(() => {});
    console.log(`⏭  EXIT QUEUED FOR THE OPEN — ${reason} (${qty} sh, tif ${tif}, order ${res.orderId}). No resting stop until it fills (documented trade-off).`);
    return { queued: true, pendingExit };
  } catch (err) {
    // ── (3) Submission REJECTED — fall back to today's behaviour: re-protect,
    // alert, retry next run. NEVER leave the position both unprotected and
    // unqueued; that is the one genuinely dangerous state here.
    let reprotected = false;
    if (pos.pdt_safe) {
      // PDT-safe positions deliberately carry NO broker order (a resting stop
      // could fill the same day as entry = a day trade). Re-placing one here
      // would break the v2.4.0 PDT-immunity guarantee. The daily poll IS the
      // protection for these.
      console.log(`\n    ⚠ ${pos.symbol} is PDT-safe — NOT placing a protective stop (would break PDT-immunity). The daily poll retries the queue next run.`);
    } else {
      try {
        const rp = await executor.placeStop(pos, pos.shares_remaining ?? pos.shares_total, pos.stopLoss, 'restop');
        pos.brokerStopOrderId = rp.stopOrderId;
        reprotected = true;
      } catch (rpErr) {
        console.log(`\n    🚨 RE-PROTECT FAILED for ${pos.symbol}: ${rpErr.message}`);
      }
    }
    console.log(`\n    🚫 Queue-for-open submission FAILED for ${pos.symbol} (${reason}, tif ${tif}): ${err.message} — ${reprotected ? 're-protected' : (pos.pdt_safe ? 'PDT-safe, no stop by design' : 'RE-PROTECT FAILED')}, will retry next run`);
    writeLog({
      kind: 'exit_queue_fail', symbol: pos.symbol, reason, shares: qty,
      time_in_force: tif, attempt, error: err.message, reprotected,
      client_order_id: clientId,
    });
    tg.alertExitQueueFailed({
      symbol: pos.symbol, side: pos.side, shares: qty, reason,
      timeInForce: tif, error: err.message, reprotected,
      pdtSafe: !!pos.pdt_safe, mode: pos.mode || CONFIG.tradingMode,
    }).catch(() => {});
    return { queued: false, error: err.message, reprotected };
  }
}

// Alpaca order states that mean "this queued exit is NEVER going to fill".
const PENDING_EXIT_DEAD_STATES = ['canceled', 'cancelled', 'rejected', 'expired', 'suspended', 'stopped'];

/**
 * Reconcile every `pending_exit` BEFORE anything else in the run.
 *
 * ⚠ ORDERING IS LOAD-BEARING: this MUST run before executor.syncPositions().
 * syncPositions compares Alpaca's position list to local state and routes any
 * difference through recordExternalClose — so if a queued exit filled overnight
 * and we let syncPositions see it first, the leg would be booked TWICE (once as
 * an "external" close, once here). Reconciling first leaves syncPositions looking
 * at consistent state: a filled partial has already had shares_remaining reduced,
 * and a filled full close has already been removed from open-positions.
 *
 * Branches, per the brief:
 *   filled                     → book it through the real-fill path (weighted from
 *                                the per-fill rows), clear pending_exit, and for a
 *                                TP1 partial restore the break-even stop.
 *   still open/accepted/new    → LEAVE IT ALONE. No re-sweep, no re-queue.
 *   cancelled/rejected/expired → clear pending_exit, IMMEDIATELY re-protect with a
 *                                stop, and raise the loud alarm. A dropped queued
 *                                exit with no stop is the dangerous state.
 */
async function reconcilePendingExits(executor) {
  const result = { checked: 0, filled: 0, stillOpen: 0, dead: 0 };
  if (!executor) return result;

  const openPositions = loadOpenPositions();
  if (!openPositions.some(p => p?.pending_exit?.order_id)) return result;

  const closedPositions = loadClosedPositions();
  const survivors = [];
  let mutated = false;

  console.log('\n── Reconciling queued (for-the-open) exits ──');

  for (let idx = 0; idx < openPositions.length; idx++) {
    const pos = openPositions[idx];
    const pe = pos?.pending_exit;
    if (!pe?.order_id) { survivors.push(pos); continue; }
    result.checked++;

    let order = null;
    let lookupFailed = false;
    try {
      order = await executor.client.getOrder(pe.order_id);
    } catch (err) {
      // A 404 means Alpaca has no such order — treat as dead (re-protect). Any
      // OTHER error (network, 5xx, auth) is NOT evidence about the order, so we
      // must leave it alone rather than re-protect against a live order (which
      // would double-hold the shares and block the fill).
      if (err.status === 404) {
        console.log(`  ▶ ${pos.symbol} queued ${pe.reason}: order ${pe.order_id} NOT FOUND at Alpaca (404) — treating as dropped`);
      } else {
        lookupFailed = true;
        console.log(`  ▶ ${pos.symbol} queued ${pe.reason}: could not read order ${pe.order_id} (${err.message}) — leaving the pending exit alone this run`);
      }
    }

    if (lookupFailed) { result.stillOpen++; survivors.push(pos); continue; }

    const status    = String(order?.status || '').toLowerCase();
    const filledQty = parseFloat(order?.filled_qty || 0);
    const isFilled  = status === 'filled' || (filledQty > 0 && status !== 'partially_filled');
    const isDead    = !order || PENDING_EXIT_DEAD_STATES.includes(status);

    // ── STILL PENDING — do nothing. ─────────────────────────────────────────
    if (!isFilled && !isDead) {
      console.log(`  ▶ ${pos.symbol} queued ${pe.reason}: still ${status || 'pending'} (${pe.shares} sh, tif ${pe.time_in_force}) — leaving it alone`);
      result.stillOpen++;
      survivors.push(pos);
      continue;
    }

    // ── DEAD (cancelled / rejected / expired / gone) ────────────────────────
    if (!isFilled) {
      result.dead++;
      delete pos.pending_exit;
      mutated = true;
      let reprotected = false;
      if (pos.pdt_safe) {
        console.log(`  ▶ ${pos.symbol} queued ${pe.reason}: ${status || 'gone'} — PDT-safe, no broker stop by design; the daily poll re-queues next run`);
      } else {
        try {
          const rp = await executor.placeStop(pos, pos.shares_remaining ?? pos.shares_total, pos.stopLoss, 'restop');
          pos.brokerStopOrderId = rp.stopOrderId;
          reprotected = true;
        } catch (rpErr) {
          console.log(`  🚨 RE-PROTECT FAILED for ${pos.symbol}: ${rpErr.message}`);
        }
      }
      console.log(`  🚨 ${pos.symbol} queued ${pe.reason} was ${status || 'dropped'} — ${reprotected ? 're-protected with a stop' : (pos.pdt_safe ? 'PDT-safe (daily poll protects)' : 'RE-PROTECT FAILED — CHECK ALPACA')}`);
      writeLog({
        kind: 'pending_exit_dropped', symbol: pos.symbol, reason: pe.reason,
        order_id: pe.order_id, broker_status: status || 'not_found',
        shares: pe.shares, reprotected, pdt_safe: !!pos.pdt_safe,
      });
      tg.alertPendingExitDropped({
        symbol: pos.symbol, side: pos.side, shares: pe.shares, reason: pe.reason,
        brokerStatus: status || 'not_found', reprotected, pdtSafe: !!pos.pdt_safe,
        mode: pos.mode || CONFIG.tradingMode,
      }).catch(() => {});
      survivors.push(pos);
      continue;
    }

    // ── FILLED — book it at the REAL weighted fill price ────────────────────
    result.filled++;
    mutated = true;
    // ⚠ The open set handed to the ledger must be EXACT, or a second booking in
    // the same loop double-counts the first position's TP1 leg (its full-close
    // record already carries that leg, and tp1LegAlreadyInClosedRecords returns
    // FALSE for a full-close record by design — a full record IS the trade
    // total). So: positions already processed and still open (`survivors`), this
    // position only if it stays open, plus everything not yet processed.
    const notYetProcessed = openPositions.slice(idx + 1);
    const keepOpen = await bookQueuedExitFill({
      pos, order, filledQty, executor, closedPositions,
      openPeers: [...survivors, ...notYetProcessed],
    });
    if (keepOpen) survivors.push(pos);
  }

  if (mutated) {
    saveOpenPositions(survivors);
    saveClosedPositions(closedPositions);
    // Belt-and-braces: the files on disk are now the truth, so re-derive the
    // ledger straight from them. Each booking above already stamped its own
    // accountAfter from an exact in-memory open set; this guarantees the
    // PERSISTED ledger is right even if that set were ever wrong.
    updateAccount(null);
  }
  console.log(`  ── queued exits: ${result.filled} filled, ${result.stillOpen} still pending, ${result.dead} dropped ──`);
  return result;
}

/**
 * Book a FILLED queued exit. Mirrors the booking shape of checkPositions Branch A
 * (partial / TP1) and Branch B (full / TP2) EXACTLY — same fields, same
 * realisedPnlFor(), same record-first-then-re-derive ledger ordering (the v2.4.1
 * gotcha), same 'alpaca_fill' provenance — so a queued exit and an in-hours exit
 * produce indistinguishable records.
 *
 * @returns {boolean} true if the position stays OPEN (a TP1 partial), false if it closed
 */
async function bookQueuedExitFill({ pos, order, filledQty, executor, closedPositions, openPeers }) {
  const pe      = pos.pending_exit || {};
  const booking = pe.booking || {};
  const shares  = filledQty > 0 ? filledQty : (pe.shares || 0);

  // ── UNDER-FILLED FULL EXIT — do NOT book, defer to the tested path ────────
  // A market-on-open order for N shares filling fewer than N is unlikely, but if
  // it happened and we booked a FULL close for the filled portion, the position
  // would leave our books while the BROKER still held the remainder — an orphan
  // nothing reconciles (syncPositions only reports positions ALPACA has lost, not
  // ones we have lost). So: book nothing here, clear pending_exit, re-protect the
  // remainder, and alarm. The next run's syncPositions sees a smaller Alpaca qty
  // and routes the filled portion through recordExternalClose — the existing,
  // tested partial-close path, which will find this very order's fills (we
  // consumed nothing, so they are still available to it).
  // A TP1 PARTIAL does not need this: it books `filledQty` and sets
  // shares_remaining accordingly, so local and broker stay in agreement.
  if (pe.kind === 'full' && filledQty > 0 && filledQty < (pe.shares || 0)) {
    delete pos.pending_exit;
    let reprotected = false;
    if (!pos.pdt_safe) {
      try {
        const remaining = Math.max(1, (pos.shares_remaining ?? pos.shares_total) - filledQty);
        const rp = await executor.placeStop(pos, remaining, pos.stopLoss, 'restop');
        pos.brokerStopOrderId = rp.stopOrderId;
        reprotected = true;
      } catch (rpErr) {
        console.log(`  🚨 RE-PROTECT FAILED for ${pos.symbol} after an under-filled queued exit: ${rpErr.message}`);
      }
    }
    console.log(`  🚨 ${pos.symbol} queued ${pe.reason} filled only ${filledQty}/${pe.shares} sh — NOT booking a full close. ${reprotected ? 'Re-protected the remainder' : (pos.pdt_safe ? 'PDT-safe, no stop by design' : 'RE-PROTECT FAILED')}; next run's Alpaca sync books the filled portion.`);
    writeLog({
      kind: 'pending_exit_partial_fill', symbol: pos.symbol, reason: pe.reason,
      order_id: pe.order_id, requested: pe.shares, filled: filledQty, reprotected,
    });
    tg.alertPendingExitDropped({
      symbol: pos.symbol, side: pos.side, shares: pe.shares, reason: pe.reason,
      brokerStatus: `partially filled ${filledQty}/${pe.shares}`, reprotected,
      pdtSafe: !!pos.pdt_safe, mode: pos.mode || CONFIG.tradingMode,
    }).catch(() => {});
    return true;   // stays open; the Alpaca sync reconciles the real qty
  }

  // v2.5.0 pitfall: never trust the order's ROUNDED filled_avg_price for a
  // multi-price order — weight it from the per-fill rows.
  const fp = await executor.weightedFillPrice(order);
  let exitPrice  = Number.isFinite(fp.price) && fp.price > 0 ? fp.price : null;
  let pnlSource  = 'alpaca_fill';
  if (exitPrice === null) {
    // Honesty guard: no real price means we must NOT present an estimate as a fill.
    exitPrice = booking.estimate_price ?? pos.entry;
    pnlSource = 'estimate';
    console.log(`  ⚠ ${pos.symbol}: queued exit filled but no fill price available — booking the ${booking.estimate_price != null ? 'trigger-bar estimate' : 'entry'} $${Number(exitPrice).toFixed(2)} flagged as an estimate`);
  }
  const exitFills = fp.fills && fp.fills.length ? fp.fills : null;
  const filledAt  = order?.filled_at || order?.updated_at || new Date().toISOString();
  const fillDate  = String(filledAt).slice(0, 10);

  delete pos.pending_exit;

  // ───────────────────────────── TP1 PARTIAL ─────────────────────────────────
  if (pe.kind === 'partial') {
    const tp1Pnl       = realisedPnlFor(pos.side, pos.entry, exitPrice, shares);
    const runnerShares = (pos.shares_total ?? pos.shares) - shares;
    const bePrice      = booking.be_price ?? parseFloat(pos.entry.toFixed(2));

    pos.tp1_hit            = true;
    pos.tp1_date           = booking.trigger_date || fillDate;
    pos.tp1_price          = exitPrice;
    pos.tp1_shares         = shares;
    pos.tp1_pnl            = tp1Pnl;
    pos.tp1_reason         = booking.tp1_reason || 'rsi50';
    pos.tp1_rsi            = booking.trigger_rsi ?? null;
    pos.tp1_pnl_source     = pnlSource;
    pos.tp1_close_order_id = pe.order_id;    // so a later close can't re-use this fill
    pos.tp1_queued_for_open = true;          // provenance: banked at the open, not in-session
    pos.shares_remaining   = runnerShares;
    pos.stopLoss           = bePrice;
    if (exitFills) pos.tp1_exit_fills = exitFills;

    // Re-derive the ledger from records + this in-flight TP1 leg (v2.4.1: the
    // on-disk files aren't saved yet, so pass the in-memory arrays).
    const acct = updateAccount(null, { closed: closedPositions, open: [...openPeers, pos] });

    appendTrade([
      pos.tp1_date,
      (new Date()).toISOString().slice(11, 19),
      'V2.1/TP1',
      pos.symbol,
      `${pos.side}-tp1`,
      shares,
      pos.entry.toFixed(2),
      pos.stopLoss,
      (shares * exitPrice).toFixed(2),
      tp1Pnl,
      ((tp1Pnl / acct.accountUsd) * 100).toFixed(2),
      pos.signalDate,
      `TP1-${pos.id}`,
      pos.mode || CONFIG.tradingMode,
      `${BOT_NAME} v2.1`,
    ].join(','));

    // Restore the break-even stop on the remainder (the sweep removed it).
    if (runnerShares > 0 && !pos.pdt_safe) {
      try {
        const rp = await executor.placeStop(pos, runnerShares, bePrice, 'stop');
        pos.brokerStopOrderId = rp.stopOrderId;
      } catch (rpErr) {
        console.log(`  🚨 BE stop placement FAILED for ${pos.symbol} runner: ${rpErr.message} — next run's broker-order maintenance re-places it`);
        writeLog({ kind: 'be_stop_place_fail', symbol: pos.symbol, error: rpErr.message, via: 'queued_tp1' });
        tg.alertTp1CloseFailed({
          symbol: pos.symbol, side: pos.side, tp1Shares: shares, sharesTotal: pos.shares_total,
          error: `Queued TP1 banked at the open but the BE stop failed: ${rpErr.message}`,
          reprotected: false, mode: pos.mode || CONFIG.tradingMode,
        }).catch(() => {});
      }
    }

    tg.alertExitFired({
      symbol: pos.symbol, side: pos.side, exitPrice,
      exitReason: 'tp1_rsi50_at_open', realizedPnl: tp1Pnl,
      accountAfter: acct.accountUsd, mode: pos.mode || CONFIG.tradingMode,
    }).catch(() => {});

    console.log(`  ✓ ${pos.symbol} QUEUED TP1 FILLED AT THE OPEN — ${shares} sh @ $${exitPrice.toFixed(4)} (${pnlSource}), P&L ${tp1Pnl >= 0 ? '+' : ''}$${tp1Pnl}, runner ${runnerShares} sh, stop -> $${bePrice}`);
    writeLog({
      kind: 'pending_exit_filled', symbol: pos.symbol, reason: pe.reason, kindOfExit: 'partial',
      shares, exitPrice, pnl: tp1Pnl, pnl_source: pnlSource, price_source: fp.source,
      order_id: pe.order_id,
    });
    return true;   // stays open as the runner
  }

  // ───────────────────────────── FULL CLOSE ──────────────────────────────────
  const legPnl = realisedPnlFor(pos.side, pos.entry, exitPrice, shares);

  // v2.5.0: carry the bot-booked TP1 leg into the trade total — UNLESS a closed
  // record already holds that same leg (the broker-OCO TP1 path writes one). The
  // shared predicate defaults to "already booked" on ambiguity: for an accounting
  // fix, never inflate.
  const tp1Leg = (pos.tp1_hit && !tp1LegAlreadyInClosedRecords(pos, closedPositions))
    ? (pos.tp1_pnl || 0) : 0;
  const totalPnl = parseFloat((legPnl + tp1Leg).toFixed(2));
  const outcome  = totalPnl >= 0 ? 'WIN' : 'LOSS';
  const icon     = totalPnl >= 0 ? '✅' : '❌';
  const isTp2    = pos.tp1_hit === true;
  const tp1Src   = pos.tp1_pnl_source || (pos.tp1_hit ? 'estimate' : null);
  const combinedSource = isTp2
    ? ((tp1Src === 'alpaca_fill' && pnlSource === 'alpaca_fill') ? 'alpaca_fill' : 'estimate')
    : pnlSource;

  const closedRec = {
    ...pos,
    ...(isTp2 ? {
      tp2_date:   booking.trigger_date || fillDate,
      tp2_price:  exitPrice,
      tp2_shares: shares,
      tp2_pnl:    legPnl,
      tp2_reason: booking.tp2_reason || pe.reason,
      tp2_rsi:    booking.trigger_rsi ?? null,
      exit_strategy: 'v2.1-tp1+tp2',
    } : {
      tp1_date:   booking.trigger_date || fillDate,
      tp1_price:  exitPrice,
      tp1_shares: shares,
      tp1_pnl:    legPnl,
      tp1_reason: booking.tp1_reason || pe.reason,
      tp1_rsi:    booking.trigger_rsi ?? null,
      tp2_shares: 0,
      tp2_pnl:    0,
      tp2_reason: pe.reason === 'stop' ? 'stopped_before_tp1' : pe.reason,
      exit_strategy: booking.exit_strategy || (pe.reason === 'stop' ? 'v2.1-stop' : 'v2.0-rsi50-full'),
    }),
    total_pnl:   totalPnl,
    pnl_source:  combinedSource,
    mode:        pos.mode || CONFIG.tradingMode,
    exit_queued_for_open: true,
    exit_fill_price_source: fp.source,
    ...(exitFills ? { exit_fills: exitFills } : {}),
    // v2.0-compat fields the dashboard reads
    exitLevel:   booking.exit_level || pe.reason,
    exitPrice,
    exitRsi:     booking.trigger_rsi ?? null,
    closeDate:   booking.trigger_date || fillDate,
    realizedPnl: totalPnl,
    outcome,
  };
  delete closedRec.pending_exit;

  // Record FIRST, then re-derive the ledger from records (never a counter — it
  // can't then carry a phantom). pos is fully closed, so exclude it from `open`.
  closedPositions.push(closedRec);
  const acct = updateAccount(null, { closed: closedPositions, open: openPeers });
  closedRec.accountAfter = acct.accountUsd;

  appendTrade([
    closedRec.closeDate,
    (new Date()).toISOString().slice(11, 19),
    isTp2 ? `V2.1/TP2-${closedRec.tp2_reason}` : `V2.1/${pe.reason}`,
    pos.symbol,
    `${pos.side}-${isTp2 ? 'tp2' : 'exit'}`,
    shares,
    pos.entry.toFixed(2),
    pos.stopLoss,
    (shares * exitPrice).toFixed(2),
    legPnl,
    ((legPnl / acct.accountUsd) * 100).toFixed(2),
    pos.signalDate,
    `${isTp2 ? 'TP2' : 'EXIT'}-${pos.id}`,
    pos.mode || CONFIG.tradingMode,
    `${BOT_NAME} v2.1`,
  ].join(','));

  tg.alertExitFired({
    symbol: pos.symbol, side: pos.side, exitPrice,
    exitReason: `${pe.reason}_at_open`, realizedPnl: legPnl,
    accountAfter: acct.accountUsd, mode: pos.mode || CONFIG.tradingMode,
  }).catch(() => {});

  console.log(`  ${icon} ${pos.symbol} QUEUED ${pe.reason.toUpperCase()} FILLED AT THE OPEN — ${shares} sh @ $${exitPrice.toFixed(4)} (${pnlSource}), leg ${legPnl >= 0 ? '+' : ''}$${legPnl}, trade total ${totalPnl >= 0 ? '+' : ''}$${totalPnl}`);
  writeLog({
    kind: 'pending_exit_filled', symbol: pos.symbol, reason: pe.reason, kindOfExit: 'full',
    shares, exitPrice, pnl: legPnl, total_pnl: totalPnl, pnl_source: combinedSource,
    price_source: fp.source, order_id: pe.order_id,
  });
  return false;   // closed
}

// ── Market Data (Yahoo Finance — no API key needed) ───────────────────────────

async function fetchDailyCandles(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
  const res  = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data returned`);

  const timestamps = result.timestamp || [];
  const q = result.indicators.quote[0];

  return timestamps
    .map((ts, i) => ({
      time:   ts * 1000,
      date:   new Date(ts * 1000).toISOString().slice(0, 10),
      open:   q.open[i],
      high:   q.high[i],
      low:    q.low[i],
      close:  q.close[i],
      volume: q.volume[i],
    }))
    .filter(c => c.close !== null && c.close !== undefined && !isNaN(c.close));
}

// ── Earnings Date Check ───────────────────────────────────────────────────────
// Skip any trade if an earnings date falls within the CONFIG.earningsWindow.
// Uses Yahoo Finance's quoteSummary — no API key required.

async function fetchEarningsDates(symbol) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    const json = await res.json();
    const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
    return dates.map(d => d.fmt || new Date(d.raw * 1000).toISOString().slice(0, 10));
  } catch {
    return []; // If check fails, let the trade through with a warning
  }
}

function isWithinEarningsWindow(earningsDates, windowDays) {
  // v1.5 rule clarification — block trade ONLY if earnings is within the
  // next `windowDays` calendar days (i.e., we're inside the pre-earnings
  // window). Past earnings dates no longer block — trading the day after
  // earnings is permitted and is in fact often a high-confidence entry
  // because the announcement risk has just been removed.
  const today = new Date();
  for (const dateStr of earningsDates) {
    const earningsDate = new Date(dateStr);
    const daysFromNow = (earningsDate - today) / (1000 * 60 * 60 * 24);
    if (daysFromNow >= 0 && daysFromNow <= windowDays) {
      return { blocked: true, date: dateStr, daysAway: Math.round(daysFromNow) };
    }
  }
  return { blocked: false };
}

function isWithinPPIWindow(windowDays) {
  // v1.6 macro filter — block trading 14 days BEFORE a PPI release.
  // Same logic as earnings: pre-only (allow day after).
  // Backtest evidence (v1.7 validation): PPI lift on REFINED 47 watchlist
  // takes WR from 66.9% to 74.8% with PF jumping 2.11 -> 3.20.
  const today = new Date();
  for (const dateStr of PPI_DATES) {
    const eventDate = new Date(dateStr);
    const daysFromNow = (eventDate - today) / (1000 * 60 * 60 * 24);
    if (daysFromNow >= 0 && daysFromNow <= windowDays) {
      return { blocked: true, date: dateStr, daysAway: Math.round(daysFromNow) };
    }
  }
  return { blocked: false };
}

// ── Indicators ────────────────────────────────────────────────────────────────

// RSI(14) using Wilder's smoothing method
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => null);
  const result = new Array(period).fill(null);

  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push(parseFloat(rsi0.toFixed(2)));

  // Wilder smoothing for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
  }
  return result;
}

// EMA with standard multiplier
function calcEMAArray(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = null;
  for (const v of values) {
    if (v === null || v === undefined || isNaN(v)) { result.push(null); continue; }
    ema = ema === null ? v : v * k + ema * (1 - k);
    result.push(parseFloat(ema.toFixed(6)));
  }
  return result;
}

// MACD(12, 26, 9) — default TradingView settings, histogram hidden per strategy
function calcMACD(closes) {
  const ema12    = calcEMAArray(closes, 12);
  const ema26    = calcEMAArray(closes, 26);
  const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? parseFloat((v - ema26[i]).toFixed(6)) : null);
  const signal   = calcEMAArray(macdLine, 9);
  return { macdLine, signal };
}

// Simple Moving Average — used for V2.1 TP2 detection (50d and 200d MAs).
// Returns an array of the same length as `values`; entries before `period`
// bars of history are null.
function calcSMA(values, period) {
  const result = [];
  let sum = 0;
  let count = 0;
  const window = [];
  for (const v of values) {
    if (v === null || v === undefined || isNaN(v)) {
      result.push(null);
      // Keep window in sync so we don't drift; treat missing as a reset
      continue;
    }
    window.push(v);
    sum += v;
    count++;
    if (window.length > period) {
      sum -= window.shift();
      count--;
    }
    result.push(window.length === period ? parseFloat((sum / period).toFixed(6)) : null);
  }
  return result;
}

// ── Weekly Resampling & Direction Check (V2 method) ───────────────────────────
// Groups daily candles by their week's Monday-key so the IN-PROGRESS week is
// addressable. The current week's "close" is the most recent daily close
// (so the weekly indicator reflects the partial week's data, matching the
// backtest's Friday-resample-then-shift-back-to-Monday alignment).

function resampleWeekly(candles) {
  if (!candles || candles.length === 0) return [];
  const byWeek = new Map();
  for (const c of candles) {
    if (c.close === null || c.close === undefined || isNaN(c.close)) continue;
    const d = new Date(c.date);
    const day = d.getUTCDay();                // 0=Sun, 1=Mon, ..., 6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + mondayOffset);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD of that week's Monday
    // Iteration is chronological → the last daily close in each week wins.
    byWeek.set(key, c.close);
  }
  const keys = Array.from(byWeek.keys()).sort();
  return keys.map(k => ({ date: k, close: byWeek.get(k) }));
}

// V2 weekly direction check. Returns:
//   { rsiRising, macdRising, weeklyRsi, weeklyMacd, enoughHistory }
// rising/falling are computed as this-week's-partial value vs the prior
// fully-formed weekly value (week-over-week 1-bar slope).
function weeklyDirection(candles) {
  const weekly = resampleWeekly(candles);
  if (weekly.length < 30) {
    return { rsiRising: null, macdRising: null, enoughHistory: false };
  }
  const closes = weekly.map(w => w.close);
  const rsiArr = calcRSI(closes);
  const { macdLine } = calcMACD(closes);
  const n = closes.length;
  const lastRsi  = rsiArr[n - 1];
  const prevRsi  = rsiArr[n - 2];
  const lastMacd = macdLine[n - 1];
  const prevMacd = macdLine[n - 2];
  if (lastRsi == null || prevRsi == null || lastMacd == null || prevMacd == null) {
    return { rsiRising: null, macdRising: null, enoughHistory: false };
  }
  return {
    rsiRising:    lastRsi  > prevRsi,
    macdRising:   lastMacd > prevMacd,
    weeklyRsi:    lastRsi,
    weeklyMacd:   lastMacd,
    enoughHistory: true,
  };
}

// ── Weekly series aligned to daily bars (EXACT backtest parity) ───────────────
// The validated backtest (backtest-sid-bot-parity.py) derives four daily-aligned
// weekly booleans that gate the ARM and TRIGGER of detectEntrySignal. They use
// TWO different W-FRI reindex conventions which must be replicated exactly:
//
//   1. Weekly SMA50/200 ARM gate  (sma_long_ok / sma_short_ok)
//        weekly_close = Close.resample('W-FRI').last()
//        wfast/wslow  = rolling(50/200).mean()
//        (wfast > wslow).reindex(daily, ffill)        ← NO index shift
//      → a daily bar uses the most recent COMPLETED W-FRI week (Mon-Thu use the
//        prior Friday; a Friday uses its own week). No intra-week lookahead.
//
//   2. Weekly RSI/MACD TRIGGER direction (wk_rsi_rising / wk_macd_rising)
//        w_rsi/w_macd rising = value > value.shift(1)  on weekly bars
//        index shifted back 4 days (Fri→Mon) THEN reindex(daily, ffill)
//      → a daily bar Mon-Fri uses THIS week's Friday value (this matches the
//        live weeklyDirection() result at the final bar: in-progress week vs
//        prior completed week).
//
// `requires >= 200 weekly bars for the SMA gate (else default true, as backtest)
// and >= 30 for the direction gate (else default false, as backtest).
// Returns arrays indexed 1:1 with `candles`.
function buildWeeklyDailyAligned(candles) {
  const n = candles.length;
  const smaLongOk  = new Array(n).fill(true);   // backtest default when <200 weekly bars
  const smaShortOk = new Array(n).fill(true);
  const wkRsiRising  = new Array(n).fill(false); // backtest default when <30 weekly bars
  const wkMacdRising = new Array(n).fill(false);

  // ── Resample to W-FRI weekly buckets: key = the Friday ending each week. ──
  // Match pandas 'W-FRI': each daily bar belongs to the week ending on the
  // next (or same) Friday. Bucket value = last daily close in that week.
  // We track each bucket's Friday date (ms) and its last close.
  const buckets = []; // { friMs, monMs, close }
  const byFri = new Map();
  for (const c of candles) {
    if (c.close === null || c.close === undefined || isNaN(c.close)) continue;
    const d = new Date(c.date + 'T00:00:00Z');
    const dow = d.getUTCDay();             // 0=Sun .. 6=Sat
    // days until that week's Friday (5). Sat(6)/Sun(0) belong to the NEXT Friday.
    let addToFri;
    if (dow === 6)      addToFri = 6;      // Sat → +6 (next Fri)
    else if (dow === 0) addToFri = 5;      // Sun → +5 (next Fri)
    else                addToFri = 5 - dow; // Mon..Fri → this week's Fri
    const fri = new Date(d);
    fri.setUTCDate(fri.getUTCDate() + addToFri);
    const friMs = fri.getTime();
    const monMs = friMs - 4 * 86400000;    // Fri→Mon shift (the -4d the backtest applies)
    if (byFri.has(friMs)) {
      byFri.get(friMs).close = c.close;    // chronological → last close in week wins
    } else {
      const b = { friMs, monMs, close: c.close };
      byFri.set(friMs, b);
      buckets.push(b);
    }
  }
  buckets.sort((a, b) => a.friMs - b.friMs);
  const W = buckets.length;
  const wCloses = buckets.map(b => b.close);

  // ── (1) Weekly SMA50/200 arm gate (no shift) ──
  if (W >= 200) {
    const wSma50  = calcSMA(wCloses, 50);
    const wSma200 = calcSMA(wCloses, 200);
    const longOkW  = wCloses.map((_, i) =>
      (wSma50[i] != null && wSma200[i] != null) ? (wSma50[i] > wSma200[i]) : null);
    const shortOkW = wCloses.map((_, i) =>
      (wSma50[i] != null && wSma200[i] != null) ? (wSma50[i] < wSma200[i]) : null);
    // ffill weekly→daily on the Friday (no-shift) anchor: a daily bar takes the
    // most recent weekly bucket whose Friday date <= the daily bar's date.
    let wi = -1;
    for (let i = 0; i < n; i++) {
      const dMs = new Date(candles[i].date + 'T00:00:00Z').getTime();
      while (wi + 1 < W && buckets[wi + 1].friMs <= dMs) wi++;
      if (wi >= 0 && longOkW[wi] != null) {
        smaLongOk[i]  = longOkW[wi];
        smaShortOk[i] = shortOkW[wi];
      } else {
        // Before the first valid weekly SMA → pandas NaN → .fillna(False)
        smaLongOk[i]  = false;
        smaShortOk[i] = false;
      }
    }
  }
  // else: leave defaults (true) — matches backtest's <200 branch.

  // ── (2) Weekly RSI/MACD rising trigger gate (shift -4d = Mon anchor) ──
  if (W >= 30) {
    const wRsi  = calcRSI(wCloses, RSI_PERIOD);
    const { macdLine: wMacd } = calcMACD(wCloses);
    const rsiRiseW  = wCloses.map((_, i) =>
      (i > 0 && wRsi[i]  != null && wRsi[i - 1]  != null) ? (wRsi[i]  > wRsi[i - 1])  : null);
    const macdRiseW = wCloses.map((_, i) =>
      (i > 0 && wMacd[i] != null && wMacd[i - 1] != null) ? (wMacd[i] > wMacd[i - 1]) : null);
    // ffill on the Monday (shifted) anchor: a daily bar takes the most recent
    // weekly bucket whose Monday date <= the daily bar's date.
    let wi = -1;
    for (let i = 0; i < n; i++) {
      const dMs = new Date(candles[i].date + 'T00:00:00Z').getTime();
      while (wi + 1 < W && buckets[wi + 1].monMs <= dMs) wi++;
      if (wi >= 0 && rsiRiseW[wi] != null) {
        wkRsiRising[i]  = rsiRiseW[wi];
        wkMacdRising[i] = macdRiseW[wi] != null ? macdRiseW[wi] : false;
      } else {
        wkRsiRising[i]  = false;   // pandas NaN → .fillna(False)
        wkMacdRising[i] = false;
      }
    }
  }
  // else: leave defaults (false) — matches backtest's <30 branch (both False).

  return { smaLongOk, smaShortOk, wkRsiRising, wkMacdRising };
}

// ── Long-term-bullish classification (for the MANUAL-WATCH short flag) ─────────
// Identifies an asset in a stable long-term uptrend so we can flag SHORT runners
// against it for manual S/R-level monitoring. Earned from the GOOG 2026-06 trade
// + the TP2-RSI experiment (SID/strategy-test-vault/tp2-rsi-experiment/): shorts
// on long-term-bullish names rarely reach daily oversold before bouncing, so the
// mechanical TP2 (RSI never arrives, SMA can round-trip) has a blind spot. The
// fix is a human eyeballing support — this flag tells the trader WHICH runners
// need that attention.
//
// NOTE: the backtest's hybrid classifier uses WEEKLY EMA50/EMA200/MACD/SMA200
// (needs ~5y of data for the weekly 200-bar windows). The live position monitor
// only fetches 2y, so here we use a DAILY-trend proxy that is computable from
// that window and stable through the kind of pullback you short into:
//   price > daily SMA200  AND  daily SMA50 > daily SMA200  (golden-cross regime)
// This is a reminder heuristic, not a P&L-routing decision, so the proxy is
// appropriate. Deliberately omits a MACD term — the daily MACD line flips
// negative during the very pullbacks we care about, which would suppress the
// flag exactly when it's wanted (the weekly MACD the backtest uses does not).
function longTermBullish(candles) {
  if (!candles || candles.length < 200) {
    return { bullish: false, enoughHistory: false };
  }
  const closes = candles.map(c => c.close);
  const sma50  = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const n = closes.length;
  const price = closes[n - 1];
  const s50   = sma50[n - 1];
  const s200  = sma200[n - 1];
  if (price == null || s50 == null || s200 == null) {
    return { bullish: false, enoughHistory: false };
  }
  const priceAboveSma200 = price > s200;
  const goldenCross      = s50 > s200;
  return {
    bullish: priceAboveSma200 && goldenCross,
    enoughHistory: true,
    priceAboveSma200,
    goldenCross,
    sma50: s50,
    sma200: s200,
  };
}

// ── Signal Detection ──────────────────────────────────────────────────────────
// Returns a signal object, a {signal:null, rejectReason} log object, or null.
//
// ⚠ REWRITTEN 2026-06-29 to be an EXACT bar-by-bar replay of the validated
// backtest's arm/trigger/cooldown state machine (backtest-sid-bot-parity.py,
// SID_BOT_PARITY=false SID_REARM_COOLDOWN_LONG=0 SID_REARM_COOLDOWN_SHORT=5 →
// 280 trades / 73.9% WR / PF 3.19 / +$31,426 over 5y tier1, $200 fixed risk).
//
// The OLD implementation was a one-shot "episode scan" with NO arm timeout, NO
// RSI(3) confirmation and NO weekly-SMA arm gate — far too loose. It would, for
// example, still fire ADBE's 2026-06-17 signal as a 2026-06-26 entry even though
// the 3-day arm has long since expired. The replay fixes this.
//
// detectEntrySignal is called ONCE per run, only when the bot is FLAT on this
// ticker, with ~2y of daily candles. Its job: "does an entry TRIGGER on the
// LAST (today's) bar?" We answer it by replaying the backtest arm machine over
// the trailing CONFIG.armReplayBars bars from a clean state (armDir=null,
// rearmCooldown=0). 40 bars >> the 3-day arm + 5-day short cooldown, so today's
// arm/cooldown state is fully determined regardless of the seed.
//
// State machine (verbatim from the backtest), per bar in order:
//   ARM   — re-arm cooldown countdown (only while disarmed); compute RSI(3)
//           and weekly-SMA50/200 arm gates; arm LONG (rsi<30) or SHORT (rsi>70)
//           if eligible and not side-blocked; else, if already armed, age the
//           arm (days_since_arm++, accumulate arm low/high) and expire it after
//           ARM_TIMEOUT_DAYS — on expiry, set the side-specific re-arm cooldown.
//   TRIGGER — for the active arm side, require RSI+MACD aligned, no-go zone OK,
//           and the weekly RSI-OR-MACD direction filter. On fire: stop =
//           floor(armLow) / ceil(armHigh), entry = close, reset arm.
//
// PARITY NOTES:
//   • Earnings/PPI/VIX gates are NOT applied here — the CALLER applies them
//     after this returns (unchanged behaviour). The backtest folds earnings
//     into arming/expiry; the bot deliberately keeps it in the caller. Net
//     effect on the entry set is negligible (an earnings-blocked trigger is
//     skipped by the caller anyway), and verified against the backtest CSV.
//   • Cooldown is applied on arm EXPIRY only (matches the backtest); a
//     successful trigger just resets the arm with no cooldown.
//   • A trigger on a NON-final bar means the backtest would have been holding a
//     position there → the bot would not be scanning today → we reset arm and
//     keep replaying, but only a FINAL-bar trigger returns a signal.

function detectEntrySignal(candles) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  if (n < 40) return null;

  const rsiArr   = calcRSI(closes, RSI_PERIOD);
  const rsi3Arr  = calcRSI(closes, RSI3_PERIOD);
  const { macdLine } = calcMACD(closes);
  const wk = buildWeeklyDailyAligned(candles);

  const ARM_TIMEOUT  = CONFIG.armTimeoutDays;
  const CD_LONG      = CONFIG.rearmCooldownLong;
  const CD_SHORT     = CONFIG.rearmCooldownShort;

  // Replay window: trailing armReplayBars, but never start before index 1.
  const start = Math.max(1, n - CONFIG.armReplayBars);

  // Seed prev from the bar immediately before the window (the backtest's prev is
  // always the previous PROCESSED bar). If that bar's indicators are null we
  // fall back to per-bar warmup handling inside the loop.
  let prevRsi  = (start - 1 >= 0) ? rsiArr[start - 1]   : null;
  let prevMacd = (start - 1 >= 0) ? macdLine[start - 1] : null;

  // Arm state (clean initial state, per the replay design).
  let armDir = null;            // 'long' | 'short' | null
  let armLow = null, armHigh = null;
  let armSignalIdx = null;      // bar index where the active arm was set (= signalDate)
  let daysSinceArm = 0;
  let rearmCooldown = 0;        // trading-day lockout after an arm expires unfired
  let cooldownSide = null;      // 'long' | 'short' — which side the lockout applies to

  let finalSignal = null;       // set only if a trigger fires on the LAST bar

  for (let i = start; i < n; i++) {
    const rsi  = rsiArr[i];
    const m    = macdLine[i];
    const rsi3 = rsi3Arr[i];

    // Warmup-skip (mirrors the backtest: needs current RSI/MACD AND a prev).
    if (rsi == null || m == null || prevRsi == null || prevMacd == null) {
      prevRsi = rsi; prevMacd = m;
      continue;
    }

    const rsiRising   = rsi > prevRsi;
    const rsiFalling  = rsi < prevRsi;
    const macdRising  = m   > prevMacd;
    const macdFalling = m   < prevMacd;

    const isLast = (i === n - 1);

    // ── ARM (verbatim from backtest) ──────────────────────────────────────
    const rsi3OkLong  = rsi3 != null && rsi3 < RSI_OVERSOLD;
    const rsi3OkShort = rsi3 != null && rsi3 > RSI_OVERBOUGHT;
    const wkLong  = wk.smaLongOk[i];   // weekly SMA50 > SMA200 (no-shift ffill)
    const wkShort = wk.smaShortOk[i];  // weekly SMA50 < SMA200

    // Re-arm cooldown countdown — only ticks while disarmed (matches backtest).
    if (armDir === null && rearmCooldown > 0) {
      rearmCooldown -= 1;
      if (rearmCooldown === 0) cooldownSide = null;
    }

    const armLongGate  = rsi3OkLong  && wkLong;
    const armShortGate = rsi3OkShort && wkShort;
    const longBlocked  = rearmCooldown > 0 && cooldownSide === 'long';
    const shortBlocked = rearmCooldown > 0 && cooldownSide === 'short';

    if (armDir === null) {
      if (rsi < RSI_OVERSOLD && armLongGate && !longBlocked) {
        armDir = 'long';
        armLow = candles[i].low; armHigh = candles[i].high;
        armSignalIdx = i; daysSinceArm = 0;
      } else if (rsi > RSI_OVERBOUGHT && armShortGate && !shortBlocked) {
        armDir = 'short';
        armLow = candles[i].low; armHigh = candles[i].high;
        armSignalIdx = i; daysSinceArm = 0;
      }
    } else {
      daysSinceArm += 1;
      armLow  = Math.min(armLow,  candles[i].low);
      armHigh = Math.max(armHigh, candles[i].high);
      const expired = daysSinceArm > ARM_TIMEOUT;
      if (expired) {
        const cd = (armDir === 'long') ? CD_LONG : CD_SHORT;
        if (cd > 0) { rearmCooldown = cd; cooldownSide = armDir; }
        armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
      }
    }

    // ── TRIGGER (v2-weekly-or, verbatim from backtest) ────────────────────
    if (armDir === 'long') {
      const nogoOk   = rsi < CONFIG.rsiNoGoLong;
      const weeklyOk = !CONFIG.useWeeklyDirection || (wk.wkRsiRising[i] || wk.wkMacdRising[i]);
      if (rsiRising && macdRising && nogoOk && weeklyOk) {
        const stop = Math.floor(armLow);
        const ep   = closes[i];
        if (ep > stop) {
          if (isLast) {
            finalSignal = {
              signal:     'long',
              entry:      ep,
              stopLoss:   stop,
              signalDate: candles[armSignalIdx].date,
              entryDate:  candles[i].date,
              rsiAtEntry: rsi,
              rsiAtSignal: rsiArr[armSignalIdx],
              reason:     `RSI armed long (RSI ${rsiArr[armSignalIdx]?.toFixed(1)}) on ${candles[armSignalIdx].date} → RSI(${rsi.toFixed(1)}) & MACD both up, ${daysSinceArm}d into 3d arm`,
            };
          }
          // reset arm (no cooldown on a successful trigger — matches backtest)
          armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
        }
      }
    } else if (armDir === 'short') {
      const nogoOk   = rsi > CONFIG.rsiNoGoShort;
      const weeklyOk = !CONFIG.useWeeklyDirection || ((!wk.wkRsiRising[i]) || (!wk.wkMacdRising[i]));
      if (rsiFalling && macdFalling && nogoOk && weeklyOk) {
        const stop = Math.ceil(armHigh);
        const ep   = closes[i];
        if (stop > ep) {
          if (isLast) {
            finalSignal = {
              signal:     'short',
              entry:      ep,
              stopLoss:   stop,
              signalDate: candles[armSignalIdx].date,
              entryDate:  candles[i].date,
              rsiAtEntry: rsi,
              rsiAtSignal: rsiArr[armSignalIdx],
              reason:     `RSI armed short (RSI ${rsiArr[armSignalIdx]?.toFixed(1)}) on ${candles[armSignalIdx].date} → RSI(${rsi.toFixed(1)}) & MACD both down, ${daysSinceArm}d into 3d arm`,
            };
          }
          armDir = null; armLow = null; armHigh = null; armSignalIdx = null;
        }
      }
    }

    prevRsi = rsi; prevMacd = m;
  }

  return finalSignal; // null if no trigger fires on today's bar
}

// ── Position Sizing ───────────────────────────────────────────────────────────
// Follows the SID formula exactly:
//   Risk Amount   = Account × Risk %
//   Risk per Share = |Entry - StopLoss|
//   % Risk/Pos    = Risk per Share ÷ Entry
//   Position $    = Risk Amount ÷ % Risk/Pos   (capped at maxPositionPct of account)
//   Shares        = floor(Position $ ÷ Entry)  — always round DOWN

function calcPositionSize(entry, stopLoss) {
  const riskAmount    = CONFIG.accountUsd * CONFIG.riskPct;
  const riskPerShare  = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0) return null;

  const riskPct       = riskPerShare / entry;
  const positionUsd   = riskAmount / riskPct;
  const maxUsd        = CONFIG.accountUsd * CONFIG.maxPositionPct; // Cap at 10%
  const cappedUsd     = Math.min(positionUsd, maxUsd);
  const shares        = Math.floor(cappedUsd / entry);            // Always round DOWN

  if (shares < 1) return null; // Position too small to open

  return {
    shares,
    totalUsd:  parseFloat((shares * entry).toFixed(2)),
    riskUsd:   parseFloat((shares * riskPerShare).toFixed(2)),
    riskPct:   parseFloat((riskPerShare / entry * 100).toFixed(2)),
  };
}

// ── Position Monitor — V2.1 Dynamic TP1 / TP2 Exit ────────────────────────────
// V2.1 introduces a two-stage exit. Per instructor S3_P1 (long) / S3_P2 (short):
//
//   TP1 (RSI 50)
//     - Close half the position.
//     - Move stop on the remaining half to break-even (entry price).
//     - "WR" is now defined as did-TP1-fire-or-not, so a TP1+breakeven-stop
//       outcome is still a WIN — the half-position profit is banked.
//
//   TP2 (whichever of these the remaining 50% hits first)
//     - Price touches the 50-day SMA (first MA target)
//     - Price touches the 200-day SMA (trend MA target)
//     - Break-even stop hit (price returns to entry — the runner round-trips)
//     - 30-trading-day timeout (close at next-day open)
//
// PDT-immune design preserved: the bot does not place broker-side stops. On
// each daily run it scans post-entry candles and submits market orders for
// any exits hit — which fill next morning, never same-day.
//
// Schema additions to open-positions-sid.json (per position):
//   tp1_hit            : boolean — has the RSI 50 partial fired yet?
//   tp1_date           : 'YYYY-MM-DD' — set when TP1 fires
//   tp1_price          : number — fill (close-of-bar that hit RSI 50)
//   tp1_shares         : int    — number of shares closed at TP1
//   tp1_pnl            : number — realised $ from the TP1 partial
//   tp1_rsi            : number — RSI value at the TP1 bar
//   shares_total       : int    — original share count (immutable after entry)
//   shares_remaining   : int    — current runners after TP1 partial close
//   orig_stop          : number — entry-time stop level (kept for record)
//
// Backwards compat: positions opened under v2.0 (no tp1_* fields) are upgraded
// to the v2.1 schema on first read with tp1_hit=false. They then participate
// in the V2.1 exit logic from that point forward.
//
// Toggle: SID_DYNAMIC_TP=false falls back to v2.0 behaviour (full close at
// RSI 50, no TP2). Useful for A/B comparisons or emergency revert.

async function checkPositions(executor = null) {
  const openPositions   = loadOpenPositions();
  const closedPositions = loadClosedPositions();

  if (!openPositions.length) {
    console.log('\n── SID Position Monitor: No open positions ──');
    return;
  }

  console.log(`\n── SID Position Monitor: ${openPositions.length} open position(s) ──  [Dynamic TP ${CONFIG.useDynamicTp ? 'ON' : 'OFF (v2.0 fallback)'}]`);

  const stillOpen = [];
  const manualWatchList = [];   // bullish-asset SHORT runners that need manual S/R monitoring
  let numClosed = 0;

  for (const pos of openPositions) {
    // Upgrade legacy v2.0 positions to V2.1 schema on first read
    if (typeof pos.tp1_hit === 'undefined') {
      pos.tp1_hit          = false;
      pos.orig_stop        = pos.stopLoss;
      pos.shares_total     = pos.shares;
      pos.shares_remaining = pos.shares;
      console.log(`  ▶ ${pos.symbol} — legacy v2.0 position upgraded to v2.1 schema in-place`);
    }

    const tp1Tag = pos.tp1_hit ? ' [TP1✓]' : '';
    process.stdout.write(`  ▶ ${pos.symbol} ${pos.side.toUpperCase()} @ $${pos.entry}${tp1Tag} (entry ${pos.openDate}) … `);

    // ── v2.6.0 SINGLE-FIRE GUARD: a queued exit is already resting ──────────
    // reconcilePendingExits() (run at the TOP of run(), before syncPositions)
    // owns this position until the queued order fills or dies. Skipping here is
    // what makes "never queue a second order while one is pending" true — and it
    // also stops a TP1 whose order has not yet filled from being re-triggered
    // (tp1_hit only flips when the fill is BOOKED, never when it is queued).
    // Skipped before the candle fetch, so it costs nothing.
    if (pos.pending_exit?.order_id) {
      const pe = pos.pending_exit;
      console.log(`queued ${pe.reason} resting for the open (${pe.shares} sh, tif ${pe.time_in_force}, order ${pe.order_id}) — skipping exit evaluation`);
      stillOpen.push(pos);
      continue;
    }

    // V2.1 needs ~200 trading-day SMA → fetch 2y of history (was 6mo in v2.0)
    let candles;
    try {
      candles = await fetchDailyCandles(pos.symbol, '2y');
    } catch (err) {
      console.log(`candles unavailable — skipping (${err.message})`);
      stillOpen.push(pos);
      continue;
    }

    // ── MANUAL-WATCH flag: SHORT runner on a long-term-bullish asset ────────
    // Computed every run so the flag stays current as the trend evolves. Only
    // SHORTs get flagged — longs ride the bullish drift, shorts fight it (the
    // dangerous subset where the mechanical TP2 has a blind spot). See
    // longTermBullish() + SID/strategy-test-vault/tp2-rsi-experiment/README.md.
    pos.manual_watch = false;
    pos.manual_watch_reason = null;
    if (pos.side === 'short') {
      const ltb = longTermBullish(candles);
      if (ltb.bullish) {
        const phase = pos.tp1_hit
          ? 'RUNNER — watch support for TP2 exit (RSI may never reach oversold)'
          : 'bullish-asset short — plan an S/R exit for the runner after TP1';
        pos.manual_watch = true;
        pos.manual_watch_reason = phase;
        manualWatchList.push({ symbol: pos.symbol, entry: pos.entry, tp1_hit: !!pos.tp1_hit, reason: phase });
        console.log(`\n    ⚠ MANUAL-WATCH: ${pos.symbol} SHORT on long-term-bullish asset (price>$${ltb.sma200?.toFixed(2)} SMA200, 50>200). ${phase}`);
        process.stdout.write(`  ▶ ${pos.symbol} (cont.) … `);
      }
    }

    // Where do we start scanning post-position-state? If TP1 already fired,
    // start AFTER the TP1 date (TP1 partial is already booked). Otherwise
    // start AFTER entry.
    const scanFromDate = pos.tp1_hit ? pos.tp1_date : pos.openDate;
    const newBars = candles.filter(c => c.date > scanFromDate);
    if (!newBars.length) {
      console.log('no new daily bars yet');
      stillOpen.push(pos);
      continue;
    }

    const closes  = candles.map(c => c.close);
    const rsiArr  = calcRSI(closes);
    const sma50Arr  = CONFIG.useDynamicTp ? calcSMA(closes, 50)  : null;
    const sma200Arr = CONFIG.useDynamicTp ? calcSMA(closes, 200) : null;

    // ── V2.2 broker-order maintenance ──────────────────────────────────────
    // For positions managed by V2.2 (broker-side stops + intraday TP1 limit),
    // ensure the resting orders are in sync with current state. V2.1 legacy
    // positions (e.g. open GOOG runner) are managed by the daily-poll logic
    // below and skip this step.
    const posIsV2_2 = isV2_2Position(pos);
    if (posIsV2_2 && executor) {
      await maintainV2_2BrokerOrders(pos, executor, closes);
    }

    // tp1_date may exist on legacy data — locate its index in *this* run's
    // candles array (yfinance can shift indices vs prior runs) for accurate
    // bars-since-TP1 timeout calc.
    const tp1IdxInCandles = pos.tp1_hit
      ? candles.findIndex(c => c.date === pos.tp1_date)
      : -1;

    // Walk forward through post-scan-date candles. Multiple exit events can
    // fire in a single run if the bot has been quiet (e.g. TP1 day 5, TP2 day
    // 20). They are processed in chronological order.
    let positionHandled = false; // set true once we either close fully or fail-out

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (c.date <= scanFromDate) continue;
      const rsi = rsiArr[i];
      if (rsi === null) continue;

      // ── Branch A: TP1 not yet hit ─────────────────────────────────────────
      if (!pos.tp1_hit) {
        // V2.2.1 HYBRID routing:
        //   SHORTS: broker-side resting GTC stop + resting GTC TP1 limit handle
        //           both exits. syncPositions detects fills and updates state
        //           before this point. Skip Branch A entirely.
        //   LONGS:  broker-side resting GTC stop handles the stop. TP1 uses
        //           v2.1 close-based daily-poll (no resting TP1 limit on Alpaca
        //           per backtest evidence that close-based longs book bigger
        //           partials in bullish markets). Skip the stop simulation
        //           below but DO process the RSI 50 close-based TP1 check.
        if (posIsV2_2 && pos.side === 'short') continue;
        const skipStopSim = posIsV2_2;  // long v2.2 still needs TP1 check

        // Original stop check — full stop-out before TP1 = full loss on shares_total
        // (Skipped for any v2.2 position — broker GTC stop fires intraday and
        //  syncPositions records it. Re-doing it here would double-fire.)
        if (skipStopSim) {
          // Just process the TP1 close-based check below (longs only by now)
        } else {
        const stopHit = pos.side === 'long'
          ? c.low  <= pos.stopLoss
          : c.high >= pos.stopLoss;

        if (stopHit) {
          // ── v2.6.0: market CLOSED → queue the exit for the open ───────────
          // Pre-v2.6.0 this fell straight into executor.closePosition(), which
          // throws `Market closed — refusing to submit close for X` (:520), so a
          // stop breached after the last in-hours run was not acted on until the
          // next one — potentially days, given 3h-late GHA crons.
          if (shouldQueueExitForOpen(executor)) {
            await queueExitForOpen({
              pos, executor,
              qty: pos.shares_remaining ?? pos.shares_total,
              isFullClose: true,
              reason: 'stop',
              booking: {
                trigger_date:   c.date,
                trigger_rsi:    rsi,
                estimate_price: pos.stopLoss,
                exit_level:     'sl',
                exit_strategy:  'v2.1-stop',
                tp1_reason:     'stop',
              },
            });
            stillOpen.push(pos);
            positionHandled = true;
            break;
          }

          // Start at the SIMULATED stop level; overwritten below with the real
          // Alpaca fill once the market close confirms (v2.5.0).
          let exitPrice   = pos.stopLoss;
          let realizedPnl = parseFloat((
            pos.side === 'long'
              ? (exitPrice - pos.entry) * pos.shares_total
              : (pos.entry - exitPrice) * pos.shares_total
          ).toFixed(2));
          let stopPnlSource = 'estimate';
          let stopCloseOrderId = null;

          if (executor) {
            try {
              const closeRes = await executor.closePosition(pos, `V2.1 stop-out before TP1 — stop $${pos.stopLoss} breached ${c.date}`);
              stopCloseOrderId = closeRes?.closeOrderId || null;
            } catch (err) {
              console.log(`\n    🚫 Alpaca close FAILED: ${err.message} — position stays open, will retry next run`);
              writeLog({ kind: 'close_fail', symbol: pos.symbol, error: err.message });
              stillOpen.push(pos);
              positionHandled = true;
              break;
            }

            // ── v2.5.0 FIX: BOOK THE REAL STOP FILL, NOT THE STOP LEVEL ──────
            // This path submits a MARKET sell/buy to exit — it does not fill at
            // the stop level, it fills at whatever the market gives. v2.4.1 fixed
            // exactly this for TP1 (Branch A) and TP2 (Branch B) via
            // pollOrderFill + filledAvgPrice, but the stop path was missed and
            // kept booking `pos.stopLoss` with pnl_source:'estimate'.
            //   LIVE PROOF — HD: booked 3sh @ $304.00 = -$24.96, but the real
            //   fill was $303.346667 = -$27.01 (a $2.05 error on one trade).
            // Same poll/override shape as Branch A/B so there is one pattern.
            const stopFill = stopCloseOrderId
              ? await executor.pollOrderFill(stopCloseOrderId)
              : { filled: false, filledAvgPrice: null };
            if (Number.isFinite(stopFill.filledAvgPrice) && stopFill.filledAvgPrice > 0) {
              exitPrice     = stopFill.filledAvgPrice;
              realizedPnl   = realisedPnlFor(pos.side, pos.entry, exitPrice, pos.shares_total);
              stopPnlSource = 'alpaca_fill';
            } else {
              console.log(`\n    ⚠ Stop-out fill price unavailable for ${pos.symbol} — booking stop-level estimate $${exitPrice.toFixed(2)}`);
              stopPnlSource = 'estimate';
            }
          }

          const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
          const icon = realizedPnl >= 0 ? '✅' : '❌';

          // Push the closed record FIRST, then re-derive the ledger from records
          // (never a running counter — can't carry a phantom). v2.5.0: pnl_source
          // is 'alpaca_fill' when the real stop fill was read off Alpaca above,
          // 'estimate' only on the dry-run / fill-unavailable fallback.
          const closedRec = {
            ...pos,
            // V2.1 fields
            tp1_date: c.date,
            tp1_price: exitPrice,
            tp1_shares: pos.shares_total,
            tp1_pnl: realizedPnl,
            tp1_reason: 'stop',
            tp1_rsi: rsi,
            tp2_shares: 0,
            tp2_pnl: 0,
            tp2_reason: 'stopped_before_tp1',
            total_pnl: realizedPnl,
            exit_strategy: 'v2.1-stop',
            pnl_source: stopPnlSource,
            mode: pos.mode || CONFIG.tradingMode,
            // v2.0-compat fields the dashboard reads
            exitLevel: 'sl',
            exitPrice,
            exitRsi: rsi,
            closeDate: c.date,
            realizedPnl,
            outcome,
          };
          closedPositions.push(closedRec);
          const acct = updateAccount(null, { closed: closedPositions, open: stillOpen });
          closedRec.accountAfter = acct.accountUsd;

          tg.alertExitFired({
            symbol: pos.symbol, side: pos.side, exitPrice,
            exitReason: 'sl', realizedPnl, accountAfter: acct.accountUsd,
            mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});

          console.log(`${icon} STOPPED OUT before TP1 — $${exitPrice.toFixed(2)} on ${c.date}`);
          console.log(`    Realized P&L : ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl}`);
          console.log(`    Account now  : $${acct.accountUsd.toFixed(2)}`);
          numClosed++;
          positionHandled = true;
          break;
        }
        }  // end !skipStopSim

        // RSI 50 check — TP1 trigger (v2.1 close-based, fires for v2.1 positions
        // and v2.2.1 LONGS — v2.2.1 SHORTS already `continue`d above)
        const rsi50Hit = pos.side === 'long' ? rsi >= 50 : rsi <= 50;
        if (!rsi50Hit) continue;

        // V2.0 fallback: full close at RSI 50 if dynamic TP disabled
        if (!CONFIG.useDynamicTp) {
          // ── v2.6.0: market CLOSED → queue the exit for the open ───────────
          if (shouldQueueExitForOpen(executor)) {
            await queueExitForOpen({
              pos, executor,
              qty: pos.shares_remaining ?? pos.shares_total,
              isFullClose: true,
              reason: 'v20_rsi50',
              booking: {
                trigger_date:   c.date,
                trigger_rsi:    rsi,
                estimate_price: c.close,
                exit_level:     'rsi50',
                exit_strategy:  'v2.0-rsi50-full',
                tp1_reason:     'rsi50',
              },
            });
            stillOpen.push(pos);
            positionHandled = true;
            break;
          }

          let exitPrice   = c.close;
          let realizedPnl = parseFloat((
            pos.side === 'long'
              ? (exitPrice - pos.entry) * pos.shares_total
              : (pos.entry - exitPrice) * pos.shares_total
          ).toFixed(2));
          let v20PnlSource = 'estimate';

          if (executor) {
            let v20CloseOrderId = null;
            try {
              const closeRes = await executor.closePosition(pos, `V2.0 fallback exit — RSI 50 reached (${rsi.toFixed(1)})`);
              v20CloseOrderId = closeRes?.closeOrderId || null;
            } catch (err) {
              console.log(`\n    🚫 Alpaca close FAILED: ${err.message} — position stays open, will retry next run`);
              writeLog({ kind: 'close_fail', symbol: pos.symbol, error: err.message });
              stillOpen.push(pos);
              positionHandled = true;
              break;
            }
            // v2.5.0: book the REAL fill here too — this path also submits a
            // market close, so c.close is only ever an estimate.
            const v20Fill = v20CloseOrderId
              ? await executor.pollOrderFill(v20CloseOrderId)
              : { filled: false, filledAvgPrice: null };
            if (Number.isFinite(v20Fill.filledAvgPrice) && v20Fill.filledAvgPrice > 0) {
              exitPrice    = v20Fill.filledAvgPrice;
              realizedPnl  = realisedPnlFor(pos.side, pos.entry, exitPrice, pos.shares_total);
              v20PnlSource = 'alpaca_fill';
            } else {
              console.log(`\n    ⚠ V2.0 fallback fill price unavailable for ${pos.symbol} — booking bar-close estimate $${exitPrice.toFixed(2)}`);
            }
          }

          const outcome = realizedPnl >= 0 ? 'WIN' : 'LOSS';
          const icon = realizedPnl >= 0 ? '✅' : '❌';
          // Record first, then re-derive the ledger from records. v2.5.0: the real
          // market-close fill is booked when available ('alpaca_fill'); the
          // bar-close estimate is used (and flagged) only as a fallback.
          const closedRec = {
            ...pos,
            exitLevel: 'rsi50', exitPrice, exitRsi: rsi,
            closeDate: c.date, realizedPnl, outcome,
            exit_strategy: 'v2.0-rsi50-full',
            pnl_source: v20PnlSource,
            mode: pos.mode || CONFIG.tradingMode,
          };
          closedPositions.push(closedRec);
          const acct = updateAccount(null, { closed: closedPositions, open: stillOpen });
          closedRec.accountAfter = acct.accountUsd;
          tg.alertExitFired({
            symbol: pos.symbol, side: pos.side, exitPrice,
            exitReason: 'rsi50', realizedPnl, accountAfter: acct.accountUsd,
            mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});
          console.log(`${icon} ${outcome} — RSI 50 reached @ $${exitPrice.toFixed(2)} on ${c.date}`);
          console.log(`    Realized P&L : ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl}`);
          numClosed++;
          positionHandled = true;
          break;
        }

        // V2.1 default — partial 50% close at RSI 50.
        // exitPrice/tp1Pnl start as the SIMULATED bar-close estimate; after the
        // real Alpaca partial fill confirms (pollOrderFill below) they are
        // OVERWRITTEN with the actual filled_avg_price so the booked P&L matches
        // the broker, not the bar. tp1PnlSource records which was used
        // ('alpaca_fill' when the real fill was read, 'estimate' on fallback).
        // ACCOUNTING ONLY — the RSI-50 trigger + share math + BE stop are
        // unchanged (instructor rule untouched). These are `let` so the confirmed
        // fill can override; the dry_run / re-protect paths keep the estimate.
        const tp1Shares  = Math.max(1, Math.floor(pos.shares_total * CONFIG.tp1Portion));
        let   exitPrice  = c.close;
        let   tp1Pnl     = realisedPnlFor(pos.side, pos.entry, exitPrice, tp1Shares);
        let   tp1PnlSource = 'estimate';

        // ── BE stop price (needed up-front for the re-protect step) ─────────
        // Direction-aware penny rounding, ALWAYS locks ≥ 1¢/share profit.
        // Round to nearest cent first (float-safe), then bias 1¢ in the
        // favourable direction (long: 1¢ above entry; short: 1¢ below).
        const beCents = Math.round(pos.entry * 100);
        const beBias  = pos.side === 'long' ? 1 : -1;
        const bePrice = (beCents + beBias) / 100;
        const runnerShares = pos.shares_total - tp1Shares;

        // ── v2.6.0: market CLOSED → queue the TP1 partial for the open ──────
        // NOTE what is deliberately NOT done here: tp1_hit stays FALSE and no
        // P&L is booked. The shares have not been sold yet — only ORDERED. The
        // reconcile books tp1_* (and restores the BE stop on the remainder) when
        // the fill is confirmed at the open. Until then `pending_exit` makes this
        // position skip exit evaluation entirely, so the TP1 cannot re-fire.
        if (shouldQueueExitForOpen(executor)) {
          await queueExitForOpen({
            pos, executor,
            qty: tp1Shares,
            isFullClose: false,
            reason: 'tp1_rsi50',
            booking: {
              trigger_date:   c.date,
              trigger_rsi:    rsi,
              estimate_price: c.close,
              be_price:       bePrice,
              runner_shares:  runnerShares,
              tp1_reason:     'rsi50',
            },
          });
          stillOpen.push(pos);
          positionHandled = true;
          break;
        }

        // ── CANCEL-FIRST TP1 close (v2.2.5 fix) ─────────────────────────────
        // ROOT CAUSE (PYPL, 2026-06-26→07-01): the v2.2 broker design leaves a
        // full-size GTC stop resting from entry (pos.brokerStopOrderId). Alpaca
        // "holds" all shares against it, so DELETE /v2/positions/SYM?qty=N (the
        // partial close) returned `insufficient qty available (available: 0)`
        // EVERY run — TP1 profit never banked for 5 days, silently.
        //
        // Correct order of operations:
        //   (1) CANCEL the resting broker stop to RELEASE the shares.
        //   (2) Submit the partial close and POLL that it actually fills.
        //   (3) Only THEN re-place the break-even stop on the REMAINING shares.
        //   (*) If the partial fill is NOT confirmed, do NOT leave the position
        //       unprotected — re-place a protective stop on the FULL remaining
        //       qty and raise a LOUD alarm.
        let tp1Confirmed = true;   // true when there is no executor (dry_run) OR the fill confirmed
        // v2.4.3: the broker order id that banks the TP1 half, hoisted so it can
        // be stamped on the position below (accounting bookkeeping — the close
        // mechanics inside this block are unchanged).
        let tp1CloseOrderId = null;
        if (executor) {
          // (1) Release the shares held by the resting broker stop(s).
          try {
            if (pos.brokerStopOrderId) {
              await executor.cancelOrderById(pos.brokerStopOrderId);
            }
            // Belt-and-braces: cancel ANY lingering -stop order on the symbol
            // (id may have rotated via maintainV2_2BrokerOrders across runs).
            const lingeringStop = await findOpenOrder(executor.client, pos.symbol, '-stop');
            if (lingeringStop) await executor.cancelOrderById(lingeringStop.id);
            // v2.4.2 SWEEP — also cancel any MANUAL/external order on this symbol (e.g.
            // a break-even stop placed via the Alpaca UI, no SID client_order_id) so it
            // can't hold the shares + hang waitForNoOpenOrders. Symbol-scoped only.
            await executor.cancelAllOpenOrders(pos.symbol);
            // Wait for Alpaca to actually free the held shares before the close.
            await executor.waitForNoOpenOrders(pos.symbol);
          } catch (err) {
            console.log(`\n    ⚠ Could not cancel resting stop for ${pos.symbol} before TP1: ${err.message} — attempting close anyway`);
          }

          // (2) Submit the partial close and CONFIRM the fill.
          let closeOrderId = null;
          try {
            const res = await executor.closePartial(pos, tp1Shares, `V2.1 TP1 — RSI ${rsi.toFixed(1)} reached, closing ${tp1Shares} sh (50%)`);
            closeOrderId = res.closeOrderId;
          } catch (err) {
            // Partial close was REJECTED — re-protect the FULL position (stop
            // was already cancelled above → naked otherwise) then alarm + bail.
            let reprotected = false;
            try {
              const rp = await executor.placeStop(pos, pos.shares_remaining ?? pos.shares_total, pos.stopLoss, 'restop');
              pos.brokerStopOrderId = rp.stopOrderId;
              reprotected = true;
            } catch (rpErr) {
              console.log(`\n    🚨 RE-PROTECT FAILED for ${pos.symbol}: ${rpErr.message}`);
            }
            console.log(`\n    🚫 Alpaca TP1 partial close FAILED: ${err.message} — position stays at full size, ${reprotected ? 're-protected' : 'RE-PROTECT FAILED'}, will retry next run`);
            writeLog({ kind: 'tp1_close_fail', symbol: pos.symbol, error: err.message, reprotected });
            tg.alertTp1CloseFailed({
              symbol: pos.symbol, side: pos.side, tp1Shares, sharesTotal: pos.shares_total,
              error: err.message, reprotected, mode: pos.mode || CONFIG.tradingMode,
            }).catch(() => {});
            stillOpen.push(pos);
            positionHandled = true;
            break;
          }

          // Confirm the market close actually filled before re-placing the BE
          // stop on the runner. If it did NOT fill, re-protect the FULL qty.
          const fill = closeOrderId ? await executor.pollOrderFill(closeOrderId) : { filled: false };
          if (!fill.filled) {
            tp1Confirmed = false;
            let reprotected = false;
            try {
              const rp = await executor.placeStop(pos, pos.shares_remaining ?? pos.shares_total, pos.stopLoss, 'restop');
              pos.brokerStopOrderId = rp.stopOrderId;
              reprotected = true;
            } catch (rpErr) {
              console.log(`\n    🚨 RE-PROTECT FAILED for ${pos.symbol}: ${rpErr.message}`);
            }
            const failMsg = `TP1 partial close order ${closeOrderId} did not confirm fill (status ${fill.order?.status || 'unknown'})`;
            console.log(`\n    🚫 ${failMsg} — ${reprotected ? 're-protected full qty' : 'RE-PROTECT FAILED'}, will retry next run`);
            writeLog({ kind: 'tp1_close_fail', symbol: pos.symbol, error: failMsg, reprotected });
            tg.alertTp1CloseFailed({
              symbol: pos.symbol, side: pos.side, tp1Shares, sharesTotal: pos.shares_total,
              error: failMsg, reprotected, mode: pos.mode || CONFIG.tradingMode,
            }).catch(() => {});
            stillOpen.push(pos);
            positionHandled = true;
            break;
          }

          // ── BOOK THE REAL FILL (accounting reconcile, v2.4.1) ──────────────
          // The partial CONFIRMED — book the actual Alpaca filled_avg_price, not
          // the simulated bar close (c.close). This is the same drift the account
          // reconcile fixed retroactively; now we book it right at close time so
          // the record never needs re-pricing. Falls back to the c.close estimate
          // only if the fill price is somehow unavailable, flagged pnl_source.
          tp1CloseOrderId = closeOrderId;   // v2.4.3 — stamped on the position below
          if (Number.isFinite(fill.filledAvgPrice) && fill.filledAvgPrice > 0) {
            exitPrice    = fill.filledAvgPrice;
            tp1Pnl       = realisedPnlFor(pos.side, pos.entry, exitPrice, tp1Shares);
            tp1PnlSource = 'alpaca_fill';
          } else {
            console.log(`\n    ⚠ TP1 fill price unavailable for ${pos.symbol} — booking bar-close estimate $${exitPrice.toFixed(2)}`);
            tp1PnlSource = 'estimate';
          }

          // (3) Fill confirmed — re-place the break-even stop on the RUNNER only.
          try {
            const rp = await executor.placeStop(pos, runnerShares, bePrice, 'stop');
            pos.brokerStopOrderId = rp.stopOrderId;
          } catch (rpErr) {
            // The TP1 half is banked but the runner is now unprotected. Alarm —
            // maintainV2_2BrokerOrders will re-place the missing stop next run,
            // but flag it so it's not silent.
            console.log(`\n    🚨 BE stop placement FAILED for ${pos.symbol} runner: ${rpErr.message} — next run's broker-order maintenance will re-place it`);
            writeLog({ kind: 'be_stop_place_fail', symbol: pos.symbol, error: rpErr.message });
            tg.alertTp1CloseFailed({
              symbol: pos.symbol, side: pos.side, tp1Shares, sharesTotal: pos.shares_total,
              error: `TP1 banked but BE stop failed: ${rpErr.message}`, reprotected: false,
              mode: pos.mode || CONFIG.tradingMode,
            }).catch(() => {});
          }
        }

        // Mutate position in place — KEEPS it open for TP2 scan
        pos.tp1_hit          = true;
        pos.tp1_date         = c.date;
        pos.tp1_price        = exitPrice;
        pos.tp1_shares       = tp1Shares;
        pos.tp1_pnl          = tp1Pnl;
        pos.tp1_reason       = 'rsi50';
        pos.tp1_rsi          = rsi;
        pos.tp1_pnl_source   = tp1PnlSource;   // 'alpaca_fill' | 'estimate'
        // v2.4.3: remember WHICH broker order banked the TP1 half. Its fill is
        // already booked as tp1_pnl, so recordExternalClose must never re-use it
        // to price the runner's exit (consumedExitFillQty subtracts it).
        // Accounting bookkeeping only — does not touch the close mechanics.
        if (tp1CloseOrderId) pos.tp1_close_order_id = tp1CloseOrderId;
        pos.shares_remaining = runnerShares;
        // BE stop — locks ≥ 1¢/share profit (computed above as bePrice).
        pos.stopLoss  = bePrice;
        // Book TP1 partial P&L immediately so account compounds. Re-derived from
        // records + this in-flight TP1 partial (pos not yet in stillOpen, so pass
        // it in). Never a running counter → can't carry a phantom.
        const acctAfterTp1 = updateAccount(null, {
          closed: closedPositions,
          open: stillOpen.includes(pos) ? stillOpen : [...stillOpen, pos],
        });
        appendTrade([
          c.date,
          (new Date()).toISOString().slice(11, 19),
          'V2.1/TP1',
          pos.symbol,
          `${pos.side}-tp1`,
          tp1Shares,
          pos.entry.toFixed(2),
          pos.stopLoss,
          (tp1Shares * exitPrice).toFixed(2),
          tp1Pnl,
          ((tp1Pnl / acctAfterTp1.accountUsd) * 100).toFixed(2),
          pos.signalDate,
          `TP1-${pos.id}`,
          pos.mode || CONFIG.tradingMode,
          `${BOT_NAME} v2.1`,
        ].join(','));

        tg.alertExitFired({
          symbol: pos.symbol, side: pos.side, exitPrice,
          exitReason: 'tp1_rsi50', realizedPnl: tp1Pnl,
          accountAfter: acctAfterTp1.accountUsd,
          mode: pos.mode || CONFIG.tradingMode,
        }).catch(() => {});

        console.log(`✓ TP1 PARTIAL — RSI ${rsi.toFixed(1)} on ${c.date}: sold ${tp1Shares}/${pos.shares_total} sh @ $${exitPrice.toFixed(2)}`);
        console.log(`    TP1 P&L     : +$${tp1Pnl}   Account: $${acctAfterTp1.accountUsd.toFixed(2)}`);
        console.log(`    Runner      : ${pos.shares_remaining} sh, stop -> $${pos.stopLoss} (break-even)`);
        // KEEP WALKING — TP2 may fire later in this same scan
        continue;
      }

      // ── Branch B: TP1 already hit — scan for TP2 ─────────────────────────
      const ma50  = sma50Arr  ? sma50Arr[i]  : null;
      const ma200 = sma200Arr ? sma200Arr[i] : null;

      let tp2Hit       = false;
      let tp2Reason    = null;
      let tp2ExitPrice = null;

      // FIX 2026-06-02 — SMA touch semantics: previous logic ONLY checked STRADDLE
      // (low ≤ sma ≤ high). That correctly catches the common case where a bar's
      // range includes the SMA, but MISSES gap-throughs where the previous bar
      // closed on one side of the SMA and the current bar opens fully on the other
      // side (e.g., GOOG short runner with SMA50 at $347 and current price $358 —
      // if GOOG gaps down to open at $345 and bounces to close $349, bar high $349
      // is BELOW SMA $347 wait that's above, let me redo — if SMA $347 and bar
      // opens $343, low $341, high $345, close $344, bar entirely below SMA but
      // previous close was $358 ABOVE SMA → crossed via gap, straddle misses).
      //
      // Helper checks BOTH cases:
      //   1. Straddle: bar's range includes the SMA (the common in-bar touch)
      //   2. Gap-cross: prevClose was on one side, currClose on the other (the gap case)
      // Audit task #11 MED finding resolved.
      const prevClose = i > 0 ? candles[i - 1].close : null;
      const crossedSMA = (ma) =>
        ma !== null && (
          (c.low <= ma && ma <= c.high) ||                                    // touched the SMA in-bar
          (prevClose !== null && Math.sign(prevClose - ma) !== Math.sign(c.close - ma))  // gapped across SMA
        );
      if (pos.side === 'long') {
        // V2.2: BE stop is broker-managed → skip the daily-poll BE check, keep SMA exits
        if (!posIsV2_2 && c.low <= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (crossedSMA(ma50)) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (crossedSMA(ma200)) {
          tp2Hit = true; tp2Reason = 'sma200_touch'; tp2ExitPrice = ma200;
        }
      } else { // short
        // V2.2: BE stop is broker-managed → skip the daily-poll BE check, keep SMA exits
        if (!posIsV2_2 && c.high >= pos.stopLoss) {
          tp2Hit = true; tp2Reason = 'breakeven_stop'; tp2ExitPrice = pos.stopLoss;
        } else if (crossedSMA(ma50)) {
          tp2Hit = true; tp2Reason = 'sma50_touch';  tp2ExitPrice = ma50;
        } else if (crossedSMA(ma200)) {
          tp2Hit = true; tp2Reason = 'sma200_touch'; tp2ExitPrice = ma200;
        }
      }

      // Timeout check (only if no other exit fired)
      if (!tp2Hit && tp1IdxInCandles >= 0) {
        const barsSinceTp1 = i - tp1IdxInCandles;
        if (barsSinceTp1 >= CONFIG.tp2TimeoutDays) {
          tp2Hit       = true;
          tp2Reason    = 'timeout';
          tp2ExitPrice = c.close;
        }
      }

      if (!tp2Hit) continue;

      // TP2 fires — close the remaining 50%. tp2ExitPrice/tp2Pnl start as the
      // SIMULATED trigger-bar price (SMA touch / c.close); after the real Alpaca
      // runner-close confirms (pollOrderFill below) they are OVERWRITTEN with the
      // actual filled_avg_price so the booked P&L matches the broker, not the bar.
      // tp2PnlSource records which was used. ACCOUNTING ONLY — the TP2 triggers
      // (SMA50/200/BE/timeout) are unchanged (instructor rule untouched).
      // ── v2.6.0: market CLOSED → queue the runner exit for the open ────────
      // THIS IS THE IBM 2026-09-09 CASE. The SMA50 touch ripened in the last
      // ~35 minutes of the session; the next run landed 21:06 UTC and
      // closePosition() threw `Market closed`. Now the runner's exit is handed
      // to the broker to execute at the next open — exactly what Alan did by
      // hand (cancel the stop, queue a market sell, filled 2 @ $238.39).
      if (shouldQueueExitForOpen(executor)) {
        await queueExitForOpen({
          pos, executor,
          qty: pos.shares_remaining,
          isFullClose: true,
          reason: `tp2_${tp2Reason}`,
          booking: {
            trigger_date:   c.date,
            trigger_rsi:    rsi,
            estimate_price: tp2ExitPrice,
            tp2_reason:     tp2Reason,
            exit_level:     tp2Reason,
            exit_strategy:  'v2.1-tp1+tp2',
          },
        });
        stillOpen.push(pos);
        positionHandled = true;
        break;
      }

      let tp2Pnl = realisedPnlFor(pos.side, pos.entry, tp2ExitPrice, pos.shares_remaining);
      let tp2PnlSource = 'estimate';

      // ── CANCEL-FIRST TP2 runner-close (v2.2.6 fix) ──────────────────────
      // ROOT CAUSE (PYPL 12sh BE $41.41, ADBE 2sh BE $200.79; 2026-07-13→16):
      // after TP1 banks, the v2.2 broker design leaves a full-RUNNER GTC BE
      // stop resting (pos.brokerStopOrderId, client_order_id `...-stop-<ts>`).
      // Alpaca "holds" the runner shares against it, so the TP2 full close
      // (DELETE /v2/positions/SYM) returned `insufficient qty available
      // (available: 0)` EVERY run. The old catch just logged tp2_close_fail and
      // re-queued the position → identical 5-day-style silent retry loop the
      // v2.2.5 TP1 fix cured on Branch A. (closePosition's own cleanup only
      // cancels orders ending in the literal `-stop`, but placeStop/maintain
      // append a timestamp, so it never matched — hence the leak.)
      //
      // Correct order of operations (mirrors the v2.2.5 TP1 cancel-first fix):
      //   (1) CANCEL the resting BE/runner broker stop (brokerStopOrderId + any
      //       lingering -stop) and WAIT for zero open orders to RELEASE the
      //       runner shares.
      //   (2) Submit the runner close and POLL that it actually FILLS.
      //   (3) TP2 fully closes the runner → no re-stop needed on SUCCESS.
      //   (*) On a REJECTED or UNCONFIRMED close, do NOT leave the runner naked:
      //       re-place a protective stop on the remaining qty + fire the LOUD
      //       alarm + do NOT record the close (retry next run).
      let tp2Confirmed = true;   // true when there's no executor (dry_run) OR the fill confirmed
      if (executor) {
        // (1) Release the runner shares held by the resting BE broker stop(s).
        try {
          if (pos.brokerStopOrderId) {
            await executor.cancelOrderById(pos.brokerStopOrderId);
          }
          // Belt-and-braces: cancel ANY lingering -stop order on the symbol
          // (id may have rotated via maintainV2_2BrokerOrders across runs).
          const lingeringStop = await findOpenOrder(executor.client, pos.symbol, '-stop');
          if (lingeringStop) await executor.cancelOrderById(lingeringStop.id);
          // v2.4.2 SWEEP — also cancel any MANUAL/external order on this symbol (e.g. a
          // break-even stop placed via the Alpaca UI, no SID client_order_id) so it
          // can't hold the runner shares + hang waitForNoOpenOrders. Symbol-scoped only.
          await executor.cancelAllOpenOrders(pos.symbol);
          // Wait for Alpaca to actually free the held shares before the close.
          await executor.waitForNoOpenOrders(pos.symbol);
        } catch (err) {
          console.log(`\n    ⚠ Could not cancel resting BE stop for ${pos.symbol} before TP2: ${err.message} — attempting close anyway`);
        }

        // (2) Submit the runner close and CONFIRM the fill.
        let closeOrderId = null;
        try {
          const res = await executor.closePosition(pos, `V2.1 TP2 (${tp2Reason}) on ${c.date}`);
          closeOrderId = res?.closeOrderId ?? null;
        } catch (err) {
          // Runner close was REJECTED — the BE stop was already cancelled above
          // so re-protect the runner qty then alarm + retry next run.
          let reprotected = false;
          try {
            const rp = await executor.placeStop(pos, pos.shares_remaining, pos.stopLoss, 'restop');
            pos.brokerStopOrderId = rp.stopOrderId;
            reprotected = true;
          } catch (rpErr) {
            console.log(`\n    🚨 RE-PROTECT FAILED for ${pos.symbol} runner: ${rpErr.message}`);
          }
          console.log(`\n    🚫 Alpaca TP2 close FAILED: ${err.message} — runner stays open, ${reprotected ? 're-protected' : 'RE-PROTECT FAILED'}, will retry next run`);
          writeLog({ kind: 'tp2_close_fail', symbol: pos.symbol, reason: tp2Reason, error: err.message, reprotected });
          tg.alertTp2CloseFailed({
            symbol: pos.symbol, side: pos.side, runnerShares: pos.shares_remaining,
            reason: tp2Reason, error: err.message, reprotected, mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});
          stillOpen.push(pos);
          positionHandled = true;
          break;
        }

        // Confirm the market close actually filled before booking the trade. If
        // it did NOT fill, re-protect the runner and retry next run.
        const fill = closeOrderId ? await executor.pollOrderFill(closeOrderId) : { filled: false };
        if (!fill.filled) {
          tp2Confirmed = false;
          let reprotected = false;
          try {
            const rp = await executor.placeStop(pos, pos.shares_remaining, pos.stopLoss, 'restop');
            pos.brokerStopOrderId = rp.stopOrderId;
            reprotected = true;
          } catch (rpErr) {
            console.log(`\n    🚨 RE-PROTECT FAILED for ${pos.symbol} runner: ${rpErr.message}`);
          }
          const failMsg = `TP2 runner close order ${closeOrderId} did not confirm fill (status ${fill.order?.status || 'unknown'})`;
          console.log(`\n    🚫 ${failMsg} — ${reprotected ? 're-protected runner' : 'RE-PROTECT FAILED'}, will retry next run`);
          writeLog({ kind: 'tp2_close_fail', symbol: pos.symbol, reason: tp2Reason, error: failMsg, reprotected });
          tg.alertTp2CloseFailed({
            symbol: pos.symbol, side: pos.side, runnerShares: pos.shares_remaining,
            reason: tp2Reason, error: failMsg, reprotected, mode: pos.mode || CONFIG.tradingMode,
          }).catch(() => {});
          stillOpen.push(pos);
          positionHandled = true;
          break;
        }

        // ── BOOK THE REAL FILL (accounting reconcile, v2.4.1) ──────────────
        // The runner close CONFIRMED — book the actual Alpaca filled_avg_price,
        // not the simulated SMA/bar price (tp2ExitPrice). This is exactly the
        // drift the reconcile fixed retroactively (e.g. PYPL/ADBE runners booked
        // at the historical SMA50 touch but really filled weeks later at the
        // current market price). Falls back to the estimate only if the fill
        // price is unavailable, flagged pnl_source.
        if (Number.isFinite(fill.filledAvgPrice) && fill.filledAvgPrice > 0) {
          tp2ExitPrice = fill.filledAvgPrice;
          tp2Pnl       = realisedPnlFor(pos.side, pos.entry, tp2ExitPrice, pos.shares_remaining);
          tp2PnlSource = 'alpaca_fill';
        } else {
          console.log(`\n    ⚠ TP2 fill price unavailable for ${pos.symbol} — booking bar/SMA estimate $${tp2ExitPrice.toFixed(2)}`);
          tp2PnlSource = 'estimate';
        }
      }
      // TP2 close confirmed (or dry_run) — fall through to book the trade.
      void tp2Confirmed;

      const totalPnl     = parseFloat(((pos.tp1_pnl || 0) + tp2Pnl).toFixed(2));
      const outcome      = totalPnl >= 0 ? 'WIN' : 'LOSS';
      const icon         = totalPnl >= 0 ? '✅' : '❌';

      // Combined pnl_source: alpaca_fill only if BOTH legs were real fills.
      const tp1Src = pos.tp1_pnl_source || 'estimate';
      const combinedSource = (tp1Src === 'alpaca_fill' && tp2PnlSource === 'alpaca_fill')
        ? 'alpaca_fill' : 'estimate';

      const tp2ClosedRec = {
        ...pos,
        tp2_date: c.date,
        tp2_price: tp2ExitPrice,
        tp2_shares: pos.shares_remaining,
        tp2_pnl: tp2Pnl,
        tp2_reason: tp2Reason,
        tp2_rsi: rsi,
        total_pnl: totalPnl,
        exit_strategy: 'v2.1-tp1+tp2',
        pnl_source: combinedSource,
        mode: pos.mode || CONFIG.tradingMode,
        // v2.0-compat fields the dashboard reads
        exitLevel: tp2Reason,
        exitPrice: tp2ExitPrice,
        exitRsi: rsi,
        closeDate: c.date,
        realizedPnl: totalPnl,
        outcome,
      };
      // Push the closed record FIRST, then re-derive the ledger from records
      // (never a running counter — can't carry a phantom). pos is being fully
      // closed here (not re-added to stillOpen), so exclude it from the open set.
      closedPositions.push(tp2ClosedRec);
      const acctAfterTp2 = updateAccount(null, {
        closed: closedPositions,
        open: stillOpen.filter(p => p !== pos),
      });
      tp2ClosedRec.accountAfter = acctAfterTp2.accountUsd;

      appendTrade([
        c.date,
        (new Date()).toISOString().slice(11, 19),
        `V2.1/TP2-${tp2Reason}`,
        pos.symbol,
        `${pos.side}-tp2`,
        pos.shares_remaining,
        pos.entry.toFixed(2),
        pos.stopLoss,
        (pos.shares_remaining * tp2ExitPrice).toFixed(2),
        tp2Pnl,
        ((tp2Pnl / acctAfterTp2.accountUsd) * 100).toFixed(2),
        pos.signalDate,
        `TP2-${pos.id}`,
        pos.mode || CONFIG.tradingMode,
        `${BOT_NAME} v2.1`,
      ].join(','));

      tg.alertExitFired({
        symbol: pos.symbol, side: pos.side, exitPrice: tp2ExitPrice,
        exitReason: `tp2_${tp2Reason}`, realizedPnl: tp2Pnl,
        accountAfter: acctAfterTp2.accountUsd,
        mode: pos.mode || CONFIG.tradingMode,
      }).catch(() => {});

      const labels = {
        sma50_touch:    '50d SMA touched',
        sma200_touch:   '200d SMA touched',
        breakeven_stop: 'break-even stop hit',
        timeout:        `${CONFIG.tp2TimeoutDays}-day timeout`,
      };
      console.log(`${icon} TP2 FULL CLOSE — ${labels[tp2Reason] || tp2Reason} @ $${tp2ExitPrice.toFixed(2)} on ${c.date}`);
      console.log(`    TP2 P&L     : ${tp2Pnl >= 0 ? '+' : ''}$${tp2Pnl}   Total trade P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl}`);
      console.log(`    Account now : $${acctAfterTp2.accountUsd.toFixed(2)}`);
      numClosed++;
      positionHandled = true;
      break;
    }

    if (!positionHandled) {
      // Still open — report current status
      const lastRsi    = rsiArr[rsiArr.length - 1];
      const lastClose  = closes[closes.length - 1];
      if (pos.tp1_hit) {
        const lastSma50  = sma50Arr  ? sma50Arr[sma50Arr.length - 1]   : null;
        const lastSma200 = sma200Arr ? sma200Arr[sma200Arr.length - 1] : null;
        const sma50Str   = lastSma50  != null ? `$${lastSma50.toFixed(2)}`  : '—';
        const sma200Str  = lastSma200 != null ? `$${lastSma200.toFixed(2)}` : '—';
        console.log(`runner open (RSI ${lastRsi?.toFixed(1) ?? '—'}, ${pos.shares_remaining} sh @ last $${lastClose?.toFixed(2)}, SMA50 ${sma50Str}, SMA200 ${sma200Str}, BE stop $${pos.stopLoss})`);
      } else {
        console.log(`still open (RSI ${lastRsi?.toFixed(1) ?? '—'}, waiting for RSI 50)`);
      }
      stillOpen.push(pos);
    }
  }

  saveOpenPositions(stillOpen);
  saveClosedPositions(closedPositions);
  console.log(`  ── ${numClosed} closed this run, ${stillOpen.length} still open ──`);

  // MANUAL-WATCH Telegram reminder — one consolidated message per run so the
  // trader is nudged to eyeball support on bullish-asset short runners.
  if (manualWatchList.length) {
    await tg.alertManualWatch({ positions: manualWatchList, mode: CONFIG.tradingMode }).catch(() => {});
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // Load current compounded account balance — overrides the static CONFIG value.
  // This ensures every run sizes positions against the CURRENT account value,
  // compounding gains (or absorbing losses) automatically over time.
  const account = loadAccount();
  CONFIG.accountUsd = account.accountUsd;

  const growthPct  = ((account.accountUsd - account.startingUsd) / account.startingUsd * 100).toFixed(2);
  const growthSign = growthPct >= 0 ? '+' : '';

  console.log(`\n══ SID Bot run ${new Date().toISOString()} ══`);
  console.log(`Account : $${account.accountUsd.toFixed(2)}  (started $${account.startingUsd}  ${growthSign}${growthPct}%  ${account.tradeCount} closed trades)`);
  console.log(`Sizing  : ${(CONFIG.riskPct * 100).toFixed(1)}% risk/trade  Max position: ${(CONFIG.maxPositionPct * 100).toFixed(0)}% = $${(CONFIG.accountUsd * CONFIG.maxPositionPct).toFixed(2)}`);
  console.log(`Max open: ${CONFIG.maxOpenPositions}  Earnings window: ${CONFIG.earningsWindow} days  Mode: ${CONFIG.tradingMode.toUpperCase()}`);
  console.log(`Symbols : ${WATCHLIST.length} stocks/ETFs`);
  console.log(`─`.repeat(60));

  // ── Alpaca executor — created only when SID_TRADING_MODE != dry_run ──────
  // Returns null in dry_run mode. Returns a paper/live executor otherwise.
  // From here on, "executor" is the single touchpoint for any order action.
  const executor = createExecutor();

  if (executor) {
    const preflight = await executor.preflight();
    if (!preflight.ok) {
      console.error(`\n🚫 Alpaca preflight failed (${preflight.reason}): ${preflight.detail}`);
      console.error('   Aborting run to avoid placing orders in an unknown state.');
      writeLog({ kind: 'preflight_fail', reason: preflight.reason, detail: preflight.detail });
      return;
    }

    // ── v2.4.3: refresh the REAL Alpaca account snapshot EVERY run ──────────
    // The preflight above already fetched the account, so this is free. Before
    // v2.4.3 the only writer was `reconcile-account.js --write`, so the
    // dashboard headline sat frozen on the 2026-07-17 equity for 7 weeks.
    // Mode-segregated (paper vs live get different files) and best-effort — a
    // write failure can never abort the run or change any trading decision.
    const acctSnapshot = writeAlpacaSnapshot({
      equity: preflight.equity,
      mode:   CONFIG.tradingMode,
    });
    if (acctSnapshot) {
      console.log(`[Alpaca] Account snapshot refreshed: equity $${acctSnapshot.equity.toFixed(2)}  netPnl ${acctSnapshot.netPnl >= 0 ? '+' : '-'}$${Math.abs(acctSnapshot.netPnl).toFixed(2)} on $${acctSnapshot.startingEquity.toFixed(2)} base (${acctSnapshot.mode})`);
    }

    // V2.2: size off the internal ledger, NOT Alpaca equity. The internal
    // ledger represents the compounding $30k target equity for live; sizing
    // against Alpaca's actual paper equity ($100k) inflates positions to
    // ~3× what they should be. Internal-ledger sizing keeps paper positions
    // representative of what the live account will actually do.
    if (preflight.equity > 0) {
      console.log(`[Alpaca] Broker equity: $${preflight.equity.toFixed(2)}  (informational — NOT used for sizing)`);
      console.log(`[Alpaca] Buying pwr  : $${preflight.buyingPower.toFixed(2)}`);
      console.log(`[Alpaca] Market open : ${preflight.marketOpen ? 'YES' : 'NO'}  next open: ${preflight.nextOpen}`);
      console.log(`[Sizing] V2.2 internal-ledger basis: $${CONFIG.accountUsd.toFixed(2)} (1% risk = $${(CONFIG.accountUsd * CONFIG.riskPct).toFixed(2)})`);

      // PRE-LIVE GUARD (spec §7): when going live, halt if broker equity
      // diverges from internal ledger by > 10% — catches funding gaps or
      // residual paper-account contamination before any real-money entry.
      if (CONFIG.tradingMode === 'live') {
        const divergence = Math.abs(preflight.equity - CONFIG.accountUsd) / CONFIG.accountUsd;
        if (divergence > 0.10) {
          console.error(`\n🚫 LIVE GUARD — broker equity $${preflight.equity.toFixed(2)} diverges from ledger $${CONFIG.accountUsd.toFixed(2)} by ${(divergence*100).toFixed(1)}% (>10%).`);
          console.error('   Refusing to submit entries. Reconcile the ledger before re-running.');
          writeLog({ kind: 'live_guard_halt', brokerEquity: preflight.equity, ledger: CONFIG.accountUsd, divergencePct: divergence });
          try { await tg.sendMessage(`🚫 SID LIVE GUARD halt — broker $${preflight.equity.toFixed(0)} vs ledger $${CONFIG.accountUsd.toFixed(0)} (${(divergence*100).toFixed(1)}% divergence). No entries until reconciled.`); } catch {}
          return;
        }
      }
    }

    if (!preflight.marketOpen) {
      console.log(`\n⏸  Market is closed — will read positions but place no orders this run.`);
    }

    // ── v2.6.0: RECONCILE QUEUED (for-the-open) EXITS — FIRST, BEFORE SYNC ──
    // ⚠ THE ORDERING HERE IS LOAD-BEARING. syncPositions() below compares
    // Alpaca's position list to local state and routes any difference through
    // recordExternalClose(). If a queued exit filled at the open and syncPositions
    // saw it FIRST, the same leg would be booked twice — once as an "external"
    // close and once by the reconcile. Reconciling first leaves syncPositions
    // looking at consistent state (a filled TP1 partial has already had
    // shares_remaining reduced; a filled full close is already out of
    // open-positions). Do not move this below the sync.
    try {
      await reconcilePendingExits(executor);
    } catch (err) {
      console.error(`[Alpaca] Queued-exit reconcile failed: ${err.message} — pending exits are left untouched and retried next run`);
      writeLog({ kind: 'pending_exit_reconcile_fail', error: err.message });
    }

    // Sync local open positions against Alpaca's authoritative view.
    // Any positions Alpaca no longer has (because a stop filled overnight, say)
    // get pulled out of open-positions-sid.json. The local position monitor
    // (checkPositions) still runs for RSI 50 evaluation on what remains.
    try {
      const localOpen = loadOpenPositions();
      const { stillOpen, closedExternally, partialClosed } = await executor.syncPositions(localOpen);

      // ── Handle partial external closes (FIX task #25, 2026-06-05) ─────
      // Bot used to silently keep local qty unchanged when Alpaca showed a
      // smaller position. Now: detect, record the partial close in the journal,
      // and update local qty to match Alpaca truth.
      if (partialClosed.length) {
        console.log(`[Alpaca] Reconciliation: ${partialClosed.length} partial close(s) detected`);
        for (const event of partialClosed) {
          const { pos, prevQty, newQty, deltaShares } = event;
          console.log(`           - ${pos.symbol} ${pos.side}: ${prevQty} → ${newQty} (${deltaShares} sh closed externally)`);
          await recordExternalClose({
            pos,
            sharesClosed:  deltaShares,
            alpacaClient:  executor.client,
            reasonKind:    'partial_external_fill',
            isFullClose:   false,
          });

          // ── V2.2 TP1 fill detection ──────────────────────────────────────
          // If this partial close was the resting TP1 limit firing on a V2.2
          // position, mark tp1_hit + populate tp1_* fields on the live record
          // in stillOpen. maintainV2_2BrokerOrders on the next checkPositions
          // cycle will then refresh the broker stop to BE for the runner.
          //
          // Heuristic: posIsV2_2 + the partial close is ~50% of shares_total
          // (matches CONFIG.tp1Portion). Robust for paper-validation purposes;
          // would be tightened to client_order_id matching for live.
          const livePos = stillOpen.find(p => p.id === pos.id);
          if (livePos && isV2_2Position(livePos) && !livePos.tp1_hit) {
            const expectedTp1Qty = Math.floor(livePos.shares_total * CONFIG.tp1Portion);
            const tolerance = Math.max(1, Math.floor(expectedTp1Qty * 0.10)); // 10% slack on share count
            if (Math.abs(deltaShares - expectedTp1Qty) <= tolerance) {
              // Pull the best-guess fill price from Alpaca for the tp1_price field
              let tp1FillPrice = livePos.entry;  // safe fallback
              try {
                const orders = await executor.client.listOrders({ symbols: pos.symbol, status: 'closed', limit: 50 });
                const exitSide = livePos.side === 'long' ? 'sell' : 'buy';
                const fills = (orders || []).filter(o =>
                  o.side === exitSide &&
                  o.status === 'filled' &&
                  parseFloat(o.filled_qty || 0) > 0 &&
                  typeof o.client_order_id === 'string' &&
                  o.client_order_id.includes('-tp1')
                );
                if (fills.length > 0) {
                  // Weighted-avg of -tp1 fills
                  let tq = 0, tc = 0;
                  for (const f of fills) {
                    const q = parseFloat(f.filled_qty);
                    const p = parseFloat(f.filled_avg_price);
                    tq += q;
                    tc += q * p;
                  }
                  if (tq > 0) tp1FillPrice = tc / tq;
                }
              } catch (_) { /* fall back to entry */ }
              const tp1Pnl = livePos.side === 'long'
                ? (tp1FillPrice - livePos.entry) * deltaShares
                : (livePos.entry - tp1FillPrice) * deltaShares;
              livePos.tp1_hit    = true;
              livePos.tp1_date   = todayString();
              livePos.tp1_price  = parseFloat(tp1FillPrice.toFixed(4));
              livePos.tp1_shares = deltaShares;
              livePos.tp1_pnl    = parseFloat(tp1Pnl.toFixed(2));
              livePos.tp1_reason = 'rsi50_intraday';
              livePos.stopLoss   = parseFloat(livePos.entry.toFixed(2));  // BE for runner
              console.log(`  [V2.2] TP1 fill detected on ${livePos.symbol}: ${deltaShares}sh @ ~$${tp1FillPrice.toFixed(2)} → marking tp1_hit, stop migrates to BE next cycle`);
              try {
                await tg.sendMessage(
                  `🎯 <b>SID V2.2 TP1 filled</b>\n\n` +
                  `${livePos.symbol} ${livePos.side.toUpperCase()} ${deltaShares}sh @ $${tp1FillPrice.toFixed(2)}\n` +
                  `Entry: $${livePos.entry.toFixed(2)}  P&amp;L: ${tp1Pnl >= 0 ? '+' : ''}$${tp1Pnl.toFixed(2)}\n` +
                  `Runner ${livePos.shares_remaining}sh — stop migrates to BE this run.`
                );
              } catch (_) {}
            }
          }
        }
      }

      // ── Handle full external closes (FIX task #26, 2026-06-05) ────────
      // Bot used to log to safety log + remove from open-positions but never
      // write to closed-positions / trades.csv / sid-account. Now: full
      // journal update.
      if (closedExternally.length) {
        console.log(`[Alpaca] Reconciliation: ${closedExternally.length} position(s) closed externally (stop fills?)`);
        for (const pos of closedExternally) {
          const qtyClosed = pos.shares_remaining ?? pos.shares;
          console.log(`           - ${pos.symbol} ${pos.side} ${qtyClosed}sh (entry $${pos.entry})`);
          await recordExternalClose({
            pos,
            sharesClosed:  qtyClosed,
            alpacaClient:  executor.client,
            reasonKind:    'full_external_fill',
            isFullClose:   true,
          });
        }
      }

      if (partialClosed.length || closedExternally.length) {
        saveOpenPositions(stillOpen);
      }
    } catch (err) {
      console.error(`[Alpaca] Position sync failed: ${err.message} — continuing with local data`);
      writeLog({ kind: 'sync_fail', error: err.message });
    }
  }

  // ── Weekend guard (stocks/ETFs only — markets are closed Sat/Sun) ─────────
  // Any signal fired on a weekend is driven by Friday's stale close price.
  // False ENTRIES are guaranteed — which is all this guard ever protected
  // against. Before v2.6.0 it `return`ed here, BEFORE checkPositions, so a
  // position was not even LOOKED AT at the weekend. That is a real hole now that
  // exits can be queued for the open: Friday 19:30 ET is Saturday 00:30 UTC, so
  // an exit that ripened on Friday's completed bar could not be queued until
  // Monday. v2.6.0 keeps the guard on the ENTRY SCAN and lets position
  // management (reconcile + queue-for-Monday's-open) run. Revert with
  // SID_WEEKEND_EXIT_QUEUE=false.
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  const isWeekendUtc = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekendUtc && !CONFIG.weekendExitQueue) {
    const dayName = dayOfWeek === 6 ? 'Saturday' : 'Sunday';
    console.log(`\n🚫 Weekend guard (hard, SID_WEEKEND_EXIT_QUEUE=false) — ${dayName} UTC. Stock markets closed, no action taken.`);
    console.log(`   Open positions will be reviewed at Monday market open.`);
    console.log(`\n══ SID run complete ══`);
    return;
  }
  if (isWeekendUtc) {
    const dayName = dayOfWeek === 6 ? 'Saturday' : 'Sunday';
    console.log(`\n🗓  Weekend (${dayName} UTC) — EXIT MANAGEMENT ONLY. No entry scan (a weekend signal is Friday's stale close). A ripe exit is queued for Monday's open.`);
  }

  // Step 0: Check open positions for RSI-50 exits
  await checkPositions(executor);

  // ── v2.6.0 exits-only cycle (SID_EXITS_ONLY=true) ─────────────────────────
  // Used by the Railway cron runner's cheap out-of-hours cycle: positions are
  // reconciled + managed (so a late-ripening exit still reaches the open) but the
  // 112-ticker Yahoo entry scan is skipped, because an entry would be refused
  // out-of-hours anyway. Nothing about WHICH trades fire changes — an entry is
  // only ever placed by an in-hours run.
  if (isWeekendUtc || CONFIG.exitsOnly) {
    console.log(`\n⏭  Entry scan skipped (${isWeekendUtc ? 'weekend' : 'SID_EXITS_ONLY=true'}) — positions were still managed above.`);
    console.log(`\n══ SID run complete (exit management only) ══`);
    return;
  }

  // Step 1: Check if we're already at the position limit
  const openPositions = loadOpenPositions();
  if (openPositions.length >= CONFIG.maxOpenPositions) {
    console.log(`\n⚠️  At max open positions (${openPositions.length}/${CONFIG.maxOpenPositions}) — no new entries this run`);
    console.log(`\n══ SID run complete ══`);
    return;
  }

  // Step 2: Check daily new-entry limit
  if (countTodayTrades() >= CONFIG.maxPerDay) {
    console.log(`\n⚠️  Daily entry limit reached (${CONFIG.maxPerDay}) — no new entries today`);
    console.log(`\n══ SID run complete ══`);
    return;
  }

  // Step 2.5: VIX gate (v1.7) — skip new entries on high-fear days
  // The gate blocks new ARMing only. Open positions keep running (with their
  // stops). If VIX data fetch fails, we trade normally (fail-open).
  const vixSnap = await fetchVixYesterdayClose();
  if (vixSnap) {
    if (vixSnap.vix >= VIX_GATE_THRESHOLD) {
      console.log(`\n🔴 VIX gate ACTIVE — VIX closed at ${vixSnap.vix} on ${vixSnap.date} (threshold ${VIX_GATE_THRESHOLD})`);
      console.log(`   Skipping new entries today. Existing positions continue.`);
      writeLog({ kind: 'vix_gate_active', vix: vixSnap.vix, date: vixSnap.date });
      // Send Telegram alert (best-effort)
      tg.sendMessage(
        `🔴 <b>SID VIX gate ACTIVE</b>\n\n`
        + `VIX closed at <b>${vixSnap.vix}</b> on ${vixSnap.date} (threshold ${VIX_GATE_THRESHOLD}).\n\n`
        + `No new entries today. Open positions continue normally.\n\n`
        + `<i>Gate auto-clears when VIX drops below ${VIX_GATE_THRESHOLD}.</i>`
      ).catch(() => {});
      console.log(`\n══ SID run complete (VIX gate) ══`);
      return;
    } else {
      console.log(`\n✓ VIX gate clear — VIX at ${vixSnap.vix} (< ${VIX_GATE_THRESHOLD})`);
    }
  }

  // Track symbols already open (don't double-enter)
  const openSymbols = new Set(openPositions.map(p => p.symbol));
  let newEntriesThisRun = 0;

  // Step 3: Scan watchlist for entry signals
  console.log('\n── Scanning watchlist ──');

  for (const symbol of WATCHLIST) {
    if (newEntriesThisRun >= CONFIG.maxPerDay) break;
    if (openSymbols.has(symbol)) {
      console.log(`  ${symbol.padEnd(6)} → Already open — skipping`);
      continue;
    }

    process.stdout.write(`  ${symbol.padEnd(6)} → `);

    // Fetch daily candles
    // BUG-FIX 2026-05-21: was `fetchDailyCandles(symbol)` (default '6mo'),
    // which resamples to ~26-28 weekly bars — below the weekly-direction
    // check's required 30.
    // BUG-FIX 2026-06-28: bumped 2y → 5y. The v2.3 entry overhaul added a
    // weekly SMA50/200 ARM gate which needs ≥200 weekly bars (~4y). With only
    // 2y (~104 weekly bars) that gate silently defaults to TRUE (inert), making
    // the live bot LOOSER than the validated backtest — it would arm longs in
    // weekly downtrends the backtest rejects. 5y (~260 weekly bars) seasons the
    // weekly SMA200/RSI/MACD so detectEntrySignal matches the backtest live.
    let candles;
    try {
      candles = await fetchDailyCandles(symbol, '5y');
      await new Promise(r => setTimeout(r, 300)); // Polite rate limit for Yahoo
    } catch (err) {
      console.log(`Data unavailable (${err.message})`);
      writeLog({ symbol, signal: null, reason: `Data fetch failed: ${err.message}` });
      continue;
    }

    if (candles.length < 40) {
      console.log('Not enough history');
      continue;
    }

    // Detect entry signal
    const signal = detectEntrySignal(candles);
    if (!signal) {
      const closes = candles.map(c => c.close);
      const rsiArr = calcRSI(closes);
      const rsiNow = rsiArr[rsiArr.length - 1];
      console.log(`No signal (RSI ${rsiNow?.toFixed(1) ?? '—'})`);
      writeLog({ symbol, signal: null, reason: 'No RSI/MACD entry alignment' });
      continue;
    }

    // V2 signal-detector can return {signal: null, rejectReason} for no-go zone
    if (!signal.signal && signal.rejectReason) {
      console.log(`🚫 ${signal.rejectReason}`);
      writeLog({ symbol, signal: null, reason: signal.rejectReason });
      continue;
    }

    // V2 AUTO/HUMAN tier routing
    if (!AUTO_APPROVED_TICKERS.has(symbol)) {
      console.log(`⚠️  HUMAN-tier signal (${symbol} ${signal.signal.toUpperCase()}) — Telegram approval not yet wired (v2.1). Skipping.`);
      writeLog({
        symbol,
        signal: signal.signal,
        reason: `HUMAN-tier: requires Telegram approval (deferred to v2.1)`,
        v2_tier: 'HUMAN',
        proposed_entry: signal.entry,
        proposed_stop: signal.stopLoss,
        proposed_rsi: signal.rsiAtEntry,
      });
      continue;
    }

    // ── V2.2.4 SHORT APPROVAL GATE ────────────────────────────────────────
    // Pre-entry discipline overlay: a mechanical SHORT on a long-term-bullish
    // asset (price>SMA200 AND SMA50>SMA200) is NOT auto-fired. Instead we log it
    // + Telegram-alert it as an approval-required candidate, and Alan fires it
    // himself at the right level (e.g. into a supply zone) via the manual
    // one-shot flow (manual-trade.js / sid-manual-trade.yml). This does NOT
    // touch any canon rule (RSI 30/70, MACD alignment, RSI-50 exit) — it only
    // changes what the LIVE bot auto-executes. The v2.2.x backtests still fire
    // these shorts mechanically, so live results deliberately diverge from the
    // pure backtest here. Longs + non-bullish-asset shorts are UNAFFECTED.
    if (CONFIG.shortApprovalGate && signal.signal === 'short') {
      const ltb = longTermBullish(candles);
      if (ltb.bullish) {
        console.log(`⏸  MANUAL-WATCH SHORT — approval required, not auto-fired (long-term-bullish: price>$${ltb.sma200?.toFixed(2)} SMA200, 50>200). Approve via the Telegram button (or sid-manual-trade.yml).`);
        // Rough would-be size for the alert + queue (informational only).
        const wouldBeSizing = calcPositionSize(signal.entry, signal.stopLoss);
        // v2.3.0: deterministic id so the setup is queued exactly once and the
        // Telegram callback_data stays ≤64 bytes.
        const approvalId = pendingApprovalId(symbol, signal.signalDate, 'short');
        writeLog({
          kind:            'short_approval_required',
          symbol,
          signal:          'short',
          reason:          'Bullish-asset short gated — awaiting approval (SID_SHORT_APPROVAL_GATE)',
          approval_id:     approvalId,
          proposed_entry:  signal.entry,
          proposed_stop:   signal.stopLoss,
          proposed_rsi:    signal.rsiAtEntry,
          signalDate:      signal.signalDate,
          sma50:           ltb.sma50,
          sma200:          ltb.sma200,
          detector_reason: signal.reason,
        });
        // v2.3.0: append to the pending-approvals queue (de-duped + pruned).
        // approve-trade.js reads this on [Approve] to enter a TRACKED position.
        //
        // CRON-REDUNDANCY (2026-09-01): sid.yml now runs 3× per market day so a
        // delayed GitHub Actions run can't miss the trading window. The approval
        // QUEUE is already idempotent (deterministic id, de-duped in
        // addPendingApproval), but the Telegram alert below used to fire on EVERY
        // run — so a bullish-asset short that persists across all 3 daily runs
        // would spam up to 3 identical [Approve]/[Skip] messages/day. Gate the
        // alert on whether this id is NEWLY queued (checked against the same
        // pruned view addPendingApproval uses) so a persisting setup is announced
        // exactly ONCE — re-announced only after the 5-day TTL prunes the record.
        // A tapped [Skip] leaves the record 'pending' in the queue, which also
        // suppresses re-alerts until TTL. NOTHING about trade firing changes — this
        // only de-dupes a notification.
        const alreadyPending = prunePendingApprovals(loadPendingApprovals())
          .some(r => r.id === approvalId && r.status === 'pending');
        addPendingApproval({
          id:             approvalId,
          symbol,
          side:           'short',
          proposedEntry:  signal.entry,
          proposedStop:   signal.stopLoss,
          proposedShares: wouldBeSizing?.shares ?? null,
          signalDate:     signal.signalDate,
          rsiAtEntry:     signal.rsiAtEntry ?? null,
          reason:         signal.reason,
          sma50:          ltb.sma50 ?? null,
          sma200:         ltb.sma200 ?? null,
          createdAt:      new Date().toISOString(),
          status:         'pending',
        });
        if (!alreadyPending) {
          tg.alertShortApprovalNeeded({
            id:            approvalId,
            symbol,
            signalDate:    signal.signalDate,
            currentPrice:  signal.entry,
            proposedEntry: signal.entry,
            proposedStop:  signal.stopLoss,
            shares:        wouldBeSizing?.shares,
            reason:        signal.reason,
            mode:          CONFIG.tradingMode,
          }).catch(() => {});
        } else {
          console.log(`    (approval already queued for ${approvalId} — Telegram alert de-duped this run)`);
        }
        continue; // do NOT size/execute — Alan approves via Telegram / manual flow
      }
    }

    // Earnings blackout check — critical rule, never bypass
    const earningsDates = await fetchEarningsDates(symbol);
    const earningsCheck = isWithinEarningsWindow(earningsDates, CONFIG.earningsWindow);
    if (earningsCheck.blocked) {
      console.log(`🚫 Earnings blackout — ${earningsCheck.date} is ${earningsCheck.daysAway} days away (${CONFIG.earningsWindow}-day rule)`);
      writeLog({ symbol, signal: signal.signal, reason: `Earnings blackout: ${earningsCheck.date}` });
      continue;
    }

    // v1.6 PPI blackout — 14 days before next PPI release. Applies to ALL
    // tickers (macro event, not per-ticker). FOMC/CPI deliberately NOT
    // applied (backtest showed they hurt — see header comments).
    const ppiCheck = isWithinPPIWindow(CONFIG.earningsWindow);
    if (ppiCheck.blocked) {
      console.log(`🚫 PPI blackout — ${ppiCheck.date} is ${ppiCheck.daysAway} days away (${CONFIG.earningsWindow}-day rule)`);
      writeLog({ symbol, signal: signal.signal, reason: `PPI blackout: ${ppiCheck.date}` });
      continue;
    }

    // Calculate position size
    const sizing = calcPositionSize(signal.entry, signal.stopLoss);
    if (!sizing) {
      console.log(`Position too small to open (entry $${signal.entry.toFixed(2)} stop $${signal.stopLoss})`);
      writeLog({ symbol, signal: signal.signal, reason: 'Position size < 1 share' });
      continue;
    }

    // All checks passed — prepare the trade record
    const now     = new Date();

    console.log(`✓ ${signal.signal.toUpperCase()}`);
    console.log(`    Entry    : $${signal.entry.toFixed(2)}`);
    console.log(`    Stop     : $${signal.stopLoss}  (lowest/highest ${signal.signal === 'long' ? 'low' : 'high'} since ${signal.signalDate})`);
    console.log(`    Shares   : ${sizing.shares}`);
    console.log(`    Value    : $${sizing.totalUsd}  (${(sizing.totalUsd / CONFIG.accountUsd * 100).toFixed(1)}% of account)`);
    console.log(`    Risk     : $${sizing.riskUsd}  (${sizing.riskPct}% of position, ${(sizing.riskUsd / CONFIG.accountUsd * 100).toFixed(2)}% of account)`);
    console.log(`    Exit     : When RSI reaches 50`);
    console.log(`    Reason   : ${signal.reason}`);
    if (earningsDates.length) {
      console.log(`    Earnings : Next → ${earningsDates[0]} (${Math.round((new Date(earningsDates[0]) - now) / 86400000)} days away) ✅ clear`);
    }

    // ── Submit to Alpaca (paper or live) ─────────────────────────────────────
    // In dry_run mode (executor=null) we just record the trade locally as before.
    // In paper/live mode we place a real order and use Alpaca's order ID as the
    // canonical identifier — this lets us reconcile later.
    let orderId             = `SID-DRYRUN-${Date.now()}`;
    let exchange            = 'Yahoo/DryRun';
    let modeLabel           = 'dry_run';
    let stopOrderId         = null;     // V2.2: broker GTC stop placed alongside entry
    let clientOrderIdPrefix = null;     // V2.2: needed to find/refresh resting TP1 limit
    // ── v2.5.0: the ENTRY price actually paid ──────────────────────────────────
    // `signal.entry` is the SIGNAL bar's close — the price the rules fired on.
    // The order is a MARKET order, so it fills at whatever the book gives, which
    // is never exactly the signal close. Storing the signal price made EVERY
    // share of entry error multiply across the whole position and through both
    // exit legs:
    //   HON  signal 204.22 vs real fill 204.44  -> 5 sh, TP1+runner mis-booked
    //   IBM  signal 217.13 vs real fill 217.23  -> 4 sh, $0.40 off
    //   HD   signal 312.32 vs real fill 312.35  |  RIOT 19.65 vs 19.665526
    // approve-trade.js already did this correctly (pollOrderFill ->
    // fill.filledAvgPrice); the main entry path simply never caught up. Mirror it.
    let entryPrice      = signal.entry;
    let entrySource     = 'signal_estimate';
    let entryFillQty    = null;

    if (executor) {
      try {
        // V2.4.0 PDT-SAFE: enter WITHOUT any broker stop so no order can fire
        // intraday same-day (PDT-immune). The daily-poll in checkPositions
        // manages TP1/TP2/stop on a later day. Standard mode (pdtSafe=false) is
        // unchanged — openEntry places the broker GTC stop at entry as before.
        const result        = CONFIG.pdtSafe
          ? await executor.openEntryNoStop({ signal, sizing, symbol })
          : await executor.openEntry({ signal, sizing, symbol });
        orderId             = result.entryOrderId;
        stopOrderId         = result.stopOrderId;             // null in pdtSafe mode
        clientOrderIdPrefix = result.clientOrderIdPrefix;     // null in pdtSafe mode
        exchange            = `Alpaca/${CONFIG.tradingMode}`;
        modeLabel           = CONFIG.tradingMode;
        console.log(`    Order ID : ${orderId}${CONFIG.pdtSafe ? ' (PDT-SAFE — no broker stop; daily-poll manages exits)' : ` (stop ${stopOrderId})`}`);

        // v2.5.0 — confirm the entry fill and book the REAL average price.
        // Accounting ONLY: shares were already submitted from `sizing` and the
        // broker stop is already resting at `signal.stopLoss`, so neither the
        // share math nor the stop level is recomputed here (that would desync
        // the record from the live broker order). Best-effort: a poll failure
        // must never lose a position we have genuinely opened.
        try {
          const entryFill = await executor.pollOrderFill(orderId, { attempts: 30, delayMs: 2000 });
          if (Number.isFinite(entryFill.filledAvgPrice) && entryFill.filledAvgPrice > 0) {
            entryPrice   = entryFill.filledAvgPrice;
            entrySource  = 'alpaca_fill';
            entryFillQty = Number(entryFill.filledQty) || null;
            console.log(`    Entry fill: $${entryPrice.toFixed(4)} (signal was $${signal.entry.toFixed(4)}${
              Math.abs(entryPrice - signal.entry) > 1e-9
                ? ` — slippage ${(entryPrice - signal.entry >= 0 ? '+' : '')}$${(entryPrice - signal.entry).toFixed(4)}/sh`
                : ''})`);
            if (entryFillQty !== null && Math.abs(entryFillQty - sizing.shares) > 1e-9) {
              // Don't silently rewrite share math — flag it. syncPositions
              // reconciles the real broker quantity on the next run.
              console.log(`    ⚠ Entry filled ${entryFillQty} sh but ${sizing.shares} were ordered — flagged; next run's Alpaca sync reconciles qty`);
              writeLog({ kind: 'entry_partial_fill', symbol, ordered: sizing.shares, filled: entryFillQty, orderId });
            }
          } else {
            console.log(`    ⚠ Entry fill price unavailable for ${symbol} — storing the signal estimate $${signal.entry.toFixed(4)} (flagged entry_source:"signal_estimate")`);
          }
        } catch (fillErr) {
          console.log(`    ⚠ Entry fill poll failed for ${symbol}: ${fillErr.message} — storing the signal estimate, flagged`);
        }
      } catch (err) {
        console.log(`    🚫 Alpaca entry FAILED: ${err.message}`);
        writeLog({
          kind:   'order_fail',
          symbol,
          signal: signal.signal,
          error:  err.message,
          status: err.status,
          body:   err.body,
        });
        // Don't record this trade locally — the signal didn't actually open
        continue;
      }
    }

    const row = [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      exchange,
      symbol,
      signal.signal,
      sizing.shares,
      entryPrice.toFixed(2),          // v2.5.0 — the REAL fill, not the signal close
      signal.stopLoss,
      sizing.totalUsd,
      sizing.riskUsd,
      sizing.riskPct,
      signal.signalDate,
      orderId,
      modeLabel,
      `${BOT_NAME} ${BOT_VERSION}`,
    ].join(',');

    appendTrade(row);

    // v2.3.0: build the position record via the SHARED factory so the schema
    // stays identical to the approval-flow entry path (approve-trade.js).
    // v2.4.0: in PDT-safe mode, stamp pdt_safe:true and leave brokerStopOrderId/
    // clientOrderIdPrefix null (already null from openEntryNoStop) so
    // isV2_2Position()===false → the position is managed ONLY by the daily-poll
    // (TP1/TP2/stop on a LATER day = PDT-immune). No broker order is ever placed.
    addOpenPosition(buildEntryPositionRecord({
      id:               orderId,
      symbol,
      side:             signal.signal,
      // v2.5.0: the REAL filled average price (falls back to the signal close,
      // flagged via entry_source). stopLoss/shares/riskUsd stay exactly as the
      // strategy sized them — only the booked entry PRICE is corrected.
      entry:            entryPrice,
      stopLoss:         signal.stopLoss,
      shares:           sizing.shares,
      totalUsd:         parseFloat((sizing.shares * entryPrice).toFixed(2)),
      riskUsd:          sizing.riskUsd,
      signalDate:       signal.signalDate,
      openDate:         now.toISOString().slice(0, 10),
      openTime:         now.toISOString().slice(11, 19),
      mode:             modeLabel,
      strategyTag:      `${BOT_NAME} ${BOT_VERSION}`,
      brokerStopOrderId:   stopOrderId,          // null in pdtSafe mode
      clientOrderIdPrefix: clientOrderIdPrefix,  // null in pdtSafe mode
    }, {
      ...(CONFIG.pdtSafe ? { pdt_safe: true } : {}),
      // v2.5.0 entry provenance — keeps the signal price for audit so the
      // slippage between "rules fired here" and "we paid this" is inspectable.
      entry_source: entrySource,                 // 'alpaca_fill' | 'signal_estimate'
      signal_entry: signal.entry,
      ...(entryFillQty !== null ? { entry_fill_qty: entryFillQty } : {}),
    }));

    // Fire Telegram alert (best-effort, never blocks trading)
    tg.alertEntryFired({
      symbol,
      side:        signal.signal,
      entryPrice,                       // v2.5.0 — the REAL fill
      stopLoss:    signal.stopLoss,
      shares:      sizing.shares,
      riskUsd:     sizing.riskUsd,
      orderId,
      mode:        modeLabel,
    }).catch(() => {}); // swallow — best effort

    writeLog({
      symbol,
      signal:       signal.signal,
      entry:        entryPrice,         // v2.5.0 — the REAL fill
      signalEntry:  signal.entry,       // the signal close, for audit
      entrySource,
      stopLoss:     signal.stopLoss,
      shares:       sizing.shares,
      totalUsd:     sizing.totalUsd,
      riskUsd:      sizing.riskUsd,
      rsiAtSignal:  signal.rsiAtSignal,
      rsiAtEntry:   signal.rsiAtEntry,
      signalDate:   signal.signalDate,
      earningsDates,
      orderId,
      reason:       signal.reason,
    });

    openSymbols.add(symbol);
    newEntriesThisRun++;
  }

  if (newEntriesThisRun === 0) {
    console.log('\n  No entry signals found this run');
  }

  console.log(`\n══ SID run complete — ${newEntriesThisRun} new trade(s) ══`);

  // Final Telegram run-summary (best-effort)
  const finalAccount = loadAccount();
  const finalOpen = loadOpenPositions();
  await tg.alertBotStatus({
    openCount:   finalOpen.length,
    newEntries:  newEntriesThisRun,
    closedToday: 0, // checkPositions already sent per-exit alerts
    accountUsd:  finalAccount.accountUsd,
    mode:        CONFIG.tradingMode,
  }).catch(() => {});
}

// Only auto-run the bot when this file is executed directly (e.g. `node
// bot-sid.js`, which is how sid.yml invokes it). When imported (e.g. by a test
// harness), skip the side-effecting run() so the pure functions can be unit
// tested in isolation.
import { pathToFileURL } from 'url';
const _isDirectRun = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (_isDirectRun) {
  run().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

// Exports for test harnesses + the v2.3.0 approval flow (approve-trade.js).
// These do NOT affect the direct-run path above.
export {
  detectEntrySignal,
  buildWeeklyDailyAligned,
  weeklyDirection,
  longTermBullish,
  calcRSI,
  calcMACD,
  calcSMA,
  // v2.4.2 — exported for the shorts-TP1 broker-order (OCO/runner-stop) unit tests.
  // No runtime effect on the direct-run path; exports are inert when `node bot-sid.js`.
  findOpenOrder,
  maintainV2_2BrokerOrders,
  rsiTargetPrice,
  CONFIG,
  // v2.3.0 — shared so the approval flow reuses the exact schema + state I/O,
  // never a hand-copied duplicate (prevents drift).
  BOT_NAME,
  BOT_VERSION,
  buildEntryPositionRecord,
  calcPositionSize,
  fetchDailyCandles,
  addOpenPosition,
  loadOpenPositions,
  saveOpenPositions,
  loadAccount,
  updateAccount,
  // v2.4.1 — accounting reconcile: ledger is re-derived from records (never a
  // running counter), paper/live segregated. Exported for unit tests.
  deriveLedger,
  realisedPnlFor,
  recordMode,
  loadClosedPositions,
  // v2.4.3 — accounting/display fixes: the external-close consumed-fill ledger
  // (double-count guard) + the Alpaca account snapshot writer. Exported for the
  // unit tests only; inert on the direct-run path.
  consumedExitFillQty,
  recordExternalClose,
  // v2.5.0 — the shared TP1-leg guard. Used by BOTH deriveLedger (don't count an
  // open position's tp1_pnl twice) and recordExternalClose (do carry it into a
  // full close). Exported for the regression tests on both directions.
  tp1LegAlreadyInClosedRecords,
  // v2.6.0 — queue-for-open exits. Exported for the regression suite only; inert
  // on the direct-run path. exitClientOrderId is the broker-level double-sell
  // guard, so its determinism is asserted by test.
  exitClientOrderId,
  exitTagFor,
  marketIsOpen,
  shouldQueueExitForOpen,
  queueExitForOpen,
  reconcilePendingExits,
  bookQueuedExitFill,
  PENDING_EXIT_DEAD_STATES,
  alpacaSnapshotPathForMode,
  alpacaStartingEquityFor,
  writeAlpacaSnapshot,
  appendTrade,
  writeLog,
  loadPendingApprovals,
  savePendingApprovals,
  prunePendingApprovals,
  pendingApprovalId,
  todayString,
};
