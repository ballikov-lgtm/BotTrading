#!/usr/bin/env python3
"""
bot-maven.py — Maven PAPER trading bot.

Runs on a schedule (GitHub Actions cron). Each run:
  1. Reads the curated watchlist + live params from maven-config.json.
  2. For each coin, asks the VALIDATED engine (backtest-maven.py engine_state) for the
     current state — closed trades, any open position, any armed signal — so the paper
     trades mirror the backtest 1:1 (live == backtest, no re-implemented logic).
  3. Reconciles against the persisted paper account (ONE shared $1,000 account, 2% risk,
     max 3 concurrent, 3x leverage cap, compounding) — the real live model.
  4. On every ENTRY / TP / STOP / TIME exit: sends a [MAVEN] Telegram alert and updates
     docs/maven/state.json, which the cloud dashboard reads.

PAPER mode uses only Bitget PUBLIC price data — no API keys, no account access, no money.
"clean start": on first run it marks any already-open engine positions as seen WITHOUT
taking them, so paper trading begins flat from today.
"""
import json, os, sys, importlib.util, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:  # emojis in logs crash Windows' default cp1252 console; GHA/Linux is UTF-8 anyway
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
STATE_PATH  = REPO / "docs" / "maven" / "state.json"
CONFIG_PATH = HERE / "maven-config.json"
LOOKBACK_DAYS = 220   # enough history for the daily-200 + 4h-200 + warmup

# ── load the validated engine (hyphenated filename -> importlib) ──────────────
_spec = importlib.util.spec_from_file_location("maven_engine", HERE / "backtest-maven.py")
ENG = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ENG)

def now_utc():
    return datetime.now(timezone.utc)

def iso(dt):
    return dt.strftime("%Y-%m-%d %H:%M UTC")

# ── Telegram ([MAVEN] tag, reuses SID's bot token/chat) ───────────────────────
def telegram(msg):
    tok = os.environ.get("TELEGRAM_BOT_TOKEN"); chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        print("[telegram skipped]", msg); return
    try:
        data = urllib.parse.urlencode({"chat_id": chat, "text": "[MAVEN] " + msg,
                                       "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
        urllib.request.urlopen(urllib.request.Request(
            f"https://api.telegram.org/bot{tok}/sendMessage", data=data), timeout=15)
    except Exception as e:
        print("[telegram error]", e, "|", msg)

# ── state I/O ─────────────────────────────────────────────────────────────────
def load_state(cfg):
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    acct = cfg["account"]
    return {"strategy": "Maven", "mode": cfg.get("mode", "paper"),
            "started": now_utc().strftime("%Y-%m-%d"), "initialized": False,
            "start_equity": acct["start_equity_usdt"], "equity": acct["start_equity_usdt"],
            "open": {}, "closed": [], "seen_entries": {}, "skipped": {},
            "equity_curve": [{"t": iso(now_utc()), "equity": acct["start_equity_usdt"]}],
            "watchlist": cfg["watchlist"], "last_run": None, "events_last_run": []}

def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))

def recompute_stats(state):
    closed = state["closed"]
    wins = [t for t in closed if t["pnl"] > 0]
    gw = sum(t["pnl"] for t in wins); gl = -sum(t["pnl"] for t in closed if t["pnl"] <= 0)
    net = round(state["equity"] - state["start_equity"], 2)
    state["stats"] = {
        "closed_trades": len(closed), "open_trades": len(state["open"]),
        "win_rate": round(100*len(wins)/len(closed), 1) if closed else 0.0,
        "profit_factor": round(gw/gl, 2) if gl > 0 else (999.0 if gw > 0 else 0.0),
        "net_usdt": net, "return_pct": round(100*net/state["start_equity"], 1),
    }

