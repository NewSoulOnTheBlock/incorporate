// Protocol constants. Everything the economics depend on lives here and
// nowhere else, so the ruleset can be read in one screen and changed in one
// place. All rates are integer basis points -- no floating point ever touches
// a number that becomes a payout.

// ---------------------------------------------------------------- time units
export const EPOCH_SECONDS = 60;      // one settlement cycle
export const EPOCHS_PER_ERA = 5;      // one halving interval (5 minutes)

// ------------------------------------------------------------------ emission
// Each epoch pays a percentage OF THE CURRENT VAULT BALANCE, not a fixed sum.
// Because the base is what remains, the schedule is geometric and the vault is
// mathematically undrainable: it asymptotes rather than empties. Halving does
// not cut miner income in steady state, it doubles the reserve backing it.
//
//   era 0 -> 800bps (8.00%)   reserve multiple  13x inflow
//   era 1 -> 400bps (4.00%)                     25x
//   era 2 -> 200bps (2.00%)                     50x
//   era 3 -> 100bps (1.00%)                    100x
//   era 4+->  50bps (0.50%)                    200x   <- terminal rate
export const BASE_EMISSION_BPS = 800;
export const MIN_EMISSION_BPS = 50;

// ------------------------------------------------------------------ hashrate
//   hashrate = holdings x tenure x uptime
// Multipliers are fixed-point integers scaled by MULT_SCALE so the whole
// pipeline stays in BigInt.
export const MULT_SCALE = 1_000_000n;

// Tenure: 1x -> 4x, accruing continuously, capped after 3 eras held. Time is
// the one input that cannot be bought.
export const TENURE_MIN_BPS = 10_000;                 // 1.00x
export const TENURE_MAX_BPS = 40_000;                 // 4.00x
export const TENURE_RAMP_EPOCHS = 3 * EPOCHS_PER_ERA; // 15 epochs to cap

// Uptime: 1x while mining, halves per consecutive missed epoch, hits zero
// (the "dark" state) on the 4th. Dark miners forfeit their share to the
// miners who are still lit.
export const UPTIME_DARK_AFTER = 4;

// ---------------------------------------------------------------- settlement
// Largest-first, bounded per epoch. A share too small to outweigh its own gas
// is skipped and simply stays in the vault for the next epoch.
export const MAX_PAYOUTS_PER_EPOCH = 25;

// ---------------------------------------------------------------------- chain
export const CHAIN_ID = 4663;
export const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

// Pons v2 -- verified against live bytecode on chain 4663. The published Pons
// docs describe an OLDER factory (0xA5aA...); do not trust them over these.
export const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
export const NATIVE = "0x0000000000000000000000000000000000000000";

// -------------------------------------------------------------------- the tax
// Pons charges ONE creator tax and routes it to ONE recipient, so the split
// cannot be expressed on-chain. The token charges 4%; the keeper divides it at
// the moment fees are claimed into the vault:
//
//   3% -> miners   the block reward, mined on the halving schedule
//   1% -> buyback  buys and burns the platform token
//
// Splitting at INFLOW rather than at emission is the load-bearing choice: the
// halving schedule then runs against a balance holding only miner money, so
// the burn can never reach into emissions already earned, and "a launch pays
// out what its own trading earned" stays exactly true.
export const CREATOR_TAX_BPS = 400; // 4% -- what Pons charges on every trade

// The burn's slice OF the creator tax -- not an addition to it. Overridable,
// but 100bps (1%) is the protocol default, not an opt-in.
export const BUYBACK_TAX_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 100);

if (!Number.isInteger(BUYBACK_TAX_BPS) || BUYBACK_TAX_BPS < 0 || BUYBACK_TAX_BPS >= CREATOR_TAX_BPS) {
  throw new Error(
    `PLATFORM_FEE_BPS must be an integer in 0..${CREATOR_TAX_BPS - 1}, got ${BUYBACK_TAX_BPS}. ` +
    `It is a slice OF the ${CREATOR_TAX_BPS}bps creator tax, not an addition to it.`);
}

/** What actually reaches miners. Derived, so the two can never disagree. */
export const MINER_TAX_BPS = CREATOR_TAX_BPS - BUYBACK_TAX_BPS;

// ----------------------------------------------------------- platform token
// $DEEP is not deployed yet. Until PLATFORM_TOKEN is set the buyback portion
// accrues in each vault, fully accounted and excluded from emissions, and the
// burn step is a logged no-op -- never a silent skip.
export const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN || null;
export const PLATFORM_CURVE = process.env.PLATFORM_CURVE || null;
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
export const BUYBACK_MIN_WEI = BigInt(process.env.BUYBACK_MIN_WEI || "10000000000000000"); // 0.01 ETH

// ------------------------------------------------------------------- reserves
// Native ETH a vault keeps back so it can always afford to send the next
// payout. "A launch spends what it earned, never what it holds."
//
// Gas is ALWAYS native. A launch quoted in an ERC-20 pair pays gas from a
// separate native balance, so none of its PAYOUT asset is reserved for gas --
// see gasFloatFor() in schedule.js.
export const GAS_FLOAT_WEI = BigInt(process.env.GAS_FLOAT_WEI || "2000000000000000"); // 0.002 ETH

// Below this native balance a vault cannot reliably settle, so the keeper
// reports it as stalled rather than half-paying an epoch.
export const MIN_GAS_WEI = BigInt(process.env.MIN_GAS_WEI || "500000000000000"); // 0.0005 ETH

// A payout must be worth more than the gas it burns, or it is not a payout.
//
// This is the NATIVE-ETH floor. It is not a universal default: 0.0001 ETH and
// 0.0001 USDG are not remotely the same amount of money, so allocate() demands
// an explicit floor and callers pick it per payout asset via dustFloorFor().
export const DUST_FLOOR_WEI = BigInt(process.env.DUST_FLOOR_WEI || "100000000000000"); // 0.0001 ETH

/**
 * The dust floor for a launch, in its payout asset's smallest unit.
 *
 * Native launches use the ETH floor. ERC-20 pairs are scaled by decimals so a
 * 6-decimal quote asset like USDG gets a floor of the same ORDER, not the same
 * integer -- reusing the 18-decimal number against a 6-decimal balance would
 * withhold every payout forever.
 */
export function dustFloorFor({ native, decimals = 18 }) {
  if (native) return DUST_FLOOR_WEI;
  const d = BigInt(decimals);
  // 0.0001 of one whole unit, at this asset's precision.
  return d >= 4n ? 10n ** (d - 4n) : 1n;
}
