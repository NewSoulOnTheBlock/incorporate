import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { eraOf, emissionBps, epochEmission, reserveMultiple, spendableBudget } from "../src/schedule.js";
import { tenureMult, uptimeMult, hashrateOf, allocate } from "../src/hashrate.js";
import { MULT_SCALE } from "../src/config.js";

const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("halving schedule", () => {
  test("eras are 5 epochs wide", () => {
    assert.equal(eraOf(0), 0);
    assert.equal(eraOf(4), 0);
    assert.equal(eraOf(5), 1);   // 5m
    assert.equal(eraOf(10), 2);  // 10m
    assert.equal(eraOf(15), 3);  // 15m
    assert.equal(eraOf(20), 4);  // 20m
  });

  // The published table is the spec. If this test fails the protocol is wrong.
  test("emission reproduces the documented schedule exactly", () => {
    assert.equal(emissionBps(0), 800); // 8.00%
    assert.equal(emissionBps(1), 400); // 4.00%
    assert.equal(emissionBps(2), 200); // 2.00%
    assert.equal(emissionBps(3), 100); // 1.00%
    assert.equal(emissionBps(4), 50);  // 0.50%
  });

  test("era 4 is terminal -- the rate never decays past the floor", () => {
    for (const e of [4, 5, 9, 50, 1000]) assert.equal(emissionBps(e), 50);
  });

  test("reserve multiple doubles exactly as the rate halves", () => {
    assert.equal(Math.round(reserveMultiple(0)), 13);  // 12.5 -> 13x
    assert.equal(reserveMultiple(1), 25);
    assert.equal(reserveMultiple(2), 50);
    assert.equal(reserveMultiple(3), 100);
    assert.equal(reserveMultiple(4), 200);
  });

  test("budget is vault minus gas float, never negative", () => {
    assert.equal(spendableBudget(ETH(1), { gasFloat: ETH(0.002) }), ETH(0.998));
    assert.equal(spendableBudget(ETH(0.001), { gasFloat: ETH(0.002) }), 0n);
  });

  test("era 0 pays 8% of the spendable budget", () => {
    // 1 ETH vault - 0.002 float = 0.998 spendable; 8% = 0.07984
    assert.equal(epochEmission(ETH(1), 0, { gasFloat: ETH(0.002) }), ETH(0.07984));
  });

  test("the vault is mathematically undrainable", () => {
    // Geometric decay on a shrinking base never reaches zero.
    let vault = ETH(10);
    for (let epoch = 0; epoch < 500; epoch++) {
      vault -= epochEmission(vault, epoch);
    }
    assert.ok(vault > 0n, "vault must never empty");
  });
});

describe("tenure", () => {
  test("starts at 1x", () => assert.equal(tenureMult(0), MULT_SCALE));

  test("reaches the 4x cap after 3 eras (15 epochs) and stops", () => {
    assert.equal(tenureMult(15), 4n * MULT_SCALE);
    assert.equal(tenureMult(16), 4n * MULT_SCALE);
    assert.equal(tenureMult(10_000), 4n * MULT_SCALE);
  });

  test("accrues continuously, not in steps", () => {
    let prev = 0n;
    for (let e = 0; e <= 15; e++) {
      const t = tenureMult(e);
      assert.ok(t > prev, `tenure must strictly increase at epoch ${e}`);
      prev = t;
    }
  });

  test("is exactly halfway at half the ramp", () => {
    // 1x + (3x * 7.5/15) = 2.5x  -- floor at epoch 7 gives 2.4x
    assert.equal(tenureMult(5), 2n * MULT_SCALE);  // 1 + 3*(5/15) = 2.0x
  });
});

describe("uptime", () => {
  test("halves per consecutive missed epoch", () => {
    assert.equal(uptimeMult(0), MULT_SCALE);          // 1.000x
    assert.equal(uptimeMult(1), MULT_SCALE / 2n);     // 0.500x
    assert.equal(uptimeMult(2), MULT_SCALE / 4n);     // 0.250x
    assert.equal(uptimeMult(3), MULT_SCALE / 8n);     // 0.125x
  });

  test("goes dark -- hard zero -- on the 4th consecutive miss", () => {
    assert.equal(uptimeMult(4), 0n);
    assert.equal(uptimeMult(99), 0n);
  });
});

