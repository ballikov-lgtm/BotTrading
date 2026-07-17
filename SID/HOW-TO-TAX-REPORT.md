# How to get a tax report of all your SID trades

This makes a spreadsheet (Excel) listing every SID trade that has closed, with
the profit or loss on each one. You hand that spreadsheet to your accountant.

It runs **entirely on your own computer**. Nothing is uploaded anywhere. The
spreadsheet is saved only on your machine and is never added to the public code
repository, so your private trade figures stay private.

---

## Do this

1. Open the `SID` folder on your computer.
2. **Windows:** double-click **`GENERATE-TAX-REPORT.bat`**
   **Mac:** double-click **`generate-tax-report.command`**
   - *(Mac, first time only:* if it won't open, **right-click the file -> Open ->
     Open**. After the first time, a normal double-click works.*)*
3. A little window appears and does the work. When it finishes, your spreadsheet
   opens automatically.
4. That's it. The file is saved in the `SID/tax-reports/` folder on your
   computer, named like `sid-tax-report-2026-07-17.xlsx` (the date is when you
   made it). You can re-run it any time to get a fresh, up-to-date copy.

If it says Python is not installed, install **Python 3** from
<https://www.python.org/downloads/> (on Windows, tick **"Add Python to PATH"**
during install), then double-click the file again.

---

## What's in the spreadsheet

One row per closed trade, with these columns:

| Column | What it means |
|---|---|
| **Symbol** | The ticker (e.g. GOOG, UNH). |
| **Side** | `long` (bet it goes up) or `short` (bet it goes down). |
| **Opened** | The date the trade was opened. |
| **Closed** | The date the trade was closed. |
| **Quantity** | How many shares. |
| **Proceeds (USD)** | Money received (reference only). |
| **Cost (USD)** | Money paid (reference only). |
| **Realised P&L (USD)** | **The actual profit or loss on the trade** — this is the number that matters. |
| **Month** | The month the trade closed (e.g. `2026-06`). Handy for filtering. |
| **UK Tax Year** | The UK tax year the trade closed in (e.g. `2026/27`). Handy for filtering. |
| **Mode** | `live` — real-money trades only. (Paper/simulated trades are left out entirely — see below.) |

**Only your LIVE (real-money) trades appear here.** Paper (simulated) trades are
**excluded**, because paper trading isn't real and isn't taxable. So while you're
still on paper, this report will be **empty** — that's correct, there's nothing to
declare yet. Once you go live, your real trades fill it in automatically.

All amounts are in **US dollars (USD)**, because that's the currency the trades
are made in. Your accountant converts them to **GBP** using the official HMRC
exchange rates — you don't need to do that yourself.

---

## Filter to the period you want, and read the total

At the top of every column there's a little **filter arrow**. Click the arrow on
the **`UK Tax Year`** column (or the **`Month`** column) and tick just the period
you want — for example only `2026/27`.

The spreadsheet then hides every other row, and the **bold total row at the
bottom** (labelled *"REALISED P&L (visible rows)"*) automatically shows the
combined profit or loss **for just the rows you can see**. Filtered-out (hidden)
rows are **not** counted in that total. Change the filter and the total updates
itself.

So to get your realised profit for a tax year: filter the `UK Tax Year` column to
that year, and read the total row. Give that figure (and the filtered list) to
your accountant.

### About the UK tax year

The UK tax year does **not** run January to December. It runs from **6 April to
5 April** the following year. For example:

- A trade closed on **10 May 2026** is in the **2026/27** tax year.
- A trade closed on **20 March 2026** is in the **2025/26** tax year.
- A trade closed on **5 April 2026** is in the **2025/26** tax year.
- A trade closed on **6 April 2026** is in the **2026/27** tax year.

The spreadsheet works this out for you and puts the right tax year on every row —
just filter that column.

---

## Important

- **Live trades only.** The report contains only your real-money (`live`) trades —
  paper/simulated trades are excluded because they are not taxable. It stays empty
  while you're on paper, which is correct.
- **This is a record of your trades, not tax advice.** It's a tidy list to hand
  to your accountant or use for your Self Assessment. It does not tell you how
  much tax you owe.
- **Amounts are in USD.** Your accountant converts to GBP at the official HMRC
  rates for the relevant dates.
- **The file stays on your computer.** It is never uploaded and never added to
  the public code repository — your figures are private to you.
- Re-run it whenever you like to pick up newly closed trades. It always builds a
  fresh spreadsheet from your latest trade history.
