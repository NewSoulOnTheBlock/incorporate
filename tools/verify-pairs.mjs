import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(
  "https://rpc.mainnet.chain.robinhood.com", 4663, { staticNetwork: true });
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const NATIVE = "0x0000000000000000000000000000000000000000";

const factory = new ethers.Contract(FACTORY, [
  "function previewLaunchEconomics(uint256 configId, address pairToken) view returns (bytes32)",
  "function approvedPairTokens(address) view returns (bool)",
  "function launchConfigCount() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function getLaunchConfig(uint256) view returns (tuple(uint256 totalSupply,uint256 feeBps,uint256 curveReserve,uint256 graduationTarget,uint24 poolFee,int24 tickSpacing,bool enabled))",
], provider);

const erc20 = (a) => new ethers.Contract(a, [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
], provider);

const CANDIDATES = [
  ["NATIVE ETH", NATIVE],
  ["USDG",  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
  ["cbBTC", "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4"],
  ["NVDA",  "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
  ["TSLA",  "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
  ["SPY",   "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C"],
  ["QQQ",   "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"],
  ["AMZN",  "0x12f190a9F9d7D37a250758b26824B97CE941bF54"],
  ["GME",   "0x1b0E319c6A659F002271B69dB8A7df2F911c153E"],
  ["DJT",   "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516"],
  ["RDDT",  "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C"],
];

console.log("block          ", await provider.getBlockNumber());
console.log("launchEnabled  ", await factory.launchEnabled());
console.log("launchFee      ", ethers.formatEther(await factory.launchFee()), "ETH");
console.log("maxCreatorTax  ", (await factory.maxCreatorTaxBps()).toString(), "bps");
const cfgCount = await factory.launchConfigCount();
console.log("configCount    ", cfgCount.toString());
const c0 = await factory.getLaunchConfig(0);
console.log("config[0]      supply=%s feeBps=%s curveReserve=%s gradTarget=%s enabled=%s",
  c0.totalSupply.toString(), c0.feeBps.toString(),
  c0.curveReserve.toString(), c0.graduationTarget.toString(), c0.enabled);

console.log("\n%-11s %-44s %-9s %-6s %-8s %s",
  "NAME", "ADDRESS", "approved?", "dec", "symbol", "previewLaunchEconomics(0, pair)");
console.log("-".repeat(130));

for (const [name, addr] of CANDIDATES) {
  let approved = "?", dec = "-", sym = "-", econ = "";
  try { approved = String(await factory.approvedPairTokens(addr)); } catch { approved = "ERR"; }
  if (addr !== NATIVE) {
    try { dec = String(await erc20(addr).decimals()); } catch { dec = "ERR"; }
    try { sym = await erc20(addr).symbol(); } catch { sym = "ERR"; }
  } else { dec = "18"; sym = "ETH"; }
  try {
    econ = "OK " + (await factory.previewLaunchEconomics(0, addr)).slice(0, 18) + "...";
  } catch (e) {
    econ = "REVERT: " + (e.shortMessage || e.message || "").slice(0, 60);
  }
  console.log("%-11s %-44s %-9s %-6s %-8s %s", name, addr, approved, dec, sym, econ);
}
