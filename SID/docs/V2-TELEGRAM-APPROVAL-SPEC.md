# V2 Telegram Approval Spec — Auto vs Human-Approval Trades

**Status: SPEC ONLY — not yet implemented in bot-sid.js (2026-05-16)**

V2 method scans 113 tickers across two tiers:

| Tier | Count | Behaviour | Trust level |
|------|------:|-----------|-------------|
| **AUTO** | 80 | Bot executes automatically | Proven via 5y V1 backtest |
| **HUMAN** | 32 | Bot sends Telegram alert, waits for approval | High-vol / crypto / new / re-added |

---

## AUTO list (80 tickers)

Auto-fires without confirmation when all V2 rules pass:

```
AAPL, ABBV, ABT, ADBE, AMAT, AMD, AMZN, AVGO, AXP, B,
BA, BLK, CAT, COST, CRM, CVX, DE, DIA, DIS, EEM,
EFA, F, GDX, GE, GLD, GOOG, GS, HD, HON, IBB,
IBM, INTC, IWM, IYR, JNJ, JPM, KHC, LLY, LMT, LRCX,
MCD, MDLZ, META, MRK, NKE, NOW, NUGT, NVDA, ORCL, PFE,
PYPL, QQQ, RIOT, RTX, SBUX, SCHW, SLV, SPY, SQQQ, TGT,
TNA, TQQQ, TSLA, TZA, UNH, V, WFC, WMT, XHB, XLC,
XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY, XOM
```

## HUMAN-approval list (32 tickers)

Requires Telegram OK before bot executes:

```
Crypto-adjacent (5):     COIN, MSTR, MARA, BITF, HUT
EVs/AI/IPOs (8):         PLTR, RIVN, LCID, NIO, SMCI, ARM, AI, CVNA
Meme/momentum (3):       GME, AMC, ROKU
Leveraged ETFs (6):      SOXL, SOXS, BOIL, KOLD, JNUG, UVXY
Commodities (2):         USO, UNG
International (4):       FXI, EWZ, EWG, EWJ
Re-added from dropped (3): CSCO, EXPE, PG
Other (2):               AAL, LUV
```

---

## Message format (bot → user, Telegram)

Sent when a HUMAN-tier ticker has a V2 trigger:

```
🤖 SID V2 SIGNAL — APPROVAL NEEDED

Ticker: COIN  ⚠️ HUMAN-tier
Side:   LONG
Setup:  RSI 27.4 → 31.8 (bouncing) | RSI3 12.4 | Wkly RSI rising ✓

Proposed parameters:
  Entry:  $185.45  (today's close)
  Stop:   $172.00  (-$13.45/share, signal-day low rounded down)
  TP:     RSI 50 target ≈ $199-205
  Risk:   $201 (1.0% of $20,150 account)
  Size:   14 shares ($2,596 = 12.9% of account)
  R:R:    1:1.0 (TP target / risk distance)

Reply within 30 min or signal expires.

Reply:
  OK COIN          — accept exactly as proposed
  MOD COIN E=186.00 SL=174.00 TP=200.00  — modify any of E/SL/TP
  NO COIN          — reject this signal

Signal ID: SIG-20260516-COIN-L
```

## Reply parser (user → bot)

The bot watches a single Telegram chat and parses replies of these forms:

### `OK <TICKER>`
Accept proposed parameters as-is. Bot fires the trade.

### `MOD <TICKER> [E=<price>] [SL=<price>] [TP=<price>]`
Modify any subset of Entry/SL/TP. Bot recalculates shares based on new SL distance and 1% risk, then fires.

Examples:
- `MOD COIN SL=170.00` — only adjust stop down
- `MOD COIN E=186.00 SL=174.00` — adjust entry and stop, keep proposed TP
- `MOD COIN E=185.00 SL=173.00 TP=195.00` — all three

### `NO <TICKER>`
Reject the signal. Bot logs and skips.

### Timeout
If no reply within 30 minutes (or before market close, whichever is sooner), bot logs as `EXPIRED` and skips.

---

## Edge cases

| Case | Behaviour |
|------|-----------|
| Multiple HUMAN signals same day | Send separate messages, each with own SIG-ID |
| User replies after timeout | Bot ignores, logs `LATE_REPLY` |
| User sends `MOD` with same values as proposed | Treated as `OK` (no warning) |
| User sends `OK` for unknown ticker | Bot replies "No pending signal for X" |
| Bot crashes mid-conversation | Re-poll on restart; expired signals stay expired |
| Modified SL makes position size exceed account | Bot replies with cap warning, asks for adjustment |
| Modified TP doesn't beat 1:1 R:R | Bot warns but accepts if user confirms |

---

## Backtest implications

In backtest, **all HUMAN trades are assumed approved** (best case). The xlsx
flags each trade as AUTO or HUMAN so we can see:
- How much of V2's P&L comes from auto-tier
- What we'd lose if we never approved any HUMAN-tier alerts
- Per-ticker performance to inform future "promote to AUTO" decisions

If after 6 months of live trading a HUMAN-tier ticker has consistently
high WR + positive P&L, promote it to AUTO. If a HUMAN-tier ticker
consistently underperforms, remove from universe entirely.

---

## Implementation checklist (for bot-sid.js)

- [ ] Add `AUTO_APPROVED_TICKERS` constant
- [ ] On V2 trigger: check ticker tier
  - [ ] AUTO → fire immediately
  - [ ] HUMAN → send Telegram message, mark `PENDING_APPROVAL`
- [ ] Telegram bot: poll for new messages every 30s during market hours
- [ ] Parse OK/MOD/NO replies, update pending signals
- [ ] On approval/modification: fire trade with final parameters
- [ ] On timeout: log EXPIRED, skip
- [ ] Add new dashboard section: "Pending Approvals" with countdown timers
- [ ] Log all approval interactions to `sid-approval-log.json` for audit

---

## Dashboard surfacing

The SID dashboard should show:

- Pending approvals (count + most recent timestamp)
- Today's auto-fired trades
- Today's human-approved trades
- Today's human-rejected/expired trades (for review)
- Per-ticker AUTO/HUMAN tier breakdown
