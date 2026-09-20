// The quote-asset registry.
//
// Every entry here was verified live against factory
// 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e on chain 4663 at block 67823991:
// decimals read from the token, `approvedPairTokens` read from the factory, and
// `previewLaunchEconomics(0, pair)` confirmed to return a hash rather than
// revert. Re-verify any time with `node tools/verify-pairs.mjs`.
//
// Two traps this registry exists to encode:
//
//  1. Native ETH reports approvedPairTokens(0x0) === FALSE, yet it is the most
//     common quote asset and its economics preview succeeds. Building the pair
//     list from `approvedPairTokens` alone silently drops native.
//
//  2. The quote asset is also the PAYOUT asset. A launch quoted in USDG earns
//     its trading tax in USDG, so its miners are paid USDG -- not ETH. Gas is
//     always native ETH regardless, which is why gas float and payout balance
//     are tracked separately for every non-native launch.

export const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * dustFloor is the smallest payout worth making, in the asset's own smallest
 * unit, targeting roughly a quarter of a dollar. Anything below it costs more
 * in gas than it delivers, so it stays in the vault for the next epoch.
 * Tune per asset as prices move.
 */
export const PAIRS = [
  { symbol: "ETH",   address: NATIVE,                                        decimals: 18, native: true,  dustFloor: 100000000000000n,  label: "Native ETH" },
  { symbol: "USDG",  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6,  native: false, dustFloor: 250000n,           label: "USDG stablecoin" },
  { symbol: "cbBTC", address: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", decimals: 8,  native: false, dustFloor: 250n,              label: "Coinbase wrapped BTC" },
  { symbol: "NVDA",  address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "NVIDIA stock token" },
  { symbol: "TSLA",  address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "Tesla stock token" },
  { symbol: "SPY",   address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "S&P 500 ETF token" },
  { symbol: "QQQ",   address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "Nasdaq 100 ETF token" },
  { symbol: "AMZN",  address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "Amazon stock token" },
  { symbol: "GME",   address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "GameStop stock token" },
  { symbol: "DJT",   address: "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "DJT stock token" },
  { symbol: "RDDT",  address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", decimals: 18, native: false, dustFloor: 1000000000000000n, label: "Reddit stock token" },
];

const BY_ADDRESS = new Map(PAIRS.map((p) => [p.address.toLowerCase(), p]));
const BY_SYMBOL = new Map(PAIRS.map((p) => [p.symbol.toUpperCase(), p]));

export const isNative = (address) => !address || address.toLowerCase() === NATIVE;

/** Look up a pair by address or ticker. Throws rather than guessing. */
export function resolvePair(ref) {
  if (ref === undefined || ref === null || ref === "") return BY_SYMBOL.get("ETH");
  const s = String(ref).trim();
  const hit = s.startsWith("0x")
    ? BY_ADDRESS.get(s.toLowerCase())
    : BY_SYMBOL.get(s.toUpperCase());
  if (!hit) {
    throw new Error(
      `Unknown quote pair "${ref}". Supported: ${PAIRS.map((p) => p.symbol).join(", ")}`);
  }
  return hit;
}

/** Human-readable amount for display. Never used in payout math. */
export function formatAmount(raw, pair) {
  const v = BigInt(raw);
  const base = 10n ** BigInt(pair.decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(pair.decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${pair.symbol}`;
}
