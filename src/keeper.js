// The keeper: one process that settles every pool once per epoch.
//
// Each pass runs four steps per launch:
//
//   1. SWEEP   pull accrued trading tax out of the curve toward the escrow.
//              Blocked once a launch graduates -- after graduation the curve
//              no longer holds the fee stream.
//   2. CLAIM   the vault calls the escrow and withdraws what it has accrued.
//              This is the only step that moves value INTO the vault.
//   3. SETTLE  read holders, compute hashrate, take the era's percentage.
//   4. PAY     transfer shares largest-first, bounded per epoch.
//
// The pool's clock is this process's settlement count, not wall time. A pool
// only ages when it is actually settled, which is why a keeper outage pauses
// the halving schedule instead of silently fast-forwarding through it.

import { ethers } from "ethers";
import {
  EPOCH_SECONDS, FEE_ESCROW, MAX_PAYOUTS_PER_EPOCH, MIN_GAS_WEI,
} from "./config.js";
import { provider, curve, erc20, ERC20_ABI, ESCROW_ABI, feeOverrides } from "./chain.js";
import { eraOf, emissionBps, epochEmission, gasFloatFor } from "./schedule.js";
import { allocate } from "./hashrate.js";
import { resolvePair, formatAmount } from "./pairs.js";
import { accrueInflow } from "./buyback.js";
import { syncHolders, minerSet } from "./indexer.js";
import {
  activeLaunches, getLaunch, bumpEpoch, setGraduated, insertReceipt, markReceipt,
  insertEpoch, updateMinerEpoch, beat, now,
} from "./db.js";
import { vaultSigner } from "./vault.js";

const DRY = process.env.KEEPER_EXECUTE !== "1";
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------- 1. sweep
/**
 * Ask the curve to push accrued fees toward the escrow. Curve builds do not
 * all expose the same entry point and none of them are documented, so this is
 * best-effort: if no known selector is present we proceed anyway, because fees
 * route to the escrow on trade and the claim step still works.
 */
async function sweep(launch, signer) {
  if (launch.graduated || !launch.curve) return false;
  const c = new ethers.Contract(launch.curve, [
    "function sweepFees() returns (uint256)",
    "function collectFees() returns (uint256)",
  ], signer);
  for (const fn of ["sweepFees", "collectFees"]) {
    try {
      await c[fn].staticCall();
      if (DRY) { log(`  [dry] would ${fn}() on curve`); return true; }
      const tx = await c[fn](await feeOverrides());
      await tx.wait();
      log(`  swept via ${fn}()`);
      return true;
    } catch { /* selector absent or nothing to sweep -- try the next */ }
  }
  return false;
}

// ------------------------------------------------------------------- 2. claim
/** Vault withdraws its accrued creator tax from the fee escrow. */
async function claim(launch, signer, pair) {
  const escrow = new ethers.Contract(FEE_ESCROW, ESCROW_ABI, signer);
  let accrued = 0n;
  try { accrued = await escrow.balanceOf(launch.vault); }
  catch { return 0n; }
  if (accrued === 0n) return 0n;

  if (DRY) { log(`  [dry] would claim ${formatAmount(accrued, pair)}`); return accrued; }
  const tx = await escrow.claim(await feeOverrides());
  await tx.wait();
  log(`  claimed ${formatAmount(accrued, pair)} -> vault`);
  return accrued;
}

