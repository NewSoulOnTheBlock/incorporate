// Chain adapter for Robinhood Chain (4663) + Pons v2.
//
// Every address and every ABI fragment here was verified against live deployed
// bytecode, NOT against published documentation. The public Pons docs describe
// an older factory (0xA5aA...) whose fees route through a different locker; a
// token launched via the current factory is not in that locker and its fees
// are not claimable the way the docs say. Trust this file over the docs.

import { ethers } from "ethers";
import { RPC_URL, CHAIN_ID, FACTORY, NATIVE } from "./config.js";

export const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });

// params is a 10-field tuple whose 5th field is ITSELF a 5-string tuple.
// Getting that nesting wrong is the classic way to encode calldata that
// reverts with no decodable reason.
export const PARAMS_TUPLE =
  "tuple(" +
  "string name," +
  "string symbol," +
  "string logo," +
  "string description," +
  "tuple(string website,string twitter,string telegram,string discord,string extra) socials," +
  "address creatorFeeRecipient," +
  "uint16 creatorTaxBps," +
  "bool buybackEnabled," +
  "bytes32 expectedEconomics," +
  "bytes32 salt" +
  ")";

export const FACTORY_ABI = [
  `function launchToken(${PARAMS_TUPLE} params, uint256 configId, address pairToken) payable returns (address)`,
  `function launchToken(${PARAMS_TUPLE} params, uint256 configId, address pairToken, address[] extra) payable returns (address)`,
  // expectedEconomics does NOT need brute-forcing -- the factory hands it over.
  // Read it immediately before sending; a mismatch reverts the launch.
  "function previewLaunchEconomics(uint256 configId, address pairToken) view returns (bytes32)",
  "function getLaunchConfig(uint256) view returns (tuple(uint256 totalSupply,uint256 feeBps,uint256 curveReserve,uint256 graduationTarget,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function launchConfigCount() view returns (uint256)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function approvedPairTokens(address) view returns (bool)",
  "function feeEscrow() view returns (address)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function getLaunchedToken(address) view returns (address,address,address,bool)",
];

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export const CURVE_ABI = [
  "function token() view returns (address)",
  "function graduated() view returns (bool)",
  "function isNativeQuote() view returns (bool)",
  "function quoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
];

// FeeEscrow: where the current factory routes creator tax. balanceOf() reads
// what a recipient has accrued; claim() pulls it into the recipient's wallet.
export const ESCROW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function claim() returns (uint256)",
];

export const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
export const erc20 = (addr) => new ethers.Contract(addr, ERC20_ABI, provider);
export const curve = (addr) => new ethers.Contract(addr, CURVE_ABI, provider);

export const isNative = (pairToken) =>
  !pairToken || pairToken.toLowerCase() === NATIVE.toLowerCase();

/**
 * EIP-1559 overrides. The chain's baseFee can spike between read and send, so
 * pad the cap rather than pinning it exactly.
 */
export async function feeOverrides() {
  const blk = await provider.getBlock("latest");
  const base = blk?.baseFeePerGas ?? 0n;
  const tip = ethers.parseUnits("0.001", "gwei");
  return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
}
