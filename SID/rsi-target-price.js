// ─────────────────────────────────────────────────────────────────────────────
// rsi-target-price.js  —  SID v2.2 intraday-TP helper
//
// Computes the exact price the NEXT bar would have to print for Wilder's
// RSI(period) to equal a target level (default 50). The SID strategy takes
// TP1 at RSI 50; translating that into a price lets us rest a real limit order
// on Alpaca that fills INTRADAY the moment price touches it — instead of only
// checking the daily close once per run.
//
// Math (Wilder smoothing, target=50 => avgGain_next == avgLoss_next):
//   x = prevClose + (avgLoss - avgGain) * (period - 1)
// where avgGain/avgLoss are the smoothed averages through the latest close.
// One formula serves both directions:
//   • short (overbought, RSI>50): avgGain>avgLoss  => x < prevClose (price falls to 50)
//   • long  (oversold,  RSI<50): avgLoss>avgGain  => x > prevClose (price rises to 50)
//
// Verified against bot-sid.js calcRSI: appending the returned price and
// recomputing RSI yields 50.0 (±rounding) in both directions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number[]} closes  chronological closing prices (oldest → newest)
 * @param {number}   period  RSI lookback (default 14)
 * @param {number}   target  RSI level to solve for (default 50)
 * @returns {number|null}    price for next bar that yields RSI==target, or null
 */
export function rsiTargetPrice(closes, period = 14, target = 50) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  // Seed: simple average of first `period` changes (matches calcRSI exactly)
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing forward to the latest close
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  const prevClose = closes[closes.length - 1];
  const p1 = period - 1;
  const k  = target / 100; // desired gain-share of (gain+loss)

  // "price up" branch (diff >= 0): loss frozen, gain grows
  const up = ((k * avgLoss - (1 - k) * avgGain) * p1) / (1 - k);
  if (up >= 0) return parseFloat((prevClose + up).toFixed(2));

  // "price down" branch (diff < 0): gain frozen, loss grows
  const L = (avgGain * p1 * (1 - k) - k * avgLoss * p1) / k; // = prevClose - x
  return parseFloat((prevClose - L).toFixed(2));
}

export default rsiTargetPrice;
