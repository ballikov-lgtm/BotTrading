# How to Fund an Alpaca Account (Bank Transfer)

The **cheapest and safest** way to get money **into** a live Alpaca trading account from
the UK (or another non-US country) by bank transfer — keeping fees and currency loss to a
minimum and staying safe. Written for people who have never done an international transfer.

> **Read this first — important:**
> - This is **general information, not financial, tax, or legal advice.** You are
>   responsible for your own money and for following the rules that apply to you.
> - **Fees, services, and rules change.** Every figure below is a guide — **check the
>   current fee on the provider's own website before you send anything.**
> - **Only fund an account with money you can afford to lose.** Trading carries risk.
> - **Do a small test transfer first** (e.g. £50–£100) before moving a larger amount.

---

## The big picture (why funding needs a bit of thought)

Alpaca accounts hold **US dollars only**. So from the UK you have to do two things:
1. **Convert GBP → USD** (this is where most people lose money, via bad exchange rates), and
2. **Get those dollars into Alpaca** (this is where transfer/wire fees bite).

The trick to doing it cheaply is to **separate those two steps**: convert your pounds
to dollars in a service that uses the real ("mid-market") exchange rate, then move the
dollars into Alpaca by the **free** method (ACH), instead of using an expensive
all-in-one bank wire that charges you on both the rate *and* the fee.

**How Alpaca lets you add money** (from Alpaca's own docs):

| Method | Fee | Notes |
|---|---|---|
| **ACH** (from a US bank account, in USD) | **Free** | Cheapest. The bank account must be **in your name**. Up to ~$3,000 can be available instantly. |
| **International wire** | **$50** outgoing (Alpaca side) + **your bank's** wire fee + FX spread | Must be sent **in USD**. Expensive once your bank's fees + poor rate are added. |
| **Local Currency Transfer (CurrencyCloud)** | **1.5%, capped at $40** (each way) | You send your local currency; it's converted to USD. Simple but not the cheapest for larger sums. |
| **Rapyd** (Banking tab) | Varies | Another routed option; check the fee shown. |
| **Crypto transfer** | Network fee only | Possible, but crypto's price swings + complexity make it a poor choice just for funding. |

**The cheapest, safest route for almost everyone is the first one — free ACH — using a
multi-currency account (Wise or Revolut) that gives you US bank details in your own name.**

---

## ✅ Recommended method: Wise (or Revolut) → free ACH into Alpaca

**Why this wins:** you get the **real exchange rate** on the GBP→USD conversion (a small,
transparent fee instead of a hidden 1–3% bank spread), and then the dollars move into
Alpaca by **free ACH** — so you avoid both the $50 wire fee and the 1.5% conversion fee.

### Step by step (using Wise — Revolut works the same way, see below)

1. **Open a Wise account** at **[wise.com](https://wise.com)** (download the official app
   or use the website — never a link someone sends you). Complete their ID verification.
2. **Open a USD balance / USD account details.** In Wise, add US dollars as a currency
   and choose to **"Get account details."** Wise gives you **US bank details in your name**:
   an **ACH routing number** and an **account number**. *(Tip: Wise may show two routing
   numbers — one for ACH, one for wires. Use the **ACH** one for Alpaca.)*
3. **Put dollars in.** Convert some **GBP → USD** inside Wise. You'll see the exact rate
   (the mid-market rate) and the small fee up front before you confirm. You can convert now
   or hold GBP and convert when the rate looks better.
4. **Link that US account to Alpaca.** In your Alpaca dashboard → **Funds & Wallet / Add
   Funds → ACH**, add a bank using the **routing + account number** Wise gave you. Because
   the Wise USD account is **in your name**, it satisfies Alpaca's "must be your own account"
   rule.
5. **Deposit.** Choose the amount and confirm. ACH is **free**; part may be available almost
   immediately, the rest after it settles (usually a few business days).
6. **Verify** it arrived on Alpaca's Funds/History page before doing anything else.

### Revolut instead of Wise
Revolut also offers a **USD account** with US ACH details and cheap USD transfers (ACH
around **0.2%** or a small minimum). The steps are identical: open Revolut → enable a USD
account → convert GBP→USD → link those US details to Alpaca via ACH. Wise tends to be the
most transparent on the exchange rate; Revolut can be marginally cheaper on the transfer
itself. Either is a solid, safe choice — pick whichever you already trust.

> **One thing to verify (do the small test):** a few brokers occasionally flag
> multi-currency accounts like Wise/Revolut as "third-party." Alpaca users have funded
> successfully this way, but confirm it works for **your** account by sending a small test
> deposit first. If ACH is ever rejected, fall back to the CurrencyCloud or wire method below.

---

## The "official" routes (simpler, but usually pricier)

If you'd rather not use Wise/Revolut, Alpaca supports these directly:

- **Local Currency Transfer (CurrencyCloud):** in the Alpaca dashboard, choose Local
  Currency Transfer, give your **IBAN**, and Alpaca creates a wallet with wire details.
  You send GBP; it's converted to USD. Fee: **1.5%, capped at $40** each way. Easiest for a
  one-off, and the $40 cap makes it reasonable for **larger** deposits.
- **International wire (in USD):** select **International Wire Transfer** to get instructions,
  then send a **USD** wire from your bank. Alpaca charges **$50** on the way out; **your own
  bank** will also charge a wire fee and usually a poor exchange rate — so this is typically
  the **most expensive** option. Only worth it if you have no alternative.

---

## 🔒 Safety checklist (do not skip)

- **Only use official apps/sites:** `wise.com`, `revolut.com`, `alpaca.markets`. Type the
  address yourself or use the official app store — **never a link from an email, DM, or
  stranger.**
- **Nobody legitimate will ever ask you to redirect your deposit to a "different" account.**
  If someone does, it's a scam — stop.
- **Never share** your passwords, one-time codes, or 2FA. Alpaca/Wise/Revolut will never ask.
- **Double-check the account number and routing number** before you send. A transfer to the
  wrong details can be very hard to recover.
- **Turn on two-factor authentication (2FA)** on Alpaca, Wise/Revolut, and your email.
- **Keep records** of every transfer (screenshots/confirmations) for your own reference and
  for tax.
- **Test small first.** Move £50–£100 end-to-end and confirm it lands in Alpaca **before**
  sending a larger amount.

---

## 🧾 Tax & legal (please read)

- As a **non-US person**, Alpaca will have you complete a **W-8BEN** form during sign-up —
  this certifies you're not a US taxpayer (and may reduce US withholding under the UK–US
  tax treaty). Fill it in accurately.
