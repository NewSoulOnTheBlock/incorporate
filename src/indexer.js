// Holder indexing.
//
// "Every holder is a miner" means the miner set is simply the token's holder
// set -- there is no registration, no staking and no deposit. So indexing is
// just replaying Transfer events into a balance table.
//
// Balances are reconstructed from logs rather than polled with balanceOf()
// because the miner set is unbounded and unknown: you cannot call balanceOf on
// addresses you have never heard of. Logs tell you who exists.

import { ethers } from "ethers";
import { provider, erc20 } from "./chain.js";
import { upsertMiner, allMinersFor, resetMinerTenure, setScanned, getLaunch } from "./db.js";

const ZERO = "0x0000000000000000000000000000000000000000";
// Public RPCs cap eth_getLogs ranges. 50k blocks is comfortably inside the
// 100k that this chain's public endpoint was observed to accept.
const CHUNK = Number(process.env.LOG_CHUNK || 50_000);

/**
 * Addresses that hold tokens but are not miners: the zero address (burns), the
 * bonding curve itself (inventory, not a position) and the token contract.
 * Counting the curve as a miner would pay the curve its own trading fees.
 */
function excluded(launch) {
  const set = new Set([ZERO, launch.token.toLowerCase()]);
  if (launch.curve) set.add(launch.curve.toLowerCase());
  return set;
}

/**
 * Scan new Transfer events for one launch and fold them into the miners table.
 * Returns the number of balance changes applied.
 */
export async function syncHolders(launch) {
  const token = erc20(launch.token);
  const head = await provider.getBlockNumber();
  let from = Math.max(launch.scanned_block || launch.launch_block || 0, 0);
  if (from >= head) return 0;

  const skip = excluded(launch);
  // Seed from what we already know so partial scans compose correctly.
  const balances = new Map();
  for (const m of await allMinersFor.all(launch.token)) {
    balances.set(m.address, BigInt(m.holdings));
  }

  const before = new Map(balances);
  let applied = 0;

  // Adaptive range: start wide, halve on provider rejection, recover on
  // success. Public RPCs disagree about how large an eth_getLogs window may
  // be, and the limit moves, so the scanner negotiates rather than assumes.
  let span = CHUNK;
  while (from < head) {
    const to = Math.min(from + span, head);
    let logs;
    try {
      logs = await token.queryFilter(token.filters.Transfer(), from + 1, to);
    } catch (err) {
      if (span > 1_000) { span = Math.floor(span / 2); continue; }
      throw err;
    }

    for (const log of logs) {
      const { from: f, to: t, value } = log.args;
      const v = BigInt(value);
      const fl = f.toLowerCase(), tl = t.toLowerCase();
      if (!skip.has(fl)) balances.set(fl, (balances.get(fl) ?? 0n) - v);
      if (!skip.has(tl)) balances.set(tl, (balances.get(tl) ?? 0n) + v);
      applied++;
    }
    from = to;
    if (span < CHUNK) span = Math.min(span * 2, CHUNK);
  }

  const epoch = launch.epoch_index;
  for (const [addr, bal] of balances) {
    const prev = before.get(addr) ?? 0n;
    if (bal === prev) continue;
    const clamped = bal > 0n ? bal : 0n;
    await upsertMiner.run(launch.token, addr, clamped.toString(), epoch);
    // A position closed to zero forfeits its tenure. Re-entering starts the
    // 1x -> 4x climb over again: tenure cannot be sold and rebought.
    if (clamped === 0n && prev > 0n) await resetMinerTenure.run(epoch, launch.token, addr);
  }

  await setScanned.run(head, launch.token);
  return applied;
}

/** Read a launch's holder set as allocator input. */
export async function minerSet(token) {
  return (await allMinersFor.all(token))
    .filter((m) => BigInt(m.holdings) > 0n)
    .map((m) => ({
      address: m.address,
      holdings: BigInt(m.holdings),
      epochsHeld: m.epochs_held,
      consecutiveMissed: m.consecutive_missed,
    }));
}
