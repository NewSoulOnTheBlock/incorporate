// The halving schedule. Pure functions, no I/O, no chain, no clock.
//
// The pool's clock is the KEEPER's settlement count, not chain time and not
// wall time. A pool that the keeper never settled is age zero even if its
// token launched a week ago. This is what makes "pool age is independent of
// token age" true rather than aspirational.

import {
  EPOCHS_PER_ERA, BASE_EMISSION_BPS, MIN_EMISSION_BPS, GAS_FLOAT_WEI,
} from "./config.js";

/** Which era an epoch index falls in. Era 0 is the launch era. */
export function eraOf(epochIndex) {
  if (!Number.isInteger(epochIndex) || epochIndex < 0) {
    throw new TypeError(`epochIndex must be a non-negative integer, got ${epochIndex}`);
  }
  return Math.floor(epochIndex / EPOCHS_PER_ERA);
}

/**
 * Emission rate for an era, in basis points of the spendable budget.
 * Halves each era until it reaches the terminal floor, then stays there
 * forever -- the schedule decays to a constant, it never decays to zero.
 */
export function emissionBps(era) {
  if (!Number.isInteger(era) || era < 0) {
    throw new TypeError(`era must be a non-negative integer, got ${era}`);
  }
  if (era >= 32) return MIN_EMISSION_BPS;        // guard the shift
  const halved = BASE_EMISSION_BPS >> era;
  return halved > MIN_EMISSION_BPS ? halved : MIN_EMISSION_BPS;
}

/**
 * What a launch may spend on miners this epoch: the payout balance less a
 * float kept back so the vault can always afford to send the next payout.
 * "A launch spends what it earned, never what it holds."
 *
 * The float defaults to the native gas reserve. That default is deliberately
 * the SAFE one: a caller who forgets to pass anything withholds gas rather
 * than draining the vault to a balance that cannot pay its own transactions.
 *
 * Launches quoted in an ERC-20 pair pay gas from a separate native balance, so
 * none of their payout asset should be reserved. Those callers pass
 * `{ gasFloat: 0n }` explicitly -- see gasFloatFor().
 */
export function spendableBudget(payoutBalance, opts = {}) {
  const gasFloat = BigInt(opts.gasFloat ?? GAS_FLOAT_WEI);
  // Any opt-in platform fee already carved off the inflow but still sitting in
  // the same balance. Withholding it here keeps the halving schedule running
  // against miner money only, so a fee can never reach into emissions already
  // earned. Zero unless PLATFORM_FEE_BPS is set -- see config.js.
  const withheld = BigInt(opts.buybackOwed ?? 0n);
  const b = BigInt(payoutBalance) - gasFloat - withheld;
  return b > 0n ? b : 0n;
}

/** Total value released to miners this epoch, in the payout asset. */
export function epochEmission(payoutBalance, epochIndex, opts = {}) {
  const budget = spendableBudget(payoutBalance, opts);
  return (budget * BigInt(emissionBps(eraOf(epochIndex)))) / 10_000n;
}

/**
 * The gas float for a launch, in its payout asset.
 *
 * Only native launches reserve gas out of the payout balance, because only
 * there are the payout asset and the gas asset the same thing. Withholding
 * "0.002" from a 6-decimal USDG balance would silently hold back 2 billion
 * base units of someone else's money.
 */
export function gasFloatFor({ native }) {
  return native ? GAS_FLOAT_WEI : 0n;
}

/**
 * The reserve multiple an era implies: how many epochs of inflow must be
 * standing in the vault for payouts to hold steady. It is just the inverse of
 * the emission rate, which is why the multiple doubles exactly as the rate
 * halves.
 */
export function reserveMultiple(era) {
  return 10_000 / emissionBps(era);
}
