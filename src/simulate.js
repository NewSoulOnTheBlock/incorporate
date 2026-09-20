// Offline economic simulation. Runs the REAL schedule and allocator -- the
// same modules the keeper uses -- over many epochs with no chain and no
// database, so the dynamics can be inspected before any value is at risk.
//
//   node src/simulate.js [epochs] [miners]

import { ethers } from "ethers";
import { eraOf, emissionBps, epochEmission } from "./schedule.js";
import { allocate, tenureMult, uptimeMult } from "./hashrate.js";
import { MULT_SCALE, EPOCHS_PER_ERA, CREATOR_TAX_BPS } from "./config.js";
import { resolvePair } from "./pairs.js";
import { splitInflow } from "./tax.js";

const PAIR = resolvePair(process.env.PAIR || "ETH");

const EPOCHS = Number(process.argv[2] || 30);
const N = Number(process.argv[3] || 30);

const E = (w) => Number(ethers.formatEther(w)).toFixed(6);
const mult = (m) => (Number(m) / Number(MULT_SCALE)).toFixed(2);

// A deliberately lopsided holder distribution: a few whales and a long tail of
// small positions. This is the case where the payout cap actually bites, so it
// is the case worth simulating.
const miners = Array.from({ length: N }, (_, i) => ({
  address: "0x" + String(i).padStart(40, "0"),
  holdings: BigInt(Math.floor(1_000_000 / (i + 1))),
  epochsHeld: 0,
  consecutiveMissed: 0,
}));

// Trading never stops, so the vault keeps receiving tax while it pays out.
const INFLOW_PER_EPOCH = ethers.parseEther("0.05");
let vault = ethers.parseEther("1.0");
let paidOut = 0n;

console.log(`simulating ${EPOCHS} epochs, ${N} miners, ${CREATOR_TAX_BPS / 100}% block reward`);
console.log(`start vault ${E(vault)} ETH, inflow ${E(INFLOW_PER_EPOCH)} ETH/epoch\n`);
console.log("epoch era   rate     vault     emission      paid  paid/lit  dark");
console.log("-".repeat(72));

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  vault += INFLOW_PER_EPOCH; // trading tax arrives

  const emission = epochEmission(vault, epoch);
  const { paid, totalPaid } = allocate(miners, emission, { dustFloor: PAIR.dustFloor });

  const paidSet = new Set(paid.map((p) => p.address));
  let dark = 0;
  for (const m of miners) {
    m.epochsHeld += 1;
    m.consecutiveMissed = paidSet.has(m.address) ? 0 : m.consecutiveMissed + 1;
    if (uptimeMult(m.consecutiveMissed) === 0n) dark++;
  }

  vault -= totalPaid;
  paidOut += totalPaid;

  const era = eraOf(epoch);
  if (epoch % EPOCHS_PER_ERA === 0 || epoch === EPOCHS - 1) {
    console.log(
      String(epoch).padStart(5) +
      String(era).padStart(4) +
      (emissionBps(era) / 100).toFixed(2).padStart(7) + "%" +
      E(vault).padStart(11) +
      E(emission).padStart(13) +
      E(totalPaid).padStart(10) +
      String(paid.length).padStart(10) +
      String(dark).padStart(6));
  }
}

console.log("-".repeat(72));
console.log(`total paid to miners : ${E(paidOut)} ETH`);
console.log(`vault remaining      : ${E(vault)} ETH`);
console.log(`vault never emptied  : ${vault > 0n}`);

console.log("\ntenure ramp (1x -> 4x over 3 eras)");
for (const e of [0, 3, 5, 8, 10, 15, 20]) {
  console.log(`  epoch ${String(e).padStart(3)} held -> ${mult(tenureMult(e))}x`);
}

console.log("\nuptime decay (halves per consecutive miss)");
for (const m of [0, 1, 2, 3, 4]) {
  const u = uptimeMult(m);
  console.log(`  ${m} missed -> ${mult(u)}x${u === 0n ? "   DARK, share forfeited" : ""}`);
}
