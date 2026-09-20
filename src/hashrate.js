// Hashrate and share allocation. Pure functions, BigInt end to end.
//
//   hashrate = holdings x tenure x uptime
//
// Holdings scale linearly, which is the deliberate reason splitting a position
// across wallets gains nothing: the sum of the parts equals the whole.

import {
  MULT_SCALE, TENURE_MIN_BPS, TENURE_MAX_BPS, TENURE_RAMP_EPOCHS,
  UPTIME_DARK_AFTER, MAX_PAYOUTS_PER_EPOCH,
} from "./config.js";

/**
 * Tenure multiplier, 1x -> 4x, accruing continuously and capping after three
 * eras. Returned in MULT_SCALE fixed point. Measured in epochs the pool has
 * settled while this miner held, not in seconds.
 */
export function tenureMult(epochsHeld) {
  if (!Number.isInteger(epochsHeld) || epochsHeld < 0) {
    throw new TypeError(`epochsHeld must be a non-negative integer, got ${epochsHeld}`);
  }
  const held = Math.min(epochsHeld, TENURE_RAMP_EPOCHS);
  const span = TENURE_MAX_BPS - TENURE_MIN_BPS;
  const bps = TENURE_MIN_BPS + Math.floor((span * held) / TENURE_RAMP_EPOCHS);
  return (BigInt(bps) * MULT_SCALE) / 10_000n;
}

/**
 * Uptime multiplier. Full while mining, halving on each consecutive missed
 * epoch, and hard zero once the miner has been dark for UPTIME_DARK_AFTER
 * epochs in a row. Forfeited weight is not burned -- it simply is not counted,
 * so the remaining lit miners divide the same emission among fewer shares.
 */
export function uptimeMult(consecutiveMissed) {
  if (!Number.isInteger(consecutiveMissed) || consecutiveMissed < 0) {
    throw new TypeError(`consecutiveMissed must be a non-negative integer, got ${consecutiveMissed}`);
  }
  if (consecutiveMissed >= UPTIME_DARK_AFTER) return 0n;
  return MULT_SCALE >> BigInt(consecutiveMissed);
}

/** hashrate = holdings x tenure x uptime, in raw token-units x 1.0 */
export function hashrateOf({ holdings, epochsHeld, consecutiveMissed }) {
  const h = BigInt(holdings);
  if (h <= 0n) return 0n;
  return (h * tenureMult(epochsHeld) * uptimeMult(consecutiveMissed)) / (MULT_SCALE * MULT_SCALE);
}

/**
 * Allocate one epoch's emission across miners.
 *
 * Largest share first, bounded at MAX_PAYOUTS_PER_EPOCH. A share below the
 * dust floor costs more in gas than it delivers, so it is skipped and stays in
 * the vault for the next epoch rather than being burned on fees.
 *
 * dustFloor is REQUIRED and is denominated in the launch's payout asset. There
 * is deliberately no global default: 0.0001 ETH and 0.0001 USDG are not
 * remotely the same amount of money, so a shared fallback would quietly pay
 * worthless dust on some assets and withhold real money on others.
 *
 * @param miners [{ address, holdings, epochsHeld, consecutiveMissed }]
 * @returns { paid: [{address, amount, hashrate}], skipped: [...], totalPaid, totalHashrate }
 */
export function allocate(miners, emissionWei, opts = {}) {
  const maxPayouts = opts.maxPayouts ?? MAX_PAYOUTS_PER_EPOCH;
  if (opts.dustFloor === undefined || opts.dustFloor === null) {
    throw new TypeError("allocate() requires opts.dustFloor in the payout asset's smallest unit");
  }
  const dustFloor = BigInt(opts.dustFloor);
  const emission = BigInt(emissionWei);

  const scored = miners
    .map((m) => ({ ...m, hashrate: hashrateOf(m) }))
    .filter((m) => m.hashrate > 0n);

  const totalHashrate = scored.reduce((a, m) => a + m.hashrate, 0n);
  if (totalHashrate === 0n || emission <= 0n) {
    return { paid: [], skipped: [], totalPaid: 0n, totalHashrate };
  }

  // Deterministic order: hashrate desc, then address asc so ties never depend
  // on the order the indexer happened to return rows in.
  scored.sort((a, b) =>
    a.hashrate === b.hashrate
      ? a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
      : b.hashrate > a.hashrate ? 1 : -1);

  const paid = [];
  const skipped = [];
  let totalPaid = 0n;

  for (const m of scored) {
    // Every miner's share is computed against the FULL hashrate, so being
    // outside the payout window never inflates anyone else's cheque.
    const amount = (emission * m.hashrate) / totalHashrate;

    if (paid.length >= maxPayouts) {
      skipped.push({ ...m, amount, reason: "payout-cap" });
      continue;
    }
    if (amount < dustFloor) {
      skipped.push({ ...m, amount, reason: "dust" });
      continue;
    }
    paid.push({ address: m.address, amount, hashrate: m.hashrate });
    totalPaid += amount;
  }

  return { paid, skipped, totalPaid, totalHashrate };
}
