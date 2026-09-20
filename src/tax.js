// Splitting the creator tax.
//
// Pons charges a single 4% creator tax to a single recipient, so the protocol
// takes delivery of the whole 4% and divides it here, at the moment fees land
// in the vault:
//
//     4% inflow  ->  3% miners  +  1% buyback-and-burn
//
// Doing this at INFLOW rather than at emission is the load-bearing choice.
// The halving schedule then runs against a balance that contains only miner
// money, so the burn can never reach into emissions already earned, and the
// claim "a launch pays out what its own trading earned" survives intact.

import { CREATOR_TAX_BPS, MINER_TAX_BPS, BUYBACK_TAX_BPS } from "./config.js";

/**
 * Divide an inflow into the miner share and the buyback share.
 *
 * Integer division floors the buyback and gives the remainder to miners, so
 * the two parts always sum to exactly the input -- not one wei is created or
 * lost -- and rounding error can only ever favour miners.
 *
 * @param amountRaw inflow in the payout asset's smallest unit
 * @returns {{ miner: bigint, buyback: bigint }}
 */
export function splitInflow(amountRaw) {
  const amount = BigInt(amountRaw);
  if (amount <= 0n) return { miner: 0n, buyback: 0n };
  const buyback = (amount * BigInt(BUYBACK_TAX_BPS)) / BigInt(CREATOR_TAX_BPS);
  return { miner: amount - buyback, buyback };
}

/** The effective tax each side represents, for display. 3% and 1%. */
export const minerTaxPct = () => MINER_TAX_BPS / 100;
export const buybackTaxPct = () => BUYBACK_TAX_BPS / 100;
