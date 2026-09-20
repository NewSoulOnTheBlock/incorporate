// Platform-fee buffer.
//
// Pons charges ONE creator tax to ONE recipient, so any split has to happen
// off-chain. When PLATFORM_FEE_BPS is non-zero, the slice is carved off each
// inflow the moment it is claimed and parked in `buyback_owed`, where the
// emission schedule cannot see it.
//
// Splitting at INFLOW rather than at emission is the load-bearing choice: the
// halving schedule then runs against a balance holding only miner money, so a
// fee can never reach into emissions already earned.
//
// WHEN THE FEE IS ZERO THIS MODULE DOES NOTHING. Every function short-circuits,
// nothing accrues, and every launch mines its full creator tax -- which is the
// documented behaviour and the default.

import { ethers } from "ethers";
import {
  BUYBACK_TAX_BPS, PLATFORM_TOKEN, PLATFORM_CURVE, BURN_ADDRESS, BUYBACK_MIN_WEI,
} from "./config.js";
import { splitInflow } from "./tax.js";
import { provider, feeOverrides } from "./chain.js";
import { resolvePair, formatAmount } from "./pairs.js";
import {
  activeLaunches, addBuybackOwed, settleBuyback, insertBuyback, now,
} from "./db.js";

/** True when a fee is configured at all. */
export const feeEnabled = () => BUYBACK_TAX_BPS > 0;

/** True once the platform token exists and a burn could actually execute. */
export const buybackLive = () => Boolean(feeEnabled() && PLATFORM_TOKEN && PLATFORM_CURVE);

/**
 * Carve the platform slice off an inflow and park it. Returns the miner share,
 * which is the only part the emission schedule may ever touch.
 */
export function accrueInflow(launch, inflowRaw) {
  if (!feeEnabled()) return BigInt(inflowRaw);

  const { miner, buyback } = splitInflow(inflowRaw);
  if (buyback > 0n) {
    const owed = BigInt(launch.buyback_owed || "0") + buyback;
    addBuybackOwed.run(owed.toString(), launch.token);
  }
  return miner;
}

/**
 * Execute every buffer that has grown past the point of being worth its gas.
 *
 * If the platform token is not deployed, the money STAYS PUT, fully accounted
 * and reported -- it is never silently skipped and never spent on anything
 * else. That is what makes "not deployed yet" auditable rather than invisible.
 */
export async function runBuybacks({ dry = true } = {}) {
  const out = { enabled: feeEnabled(), live: buybackLive(), accrued: [], burned: [], skipped: [] };
  if (!feeEnabled()) return out;

  for (const row of activeLaunches.all()) {
    const owed = BigInt(row.buyback_owed || "0");
    if (owed === 0n) continue;

    const pair = resolvePair(row.pair_token);
    const threshold = pair.native ? BUYBACK_MIN_WEI : pair.dustFloor * 100n;

    if (owed < threshold) {
      out.skipped.push({ token: row.token, owed: owed.toString(), reason: "below-threshold" });
      continue;
    }
    if (!buybackLive()) {
      out.accrued.push({ token: row.token, owed: owed.toString(), reason: "platform-token-not-deployed" });
      continue;
    }
    if (dry) {
      out.accrued.push({ token: row.token, owed: owed.toString(), reason: "dry-run" });
      continue;
    }

    try {
      // Buy the platform token off its own curve, delivered straight to the
      // burn address so the bought supply can never be recovered.
      const curve = new ethers.Contract(PLATFORM_CURVE, [
        "function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
      ], provider);
      const fees = await feeOverrides();
      const tx = pair.native
        ? await curve.buy(owed, 0n, BURN_ADDRESS, { value: owed, ...fees })
        : await curve.buy(owed, 0n, BURN_ADDRESS, fees);
      const rc = await tx.wait();

      const sent = BigInt(row.buyback_sent || "0") + owed;
      settleBuyback.run(sent.toString(), row.token);
      insertBuyback.run(row.token, owed.toString(), pair.symbol, "0", "sent", now());
      out.burned.push({ token: row.token, spent: owed.toString(), tx: rc.hash });
    } catch (err) {
      out.skipped.push({ token: row.token, owed: owed.toString(), reason: err.shortMessage || err.message });
    }
  }
  return out;
}

/** Reportable state, so the buffer is visible whether or not it can be spent. */
export function buybackStatus() {
  const rows = activeLaunches.all();
  const total = rows.reduce((a, r) => a + BigInt(r.buyback_owed || "0"), 0n);
  const sent = rows.reduce((a, r) => a + BigInt(r.buyback_sent || "0"), 0n);
  return {
    enabled: feeEnabled(),
    feeBps: BUYBACK_TAX_BPS,
    live: buybackLive(),
    platformToken: PLATFORM_TOKEN || null,
    owedWei: total.toString(),
    sentWei: sent.toString(),
    note: !feeEnabled()
      ? "no platform fee -- every launch mines its full creator tax"
      : buybackLive()
        ? "buyback active"
        : "platform token not deployed -- fee accruing, nothing spent, nothing burned",
  };
}