- Moving money abroad and holding US investments can have **tax reporting obligations in
  your home country.** This guide does **not** cover tax — **speak to a qualified tax
  professional** about your situation.
- **Check Alpaca is available in your country** before you start (Alpaca's "Countries Alpaca
  is available" support page). If it isn't, none of the above applies.

---

## Don't forget the return trip (withdrawals)

Getting money **out** has costs too: ACH withdrawals to a US (Wise/Revolut) account are
typically free, CurrencyCloud is again **1.5%/$40**, and an international wire out is **$50**.
The cheapest round trip is the same as the way in — **withdraw by ACH to your Wise/Revolut
USD account, then convert USD→GBP there** at the real rate.

---

## Quick summary

1. **Wise or Revolut** → open a **USD account** (US bank details in your name).
2. Convert **GBP → USD** there at the real rate (small, visible fee).
3. Link those US details to **Alpaca via ACH** → **free** deposit.
4. **Test small first**, use only official apps, and keep records.

This keeps your total cost to little more than the currency conversion itself — far less
than a traditional international bank wire.

---

*Sources (verify current details yourself):
[Alpaca — international funding](https://alpaca.markets/support/international-use-fund-account),
[Alpaca — fund a live Trading account](https://alpaca.markets/learn/fund-live-trading-account),
[Alpaca — fees for transfers outside the US](https://alpaca.markets/support/fees-transfers-outside-us),
[Alpaca — countries available](https://alpaca.markets/support/countries-alpaca-is-available),
[Wise — USD transfers guide](https://wise.com/help/articles/2932150/guide-to-usd-transfers).*
