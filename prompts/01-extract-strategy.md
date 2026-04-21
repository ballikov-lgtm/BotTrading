# Strategy Extraction Prompt

Use this prompt inside Claude Code to extract a trading strategy from a YouTube transcript and output a structured `rules.json` file.

## Instructions

1. Go to the YouTube video containing the strategy you want to extract
2. Use [Apify](https://apify.com) or a transcript tool to get the full text transcript
3. Paste the transcript below the line marked `[PASTE TRANSCRIPT CONTENT BELOW THIS LINE]`
4. Run this entire document as a prompt in Claude Code

---

## Prompt

You are a trading strategy analyst. I will give you a YouTube transcript from a trader explaining their strategy. Your job is to extract the strategy into a structured `rules.json` file.

Extract the following:
- **Indicators** and their settings (periods, types)
- **Entry conditions** — long and short separately
- **Exit conditions** — take profit, stop loss, signal-based exits
- **Avoidance triggers** — when NOT to trade
- **Risk management** — position sizing, max risk per trade
- **Timeframe preferences**

Output a valid JSON object matching this schema:

```json
{
  "strategy": "<Strategy Name>",
  "asset": "<Symbol e.g. BTCUSDT>",
  "timeframe": "<e.g. 1m, 4h>",
  "indicators": {
    "<indicator_name>": "<period or settings>"
  },
  "long_entry": {
    "description": "<plain English summary>",
    "conditions": ["<condition 1>", "<condition 2>"]
  },
  "short_entry": {
    "description": "<plain English summary>",
    "conditions": ["<condition 1>", "<condition 2>"]
  },
  "exit_conditions": ["<condition 1>", "<condition 2>"],
  "avoidance_rules": ["<rule 1>", "<rule 2>"],
  "risk": {
    "max_risk_per_trade_pct": 1,
    "note": "<any additional notes>"
  }
}
```

After outputting the JSON, briefly explain in plain language what this strategy is doing and why the entry conditions make sense.

---

[PASTE TRANSCRIPT CONTENT BELOW THIS LINE]