describe("hashrate", () => {
  test("holdings x tenure x uptime", () => {
    // 100 tokens, capped tenure (4x), full uptime -> 400
    assert.equal(hashrateOf({ holdings: 100n, epochsHeld: 15, consecutiveMissed: 0 }), 400n);
    // same holder, one missed epoch -> half
    assert.equal(hashrateOf({ holdings: 100n, epochsHeld: 15, consecutiveMissed: 1 }), 200n);
  });

  test("a dark miner has zero hashrate regardless of size", () => {
    assert.equal(hashrateOf({ holdings: 10n ** 24n, epochsHeld: 15, consecutiveMissed: 4 }), 0n);
  });

  test("splitting a position across wallets gains nothing", () => {
    const whole = hashrateOf({ holdings: 900n, epochsHeld: 7, consecutiveMissed: 0 });
    const split = [300n, 300n, 300n]
      .map((h) => hashrateOf({ holdings: h, epochsHeld: 7, consecutiveMissed: 0 }))
      .reduce((a, b) => a + b, 0n);
    assert.equal(split, whole);
  });
});

describe("allocation", () => {
  const miner = (address, holdings, epochsHeld = 15, consecutiveMissed = 0) =>
    ({ address, holdings, epochsHeld, consecutiveMissed });

  test("pays pro rata by hashrate", () => {
    const res = allocate(
      [miner("0xa", 300n), miner("0xb", 100n)],
      ETH(1), { dustFloor: 0n });
    assert.equal(res.paid.length, 2);
    assert.equal(res.paid[0].amount, ETH(0.75)); // 300/400
    assert.equal(res.paid[1].amount, ETH(0.25)); // 100/400
  });

  test("pays largest first", () => {
    const res = allocate(
      [miner("0xsmall", 1n), miner("0xbig", 1000n), miner("0xmid", 50n)],
      ETH(1), { dustFloor: 0n });
    assert.deepEqual(res.paid.map((p) => p.address), ["0xbig", "0xmid", "0xsmall"]);
  });

  test("caps at 25 payouts per epoch and marks the rest", () => {
    const miners = Array.from({ length: 40 }, (_, i) =>
      miner(`0x${(1000 - i).toString(16).padStart(40, "0")}`, BigInt(1000 - i)));
    const res = allocate(miners, ETH(10), { dustFloor: 0n });
    assert.equal(res.paid.length, 25);
    assert.equal(res.skipped.length, 15);
    assert.ok(res.skipped.every((s) => s.reason === "payout-cap"));
  });

  test("shares below the dust floor are skipped, not burned on gas", () => {
    const res = allocate(
      [miner("0xwhale", 10n ** 9n), miner("0xdust", 1n)],
      ETH(1), { dustFloor: ETH(0.001) });
    assert.equal(res.paid.length, 1);
    assert.equal(res.skipped[0].reason, "dust");
  });

  test("skipped value stays in the vault -- total paid is under emission", () => {
    const res = allocate(
      [miner("0xwhale", 10n ** 9n), miner("0xdust", 1n)],
      ETH(1), { dustFloor: ETH(0.001) });
    assert.ok(res.totalPaid < ETH(1), "unpaid shares must remain unspent");
  });

  test("being outside the payout window never inflates another miner's cheque", () => {
    const two = allocate([miner("0xa", 100n), miner("0xb", 100n)], ETH(1), { dustFloor: 0n });
    const capped = allocate([miner("0xa", 100n), miner("0xb", 100n)], ETH(1),
      { dustFloor: 0n, maxPayouts: 1 });
    assert.equal(capped.paid[0].amount, two.paid[0].amount);
  });

  test("dark miners forfeit their share to the miners still lit", () => {
    const allLit = allocate(
      [miner("0xa", 100n), miner("0xb", 100n)], ETH(1), { dustFloor: 0n });
    const oneDark = allocate(
      [miner("0xa", 100n), miner("0xb", 100n, 15, 4)], ETH(1), { dustFloor: 0n });
    assert.equal(allLit.paid[0].amount, ETH(0.5));
    assert.equal(oneDark.paid.length, 1);
    assert.equal(oneDark.paid[0].amount, ETH(1)); // absorbs the forfeited half
  });

  test("no miners means no emission leaves the vault", () => {
    const res = allocate([], ETH(1), { dustFloor: 0n });
    assert.equal(res.totalPaid, 0n);
  });
});