# ── main cycle ────────────────────────────────────────────────────────────────
def run():
    cfg = json.loads(CONFIG_PATH.read_text())
    acct = cfg["account"]
    risk_pct = acct["risk_pct_per_trade"]; max_conc = acct["max_concurrent"]; lev_cap = acct["leverage_cap"]
    P = ENG.default_params(); P.update(cfg.get("strategy_params", {}))

    state = load_state(cfg)
    state["watchlist"] = cfg["watchlist"]
    first_run = not state.get("initialized")
    events = []

    end   = now_utc().strftime("%Y-%m-%d")
    start = (now_utc() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")

    for sym in cfg["watchlist"]:
        try:
            trades, pos, _pending = ENG.engine_state(sym, start, end, P)
        except Exception as e:
            print(f"[{sym}] engine error: {e}"); continue
        closed_by_ts = {t["entry_ts"]: t for t in trades}
        seen = state["seen_entries"].setdefault(sym, [])

        # (a) manage a position the bot is HOLDING -> close it when the engine closes it
        held = state["open"].get(sym)
        if held:
            still_open = pos is not None and pos.get("entry_ts") == held["entry_ts"]
            if not still_open:
                ct = closed_by_ts.get(held["entry_ts"])
                if ct:
                    pnl = round(ct["R"] * held["risk_amt"], 2)
                    state["equity"] = round(state["equity"] + pnl, 2)
                    state["closed"].append({**held, "exit": ct["exit"], "exit_time": ct.get("xtime"),
                        "reason": ct["reason"], "R": round(ct["R"], 2), "pnl": pnl,
                        "closed_at": iso(now_utc())})
                    icon = "✅" if pnl > 0 else ("🟡" if pnl == 0 else "🛑")
                    events.append(f"{icon} {sym} {ct['reason']}  {ct['R']:+.2f}R  ${pnl:+.2f}  → equity ${state['equity']:.2f}")
                    del state["open"][sym]

        # (b) NEW entry the engine just opened (and the bot isn't already in it)
        if sym not in state["open"] and pos is not None:
            ets = pos.get("entry_ts")
            if ets not in seen:
                seen.append(ets)
                if first_run:
                    pass  # clean start: don't back-fill pre-existing positions
                else:
                    sf = (pos["risk"] / pos["entry"]) if pos.get("entry") else 0
                    conc = len(state["open"]); open_notional = sum(p["notional"] for p in state["open"].values())
                    if conc >= max_conc:
                        events.append(f"⏸️ {sym} entry skipped — account full ({conc}/{max_conc})")
                        state["skipped"].setdefault(sym, []).append(ets)
                    elif sf <= 0:
                        pass
                    else:
                        risk_amt = risk_pct/100.0 * state["equity"]
                        desired  = risk_amt / sf
                        room     = lev_cap*state["equity"] - open_notional
                        notional = min(desired, max(0.0, room))
                        if notional <= 0:
                            events.append(f"⏸️ {sym} entry skipped — no leverage room")
                            state["skipped"].setdefault(sym, []).append(ets)
                        else:
                            actual_risk = risk_amt * (notional/desired)
                            state["open"][sym] = {"symbol": sym, "entry_ts": ets,
                                "entry": pos["entry"], "stop": pos["stop"], "stop_frac": round(sf, 4),
                                "risk_amt": round(actual_risk, 2), "notional": round(notional, 2),
                                "entry_time": pos.get("etime"), "opened_at": iso(now_utc())}
                            events.append(f"🟢 {sym} ENTRY @ {pos['entry']:.4g}  stop {pos['stop']:.4g}  "
                                          f"risk ${actual_risk:.2f}  ({len(state['open'])}/{max_conc} open)")

    if first_run:
        state["initialized"] = True
        n = len(cfg["watchlist"])
        events.insert(0, f"🚀 Maven paper trading STARTED — ${state['start_equity']:.0f}, watching {n} coins "
                         f"(2% risk, max {max_conc} concurrent, {lev_cap:.0f}x cap). Armed and waiting for setups.")

    # equity curve point + stats + persist
    state["equity_curve"].append({"t": iso(now_utc()), "equity": state["equity"]})
    state["equity_curve"] = state["equity_curve"][-2000:]
    state["last_run"] = iso(now_utc())
    state["events_last_run"] = events
    recompute_stats(state)
    save_state(state)

    for e in events:
        telegram(e)
    print(f"[{iso(now_utc())}] equity ${state['equity']:.2f} | open {len(state['open'])} | "
          f"closed {len(state['closed'])} | {len(events)} event(s)")
    for e in events:
        print("  ", e)

if __name__ == "__main__":
    run()
