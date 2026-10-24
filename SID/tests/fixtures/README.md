# SID test fixtures

Real market data, checked in so the regression suites need **no network**.

| File | What it is | Provenance |
|---|---|---|
| `mcd-daily-to-2026-10-08.csv` | MCD daily bars (`date,high,low,close`), 1244 rows, 2021-10-25 -> 2026-10-08 | Fetched 2026-10-24 from the same Yahoo endpoint `bot-sid.js#fetchDailyCandles` uses (`/v8/finance/chart/MCD?interval=1d&range=5y`), then truncated at 2026-10-08. Prices are the endpoint's values rounded to 4dp. |

## Why MCD, and why these columns

`SID/tests/v2.6.1-close-window.test.mjs` group W replays the REAL
`detectEntrySignal` over these bars to reproduce the measured miss v2.6.1 is named
after: a LONG signal on the 2026-10-05 bar and again on the 2026-10-08 bar, on two
days where every `sid.yml` run landed after the 20:00 UTC close so the bot could
not act on either.

`detectEntrySignal` consumes exactly `date`, `high`, `low` and `close` (closes feed
RSI(14)/RSI(3)/MACD and the weekly resample; high/low set the arm's stop level), so
open and volume are omitted.

**5 years is deliberate, not generous.** The live entry scan fetches `'5y'`
(`bot-sid.js:3945`) because the v2.3 weekly SMA50/200 arm gate needs >= 200 weekly
buckets; a 2y fixture would silently disable that gate and make the replay LOOSER
than the live bot.

**Known limitation:** the window starts 2021-10-25 rather than 2021-10-08, because
it was fetched as a trailing 5y on 2026-10-24. That changes only the first ~11
bars; Wilder RSI/MACD seeding differences have decayed to nothing 1200 bars later,
and the weekly SMA200 at the end of the series reads the last 200 weekly buckets
regardless of what precedes them.
