"""
holdings-agent/allocator.py — generates a concrete allocation recommendation.

Inputs:
  - available_capital_gbp: total to deploy (SELL proceeds + uninvested cash)
  - capital_sources: dict explaining where the capital came from (for narrative)
  - candidates: list of dicts with {name, type, risk_level, source, ...}
                where source = "buy_opportunity" or "topup_existing"
  - plan: dict from financial_plan_importer
  - sell_recs: list of SELL recs (for narrative context)
  - watchlist_names: set of fund names on the watchlist

Returns:
  {
    "exec_summary":    str,
    "allocations":     [{fund_name, amount_gbp, percentage, risk_level, rationale, action, is_watchlist}],
    "portfolio_shape": str,
    "expected_outlook": str,
    "caveats":         [str, ...]
  }

Uses Claude API (sonnet-4-6, NO web search) — ~5K tokens, ~$0.05 per call.
"""

import json
import os
import re
import sys
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

HOLDINGS_AGENT_DIR = Path(__file__).parent
TRADING_SETUP_DIR  = HOLDINGS_AGENT_DIR.parent
ENV_FILE           = TRADING_SETUP_DIR / ".env"
load_dotenv(ENV_FILE, override=True)

MODEL = "claude-sonnet-4-6"

_client = None
def _get_client():
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


def _extract_json(text: str) -> dict:
    """Robust JSON extraction — handles fenced blocks + brace-balanced scan."""
    fenced = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))

    start = text.find('{')
    if start < 0:
        raise ValueError(f"No JSON found in: {text[:300]}")

    depth, in_string, escape = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if escape:
            escape = False; continue
        if c == '\\':
            escape = True; continue
        if c == '"':
            in_string = not in_string; continue
        if in_string:
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i+1])
    raise ValueError(f"Unbalanced braces. First 300: {text[start:start+300]}")


def _collect_text(response) -> str:
    return "".join(block.text for block in response.content if hasattr(block, "text"))


def build_candidate_pool(buy_candidates, hold_recs, latest_holdings_by_id, plan, watchlist_names):
    """Combine new buy candidates + eligible top-up candidates into one list for allocator."""
    pool = []

    for b in buy_candidates:
        pool.append({
            "name":         b["name"],
            "type":         b.get("type", "Other"),
            "risk_level":   b.get("risk_level", "MEDIUM").upper(),
            "source":       "buy_opportunity",
            "is_watchlist": b.get("is_watchlist", False),
            "rationale":    b.get("rationale", ""),
            "outlook":      b.get("outlook", ""),
            "days_seen":    b.get("days_seen", 1),
            "total_days":   b.get("total_days", 1),
        })

    # Top-up eligibility: only HOLD recommendations (no SELL/REVIEW), filtered by plan rules
    topup_passive_only = plan.get("topup_passive_only", True)
    for h in hold_recs:
        name_lower = h["name"].lower()
        is_passive = any(kw in name_lower for kw in ("index", "tracker", "passive", "esg tilted"))
        verdict = h.get("latest_verdict")
        eligible = False
        eligibility_note = ""
        if verdict in ("ON_TRACK", "OUTPERFORMING"):
            eligible = True
            eligibility_note = f"existing holding with {verdict} verdict"
        elif verdict == "INSUFFICIENT_DATA" and is_passive and not topup_passive_only:
            eligible = True
            eligibility_note = "existing passive/index holding (data unavailable but predictable)"
        elif verdict == "INSUFFICIENT_DATA" and is_passive and topup_passive_only:
            eligible = True
            eligibility_note = "existing passive/index holding (plan allows passive top-ups)"

        if eligible:
            full = latest_holdings_by_id.get(h["id"], {})
            pool.append({
                "name":         h["name"],
                "type":         "Existing position",
                "risk_level":   "LOW-MED" if is_passive else "MEDIUM",
                "source":       "topup_existing",
                "is_watchlist": False,
                "rationale":    eligibility_note,
                "outlook":      (full.get("summary") or "")[:200],
                "current_value_gbp": h.get("value_gbp"),
            })

    return pool