// ---------------------------------------------------------- 3+4. settle & pay
let STEP = "idle";
async function settle(launch) {
  STEP = "start";
  const epoch = launch.epoch_index;
  const era = eraOf(epoch);
  const bps = emissionBps(era);

  STEP = "syncHolders";
  await syncHolders(await getLaunch.get(launch.token));

  // The quote asset IS the payout asset: a USDG-quoted launch earns its tax
  // in USDG and therefore pays its miners USDG.
  const pair = resolvePair(launch.pair_token);
  const signer = vaultSigner(launch.vault_salt);

  // Gas is always native, whatever the payout asset. A vault that cannot
  // afford its own transactions is reported stalled rather than allowed to
  // half-pay an epoch and leave miners inconsistently dark.
  STEP = "getBalance";
  const gasBal = await provider.getBalance(launch.vault);
  if (!DRY && gasBal < MIN_GAS_WEI) {
    log(`  ! vault out of gas (${ethers.formatEther(gasBal)} ETH) -- skipping epoch`);
    return;
  }

  if (!launch.imported) {
  STEP = "sweep";
    await sweep(launch, signer);
    // The whole 4% lands in the vault, then is split the instant it arrives:
    // 3% stays minable, 1% is set aside for the burn and is invisible to the
    // emission schedule from here on.
  STEP = "claim";
    const accrued = await claim(launch, signer, pair);
    if (accrued > 0n && !DRY) await accrueInflow(await getLaunch.get(launch.token), accrued);
  }

  const vaultBal = pair.native
    ? await provider.getBalance(launch.vault)
    : await erc20(pair.address).balanceOf(launch.vault);

  const owed = BigInt((await getLaunch.get(launch.token) || {}).buyback_owed || "0");
  const emission = epochEmission(vaultBal, epoch, {
    gasFloat: gasFloatFor(pair),
    buybackOwed: owed,
  });
  STEP = "minerSet";
  const miners = await minerSet(launch.token);

  const { paid, skipped, totalPaid, totalHashrate } =
    allocate(miners, emission, { dustFloor: pair.dustFloor, maxPayouts: MAX_PAYOUTS_PER_EPOCH });

  log(`  epoch ${epoch} era ${era} @ ${(bps / 100).toFixed(2)}% | vault ${formatAmount(vaultBal, pair)}`);
  log(`  burn buffer ${formatAmount(owed, pair)} withheld from emission`);
  log(`  emission ${formatAmount(emission, pair)} | ${miners.length} miners -> ${paid.length} paid, ${skipped.length} skipped`);

  STEP = "receipts";
  const ts = now();
  const paidSet = new Set(paid.map((p) => p.address));
  const amountByAddr = new Map(paid.map((p) => [p.address, p.amount]));

  // Receipts are written BEFORE the transfers. The (token, epoch, miner)
  // primary key means a crashed-and-restarted pass collides on insert rather
  // than paying the same epoch twice.
  for (const p of paid) {
    await insertReceipt.run(launch.token, epoch, p.address, p.amount.toString(),
                      p.hashrate.toString(), DRY ? "dry" : "pending", ts);
  }

  let sent = 0n;
  if (!DRY) {
    const fees = await feeOverrides();
    const payToken = pair.native ? null : new ethers.Contract(pair.address, ERC20_ABI, signer);
    for (const p of paid) {
      try {
        const tx = payToken
          ? await payToken.transfer(p.address, p.amount, fees)
          : await signer.sendTransaction({ to: p.address, value: p.amount, ...fees });
        await tx.wait();
        await markReceipt.run("sent", tx.hash, launch.token, epoch, p.address);
        sent += p.amount;
      } catch (err) {
        await markReceipt.run("failed", null, launch.token, epoch, p.address);
        log(`  ! payout to ${p.address} failed: ${err.shortMessage || err.message}`);
      }
    }
  }

  // Tenure advances for every holder. Uptime decays only for those who went
  // unpaid -- that is precisely what a "missed epoch" is here.
  for (const m of miners) {
    const hit = paidSet.has(m.address);
    const missed = hit ? 0 : m.consecutiveMissed + 1;
    const share = amountByAddr.get(m.address) ?? 0n;
    await updateMinerEpoch.run(m.epochsHeld + 1, missed, share.toString(), launch.token, m.address);
  }

  STEP = "insertEpoch";
  await insertEpoch.run(launch.token, epoch, era, bps, vaultBal.toString(), emission.toString(),
                  totalPaid.toString(), totalHashrate.toString(), miners.length, paid.length, ts);

  const mined = BigInt(launch.total_mined_wei) + (DRY ? 0n : sent);
  STEP = "bumpEpoch";
  await bumpEpoch.run(ts, mined.toString(), launch.token);

  // Graduation is terminal for the sweep step, so keep the flag current.
  if (launch.curve && !launch.graduated) {
    try {
      if (await curve(launch.curve).graduated()) {
        await setGraduated.run(1, launch.token);
        log("  graduated -- sweeps now blocked, vault keeps paying");
      }
    } catch { /* curve may not expose it */ }
  }
}

// --------------------------------------------------------------------- driver
export async function pass() {
  const launches = await activeLaunches.all();
  log(`keeper pass: ${launches.length} pool(s)${DRY ? "  [DRY RUN]" : ""}`);
  for (const l of launches) {
    log(` ${l.symbol} ${l.token}`);
    try { await settle(l); }
    catch (err) {
      // "400 Bad Request" can come from the RPC or from the Postgres HTTP
      // driver, and they need opposite fixes -- so report enough to tell them
      // apart instead of collapsing both to one line.
      log(`  ! ${l.symbol} failed at [${STEP}]: ${err.shortMessage || err.message}`);
      if (err.code) log(`    code : ${err.code}`);
      if (err.info) log(`    info : ${JSON.stringify(err.info).slice(0, 400)}`);
      if (err.error) log(`    error: ${JSON.stringify(err.error).slice(0, 400)}`);
      if (err.sourceError) log(`    src  : ${String(err.sourceError).slice(0, 300)}`);
      const line = (err.stack || "").split("
")[1];
      if (line) log(`    at   : ${line.trim().slice(0, 180)}`);
    }
  }
  await beat.run(now());
}

async function main() {
  if (DRY) log("KEEPER_EXECUTE is not 1 -- DRY RUN. No value will move.");
  await pass();
  setInterval(() => pass().catch((e) => log("pass error:", e.message)), EPOCH_SECONDS * 1000);
  log(`keeper running: one pass every ${EPOCH_SECONDS}s`);
}

const invoked = Boolean(process.argv[1]) && /keeper\.js$/.test(process.argv[1].split(/[\/]/).pop());
if (invoked) main();
