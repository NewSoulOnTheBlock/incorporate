import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitInflow, minerTaxPct, buybackTaxPct } from "../src/tax.js";
import { spendableBudget, epochEmission, gasFloatFor } from "../src/schedule.js";
import { resolvePair, PAIRS, isNative, NATIVE } from "../src/pairs.js";
import { allocate } from "../src/hashrate.js";
import { CREATOR_TAX_BPS, MINER_TAX_BPS, BUYBACK_TAX_BPS } from "../src/config.js";

const ETH = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("tax split", () => {
  // This protocol splits the creator tax 3/1 by design: 3% is the block
  // reward, 1% buys and burns the platform token. The 1% is a deliberate
  // product decision, not an accident, and it is the default.
  test("the split is internally consistent whatever it is set to", () => {
    assert.equal(MINER_TAX_BPS + BUYBACK_TAX_BPS, CREATOR_TAX_BPS);
    assert.equal(minerTaxPct() + buybackTaxPct(), CREATOR_TAX_BPS / 100);
    assert.ok(BUYBACK_TAX_BPS < CREATOR_TAX_BPS, "the fee is a slice OF the tax, not an addition");
  });

  // The split is 3% miners / 1% burn. Stated as a hard assertion so that
  // silently reverting it to 4/0 -- or to any other ratio -- fails loudly here
  // instead of quietly changing what every miner is paid.
  test("the protocol default is 3% miners and 1% buyback", () => {
    assert.equal(CREATOR_TAX_BPS, 400, "the token still charges 4% on-chain");
    assert.equal(MINER_TAX_BPS, 300);
    assert.equal(BUYBACK_TAX_BPS, 100);
    assert.equal(minerTaxPct(), 3);
    assert.equal(buybackTaxPct(), 1);
  });

  test("a 4-unit inflow splits into exactly 3 for miners and 1 for the burn", () => {
    const { miner, buyback } = splitInflow(ETH(4));
    assert.equal(miner, ETH(3));
    assert.equal(buyback, ETH(1));
  });

  // These hold for ANY configured split, which is what makes the knob safe to
  // turn. They are the properties that must survive a change to the constant.
  test("the split is exact -- not one wei is created or lost", () => {
    for (const amt of [0n, 1n, 3n, 7n, 999n, ETH(1), ETH(0.0001), 12345678901n]) {
      const { miner, buyback } = splitInflow(amt);
      assert.equal(miner + buyback, BigInt(amt), `split must be exact for ${amt}`);
      assert.ok(miner >= 0n && buyback >= 0n, "neither side may go negative");
    }
  });

  test("rounding can only ever favour miners", () => {
    // Integer division floors the platform side, so the remainder goes to
    // miners. Dust must never accumulate on the platform's side of the line.
    for (const amt of [1n, 3n, 7n, 99n, 4001n]) {
      const { miner, buyback } = splitInflow(amt);
      const exact = (BigInt(amt) * BigInt(BUYBACK_TAX_BPS)) / BigInt(CREATOR_TAX_BPS);
      assert.equal(buyback, exact);
      assert.ok(miner >= BigInt(amt) - exact, "miners absorb the remainder");
    }
  });

  test("non-positive inflow yields nothing on either side", () => {
    assert.deepEqual(splitInflow(0n), { miner: 0n, buyback: 0n });
    assert.deepEqual(splitInflow(-5n), { miner: 0n, buyback: 0n });
  });
});

describe("withheld value is not miner money", () => {
  // spendableBudget still supports withholding a platform buffer so the knob
  // works end to end; with the fee off, nothing is withheld.
  test("a withheld buffer is excluded from the spendable budget", () => {
    assert.equal(
      spendableBudget(ETH(1), { gasFloat: 0n, buybackOwed: ETH(0.25) }), ETH(0.75));
  });

  test("emission is taken from the budget AFTER withholding", () => {
    // 1 ETH - 0.25 withheld = 0.75 spendable; era 0 pays 8% = 0.06
    assert.equal(
      epochEmission(ETH(1), 0, { gasFloat: 0n, buybackOwed: ETH(0.25) }), ETH(0.06));
  });

  test("gas float and any platform buffer are withheld together", () => {
    assert.equal(
      spendableBudget(ETH(1), { gasFloat: ETH(0.002), buybackOwed: ETH(0.25) }),
      ETH(0.748));
  });

  test("withholding never drives the budget negative", () => {
    assert.equal(spendableBudget(ETH(0.1), { gasFloat: ETH(1), buybackOwed: ETH(1) }), 0n);
  });
});

describe("quote pairs", () => {
  test("every registry entry is internally consistent", () => {
    for (const p of PAIRS) {
      assert.ok(p.symbol && p.address, "needs symbol and address");
      assert.ok(p.decimals >= 0 && p.decimals <= 18, p.symbol + " decimals sane");
      assert.ok(p.dustFloor > 0n, p.symbol + " needs a dust floor");
      assert.equal(p.native, p.address === NATIVE, p.symbol + " native flag matches address");
    }
  });

  // Verified live against the factory: USDG is 6dp and cbBTC is 8dp. Treating
  // either as 18dp would withhold every payout forever.
  test("verified decimals -- USDG is 6dp, cbBTC is 8dp", () => {
    assert.equal(resolvePair("USDG").decimals, 6);
    assert.equal(resolvePair("cbBTC").decimals, 8);
    assert.equal(resolvePair("ETH").decimals, 18);
  });

  test("resolves by ticker or address, case-insensitively", () => {
    assert.equal(resolvePair("usdg").symbol, "USDG");
    assert.equal(resolvePair("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168").symbol, "USDG");
    assert.equal(resolvePair("0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168").symbol, "USDG");
  });

  test("defaults to native ETH and recognises the zero address", () => {
    assert.equal(resolvePair().symbol, "ETH");
    assert.ok(isNative(NATIVE));
    assert.ok(!isNative(resolvePair("USDG").address));
  });

  test("an unknown pair throws instead of launching against the wrong asset", () => {
    assert.throws(() => resolvePair("DOGE"), /Unknown quote pair/);
  });

  // Gas is always native. A USDG launch pays gas from a separate native
  // balance, so none of its USDG payout balance is reserved for gas.
  test("only native launches reserve payout balance for gas", () => {
    assert.ok(gasFloatFor(resolvePair("ETH")) > 0n);
    assert.equal(gasFloatFor(resolvePair("USDG")), 0n);
  });

  test("allocate refuses to run without an explicit per-asset dust floor", () => {
    const m = [{ address: "0xa", holdings: 1n, epochsHeld: 15, consecutiveMissed: 0 }];
    assert.throws(() => allocate(m, ETH(1)), /requires opts.dustFloor/);
  });

  test("the same integer is dust in USDG but real money in cbBTC", () => {
    assert.ok(1000n < resolvePair("USDG").dustFloor, "1000 USDG units is a tenth of a cent");
    assert.ok(1000n > resolvePair("cbBTC").dustFloor, "1000 satoshi is a real payment");
  });
});