def compute_allocation(available_capital_gbp, capital_sources, candidates, plan,
                       sell_recs=None, holdings_summary=None) -> dict:
    """Ask Claude to produce a concrete allocation given the constraints. Returns dict."""

    if available_capital_gbp <= 0:
        return {
            "exec_summary":    "No capital available to allocate this week.",
            "allocations":     [],
            "portfolio_shape": "—",
            "expected_outlook": "—",
            "caveats":         [],
            "_skipped":        True,
            "_reason":         "no_capital",
        }
    if not candidates:
        return {
            "exec_summary":    f"£{int(available_capital_gbp):,} available but no qualifying candidates this week.",
            "allocations":     [],
            "portfolio_shape": "—",
            "expected_outlook": "—",
            "caveats":         ["Hold capital in cash until next review surfaces candidates."],
            "_skipped":        True,
            "_reason":         "no_candidates",
        }

    risk_target  = plan.get("risk_target", "MEDIUM")
    max_single   = plan.get("max_single_position_pct", 25.0)
    wrapper      = plan.get("preferred_wrapper", "ISA")
    min_chunk    = int(plan.get("min_allocation_chunk_gbp", 500))
    max_positions = plan.get("max_new_positions", 6)
    user_notes   = plan.get("user_notes", "").strip()

    # Risk band targets
    bands = {
        "LOW":      (90, 10),
        "LOW-MED":  (80, 20),
        "MEDIUM":   (65, 35),
        "MED-HIGH": (55, 45),
        "HIGH":     (50, 50),
    }
    med_target_pct, high_target_pct = bands.get(risk_target, (65, 35))

    # Build the candidate descriptions
    candidate_lines = []
    for c in candidates:
        wl = " [ON WATCHLIST]" if c.get("is_watchlist") else ""
        src = "TOP-UP" if c["source"] == "topup_existing" else "NEW"
        outlook = f" Outlook: {c['outlook'][:200]}" if c.get("outlook") else ""
        current = f" Current value: £{int(c['current_value_gbp']):,}." if c.get("current_value_gbp") else ""
        candidate_lines.append(
            f"- {c['name']} ({c['risk_level']} risk, {c['type']}, {src}){wl}.{current} "
            f"Rationale: {c.get('rationale', 'n/a')[:300]}.{outlook}"
        )
    candidates_block = "\n".join(candidate_lines)

    # Capital sources narrative
    src_parts = []
    if capital_sources.get("from_sells", 0) > 0:
        sell_names = ", ".join(s["name"] for s in (sell_recs or []))
        src_parts.append(f"£{int(capital_sources['from_sells']):,} from SELLs ({sell_names})")
    if capital_sources.get("from_cash", 0) > 0:
        src_parts.append(f"£{int(capital_sources['from_cash']):,} from uninvested cash")
    capital_source_text = " + ".join(src_parts) if src_parts else "see capital field"

    user_notes_block = f"\n\nUser notes (weigh in your reasoning): {user_notes}" if user_notes else ""

    system_prompt = (
        "You are a portfolio allocation analyst producing a recommendation for a UK private investor. "
        "You are NOT giving regulated financial advice — your output is informational. Be concise, "
        "factual, and concrete with numbers. Use £ amounts rounded sensibly. Always include the "
        "standard tax / dealing-fee caveats.\n\n"
        "You must return JSON ONLY, no prose around it. Schema:\n"
        '{\n'
        '  "exec_summary": "1-2 sentences describing the strategy in plain English",\n'
        '  "allocations": [\n'
        '    {"fund_name": "...", "amount_gbp": <int>, "percentage": <float>, '
        '"risk_level": "LOW|LOW-MED|MEDIUM|MED-HIGH|HIGH", '
        '"action": "NEW|TOP-UP", "is_watchlist": <bool>, "rationale": "2-3 sentences"}\n'
        '  ],\n'
        '  "portfolio_shape": "X% MEDIUM-or-lower / Y% HIGH",\n'
        '  "expected_outlook": "1-2 sentences: expected base case return, stress scenario",\n'
        '  "caveats": ["bullet 1", "bullet 2", "..."]\n'
        '}\n'
    )

    user_prompt = (
        f"AVAILABLE CAPITAL: £{int(available_capital_gbp):,} ({capital_source_text})\n\n"
        f"RISK TARGET: {risk_target} — aim for roughly {med_target_pct}% in MEDIUM-or-lower-risk positions "
        f"and {high_target_pct}% in HIGH-risk positions.\n"
        f"MAX SINGLE POSITION: {max_single:g}% of available capital "
        f"(= £{int(available_capital_gbp * max_single / 100):,}).\n"
        f"MAX NEW POSITIONS: {max_positions}.\n"
        f"MINIMUM ALLOCATION CHUNK: £{min_chunk} (smaller positions add complexity for little benefit).\n"
        f"PREFERRED WRAPPER: {wrapper} (mention in caveats — relevant for tax handling of any SELLs).\n"
        "\nCANDIDATES:\n"
        f"{candidates_block}\n"
        f"{user_notes_block}\n\n"
        "Produce the allocation now. Important rules:\n"
        "- Total of amount_gbp MUST equal the available capital exactly.\n"
        "- Each amount must be a multiple of £100 for clean numbers.\n"
        "- Bias allocations toward [ON WATCHLIST] candidates (slightly larger share).\n"
        "- Distribute meaningfully across themes — avoid clustering in a single geography or sector.\n"
        "- Caveats should always include: tax wrapper handling, dealing fees, exit penalties on SELLs.\n"
        "- Expected outlook should give a realistic range, not a single number; mention what a "
        "stress scenario would look like.\n"
        "\nReturn JSON only."
    )

    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=2500,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )
    parsed = _extract_json(_collect_text(response))

    # Validate totals + normalise
    allocations = parsed.get("allocations", [])
    total = sum(a.get("amount_gbp", 0) for a in allocations)
    parsed["_total_allocated_gbp"] = total
    parsed["_available_capital_gbp"] = available_capital_gbp
    parsed["_total_matches_available"] = abs(total - available_capital_gbp) < 1
    parsed["_risk_target"] = risk_target
    parsed["_max_single_pct"] = max_single
    parsed["_skipped"] = False
    return parsed


if __name__ == "__main__":
    # Standalone test — provide dummy inputs to validate Claude call shape
    sample_plan = {
        "risk_target": "MEDIUM",
        "max_single_position_pct": 25.0,
        "preferred_wrapper": "ISA",
        "max_new_positions": 6,
        "min_allocation_chunk_gbp": 500,
        "user_notes": "",
    }
    sample_candidates = [
        {"name": "Vanguard Global Small-Cap Index Fund", "type": "OEIC", "risk_level": "MEDIUM",
         "source": "buy_opportunity", "is_watchlist": True,
         "rationale": "HL Wealth Shortlist addition Feb 2026", "outlook": "Small-cap recovery cycle"},
        {"name": "Jupiter Gold & Silver Fund", "type": "OEIC", "risk_level": "HIGH",
         "source": "buy_opportunity", "is_watchlist": False,
         "rationale": "169% in 2025; inflation hedge", "outlook": "Gold supercycle"},
    ]
    result = compute_allocation(
        available_capital_gbp=10000,
        capital_sources={"from_sells": 0, "from_cash": 10000},
        candidates=sample_candidates,
        plan=sample_plan,
        sell_recs=[],
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
