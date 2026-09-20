// Operator CLI: newmnemonic | doctor | vault | launch | import | list | settle
//
// Safety posture, deliberate and non-negotiable:
//   - Secrets come from the environment ONLY. Never an argument, never a
//     literal, so they cannot leak into shell history or a process list.
//   - `launch` is a DRY RUN unless LAUNCH_EXECUTE=1.
//   - Economics are read immediately before sending, never cached.

import { ethers } from "ethers";
import {
  FACTORY, FEE_ESCROW, NATIVE, CREATOR_TAX_BPS, MINER_TAX_BPS, BUYBACK_TAX_BPS, CHAIN_ID, RPC_URL,
  EPOCH_SECONDS, EPOCHS_PER_ERA,
} from "./config.js";
import { provider, factory, erc20, curve, FACTORY_ABI } from "./chain.js";
import { newSalt, vaultAddress, generateMnemonic, pathFor } from "./vault.js";
import { insertLaunch, allLaunches, now } from "./db.js";
import { resolvePair, PAIRS, formatAmount } from "./pairs.js";
import { emissionBps, reserveMultiple } from "./schedule.js";

const E = (v) => ethers.formatEther(v);
const cmd = process.argv[2];

function creatorWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error("PRIVATE_KEY is not set. Put it in .env -- never paste it on the command line.");
  }
  return new ethers.Wallet(pk.trim(), provider);
}

// -------------------------------------------------------------------- doctor
async function doctor() {
  console.log("rpc          ", RPC_URL);
  const net = await provider.getNetwork();
  console.log("chainId      ", net.chainId.toString(),
              net.chainId === BigInt(CHAIN_ID) ? "ok" : "MISMATCH");
  console.log("head block   ", await provider.getBlockNumber());
  console.log("factory      ", FACTORY);

  const [fee, enabled, maxTax, escrow, count, snipeBps, snipeSec] = await Promise.all([
    factory.launchFee(), factory.launchEnabled(), factory.maxCreatorTaxBps(),
    factory.feeEscrow(), factory.launchConfigCount(),
    factory.snipeTaxStartBps().catch(() => 0n),
    factory.snipeTaxSeconds().catch(() => 0n),
  ]);
  console.log("launchFee    ", E(fee), "ETH");
  console.log("launchEnabled", enabled);
  console.log("maxCreatorTax", maxTax.toString(), "bps   (protocol uses " + CREATOR_TAX_BPS + ")");
  console.log("feeEscrow    ", escrow,
              escrow.toLowerCase() === FEE_ESCROW.toLowerCase() ? "ok" : "UNEXPECTED");
  console.log("configs      ", count.toString());
  if (snipeBps) {
    console.log("snipe tax    ", snipeBps.toString(), "bps for", snipeSec.toString(),
                "s  <- never buy your own launch immediately");
  }

  const c = await factory.getLaunchConfig(0);
  console.log("config[0]     supply", c[0].toString(), "| feeBps", c[1].toString(),
              "| gradTarget", E(c[3]), "ETH | enabled", c[6]);

  console.log("");
  console.log("emission schedule");
  for (let era = 0; era <= 4; era++) {
    const mins = (era * EPOCHS_PER_ERA * EPOCH_SECONDS) / 60;
    console.log("  era " + era + "  t+" + String(mins).padStart(2) + "m  " +
                (emissionBps(era) / 100).toFixed(2) + "% / epoch   " +
                reserveMultiple(era) + "x reserve");
  }

  console.log("");
  if (process.env.KEEPER_MNEMONIC) {
    console.log("keeper mnemonic set; sample vault", vaultAddress(newSalt()));
  } else {
    console.log("KEEPER_MNEMONIC not set -- run: node src/cli.js newmnemonic");
  }
  if (process.env.PRIVATE_KEY) {
    const w = creatorWallet();
    console.log("creator      ", w.address, E(await provider.getBalance(w.address)), "ETH");
  }
}

// -------------------------------------------------------------------- launch
async function launch() {
  const EXEC = process.env.LAUNCH_EXECUTE === "1";
  const name = process.env.NAME;
  const symbol = process.env.SYMBOL;
  if (!name || !symbol) throw new Error("NAME and SYMBOL are required");

  // Quote asset: any pair Pons approves. `node src/cli.js pairs` lists them.
  // Accepts a ticker (USDG) or an address; unknown values throw rather than
  // silently falling back to ETH and launching against the wrong asset.
  const pair = resolvePair(process.env.PAIR || process.argv[3] || "ETH");
  const pairToken = ethers.getAddress(pair.address);
  const configId = Number(process.env.CONFIG_ID || 0);
  const devBuy = ethers.parseEther(process.env.DEV_BUY_ETH || "0");

  // launchToken() is payable, so a dev buy rides along as msg.value. That only
  // works when the quote asset IS the native asset -- buying on an ERC-20
  // curve needs an approve+buy in the pair token, which is a separate step.
  if (!pair.native && devBuy > 0n) {
    throw new Error(
      `DEV_BUY_ETH is only supported for native-quoted launches. ` +
      `${pair.symbol} is an ERC-20 pair -- launch with DEV_BUY_ETH=0, then buy ` +
      `from the curve separately.`);
  }

  const w = creatorWallet();
  const bal = await provider.getBalance(w.address);

  // The vault must exist as an address BEFORE launch: creatorFeeRecipient is
  // immutable once set, and pointing it anywhere else permanently severs the
  // token from its mining pool. This is the single most unforgiving field.
  const salt = newSalt();
  const vault = vaultAddress(salt);

  const launchFee = await factory.launchFee();
  const value = pair.native ? launchFee + devBuy : launchFee;

  console.log("name         ", name, "(" + symbol + ")");
  console.log("pair         ", pair.symbol, "(" + pair.decimals + "dp)", pair.label);
  console.log("pairToken    ", pair.native ? "native ETH (0x0)" : pairToken);
  console.log("miners paid  ", "in " + pair.symbol + " -- the quote asset is the payout asset");
  console.log("creator      ", w.address, E(bal), "ETH");
  console.log("vault salt   ", salt);
  console.log("vault        ", vault);
  console.log("derivation   ", pathFor(salt));
  console.log("creator tax  ", CREATOR_TAX_BPS, "bps -> vault  [" +
              (MINER_TAX_BPS / 100) + "% miners" +
              (BUYBACK_TAX_BPS ? " / " + (BUYBACK_TAX_BPS / 100) + "% platform" : ", no platform fee") + "]");
  console.log("launchFee    ", E(launchFee), "ETH");
  console.log("dev buy      ", E(devBuy), "ETH");
  console.log("total value  ", E(value), "ETH");

  // A zero-balance sender makes eth_call fail with an unhelpful "missing
  // revert data", because the call carries msg.value. Check the balance first
  // so the operator gets a real reason instead of a riddle.
  if (bal < value) throw new Error("creator has " + E(bal) + " ETH, needs " + E(value) + " ETH");

  // Read economics IMMEDIATELY before sending. A stale value reverts with
  // LaunchEconomicsMismatch(bytes32,bytes32).
  const economics = await factory.previewLaunchEconomics(configId, pairToken);
  console.log("economics    ", economics);

  const params = {
    name,
    symbol,
    logo: process.env.LOGO || "",
    description: process.env.DESCRIPTION || "",
    socials: {
      website: process.env.WEBSITE || "",
      twitter: process.env.TWITTER || "",
      telegram: process.env.TELEGRAM || "",
      discord: process.env.DISCORD || "",
      extra: "",
    },
    creatorFeeRecipient: vault,
    creatorTaxBps: CREATOR_TAX_BPS,
    buybackEnabled: false,
    expectedEconomics: economics,
    salt: ethers.hexlify(ethers.randomBytes(32)),
  };

  const f = new ethers.Contract(FACTORY, FACTORY_ABI, w);
  const sig = "launchToken((string,string,string,string,(string,string,string,string,string)," +
              "address,uint16,bool,bytes32,bytes32),uint256,address)";
  const fn = f[sig];

  const predicted = await fn.staticCall(params, configId, pairToken, { value });
  console.log("token (sim)  ", predicted);

  if (!EXEC) {
    console.log("");
    console.log("DRY RUN -- set LAUNCH_EXECUTE=1 to send. Nothing was broadcast.");
    return;
  }

  const tx = await fn(params, configId, pairToken, { value });
  console.log("tx           ", tx.hash);
  const rc = await tx.wait();
  console.log("mined in block", rc.blockNumber);

  const token = predicted;
  let curveAddr = null;
  try {
    const g = await factory.getLaunchedToken(token);
    curveAddr = g[1];
  } catch { /* curve lookup is a convenience, not a requirement */ }

  insertLaunch.run(token.toLowerCase(), name, symbol, params.description, params.logo,
                   curveAddr ? curveAddr.toLowerCase() : null, pairToken.toLowerCase(),
                   pair.symbol, pair.decimals,
                   w.address.toLowerCase(), CREATOR_TAX_BPS, vault.toLowerCase(), salt,
                   0, now(), rc.blockNumber, rc.blockNumber);

  console.log("");
  console.log("indexed. vault", vault);
  console.log("FUND THE VAULT with a little ETH for gas before the first keeper pass.");
  console.log("Do NOT buy your own launch for the first few seconds -- snipe tax applies.");
}

// -------------------------------------------------------------------- import
/**
 * Index a token that already exists on chain. Imports keep their ORIGINAL fee
 * recipient -- we cannot derive a vault for a wallet we do not control -- so
 * mining only works if that recipient is an address the keeper can spend from.
 * A token with 0% creator tax has no block reward and therefore cannot mine.
 */
async function importToken() {
  const addr = process.argv[3];
  if (!addr) throw new Error("usage: node src/cli.js import <tokenAddress>");
  const token = ethers.getAddress(addr);

  const code = await provider.getCode(token);
  if (code === "0x") {
    throw new Error(token + " has no contract code -- cannot import a token that does not exist");
  }

  const t = erc20(token);
  const [name, symbol] = await Promise.all([t.name(), t.symbol()]);

  let curveAddr = null;
  let recipient = null;
  let graduated = 0;
  try {
    const g = await factory.getLaunchedToken(token);
    curveAddr = g[1];
    recipient = g[2];
    graduated = g[3] ? 1 : 0;
  } catch {
    console.log("! not a Pons launch -- indexing holders only, no fee stream");
  }

  // Never assume native. An imported token quoted in USDG earns USDG, and
  // paying its miners ETH would be paying them out of the wrong pocket.
  let pair = resolvePair("ETH");
  if (process.env.PAIR) {
    pair = resolvePair(process.env.PAIR);
  } else if (curveAddr) {
    try {
      const native = await curve(curveAddr).isNativeQuote();
      if (!native) {
        throw new Error(
          `${token} is quoted in an ERC-20, but its pair address cannot be read ` +
          `from the curve. Re-run with PAIR=<ticker> to state it explicitly.`);
      }
    } catch (e) {
      if (e.message.includes("Re-run with PAIR")) throw e;
      console.log("! could not confirm quote asset -- assuming native ETH");
    }
  }

  console.log("token     ", token, name + " (" + symbol + ")");
  console.log("pair      ", pair.symbol, "(" + pair.decimals + "dp)");
  console.log("curve     ", curveAddr || "unknown");
  console.log("recipient ", recipient || "unknown");
  console.log("graduated ", Boolean(graduated));

  insertLaunch.run(token.toLowerCase(), name, symbol, "", "",
                   curveAddr ? curveAddr.toLowerCase() : null, pair.address.toLowerCase(),
                   pair.symbol, pair.decimals,
                   (recipient || NATIVE).toLowerCase(), 0,
                   (recipient || NATIVE).toLowerCase(), null, 1, now(), 0, 0);

  console.log("imported. Mining is inert unless its creator tax is non-zero");
  console.log("and the keeper can spend from its fee recipient.");
}

/**
 * List every quote asset a launch may be denominated in.
 *
 * `approved` is read live from the factory and is shown because it is
 * deliberately misleading: native ETH reports FALSE yet is the most common
 * quote asset of all. Launchability is decided by previewLaunchEconomics,
 * which is what the `economics` column actually probes.
 */
async function pairs() {
  console.log("quote assets (the quote asset is also the payout asset)");
  console.log("");
  console.log("  " + "TICKER".padEnd(8) + "DP".padEnd(4) + "APPROVED".padEnd(10) +
              "LAUNCHABLE".padEnd(12) + "ADDRESS");
  for (const p of PAIRS) {
    let approved = "?", ok = "?";
    try { approved = String(await factory.approvedPairTokens(p.address)); } catch {}
    try { await factory.previewLaunchEconomics(0, p.address); ok = "yes"; }
    catch { ok = "NO"; }
    console.log("  " + p.symbol.padEnd(8) + String(p.decimals).padEnd(4) +
                approved.padEnd(10) + ok.padEnd(12) +
                (p.native ? "native (0x0)" : p.address));
  }
  console.log("");
  console.log("launch with:  PAIR=USDG node src/cli.js launch");
  console.log("         or:  node src/cli.js launch USDG");
}

// ---------------------------------------------------------------------- misc
async function vault() {
  const salt = process.argv[3];
  if (!salt) throw new Error("usage: node src/cli.js vault <salt>");
  const a = vaultAddress(salt);
  console.log("salt   ", salt);
  console.log("path   ", pathFor(salt));
  console.log("vault  ", a);
  console.log("balance", E(await provider.getBalance(a)), "ETH");
}

async function list() {
  const rows = allLaunches.all();
  if (!rows.length) {
    console.log("no launches indexed yet");
    return;
  }
  for (const r of rows) {
    console.log(r.symbol.padEnd(10) + " " + r.token +
                "  epoch " + String(r.epoch_index).padStart(4) +
                "  vault " + r.vault +
                "  mined " + E(BigInt(r.total_mined_wei)) + " ETH" +
                (r.imported ? "  [imported]" : ""));
  }
}

const commands = {
  newmnemonic: async () => {
    console.log(generateMnemonic());
    console.log("");
    console.log("Put this in .env as KEEPER_MNEMONIC. It controls every vault.");
    console.log("It is shown once and never written to disk by this tool.");
  },
  doctor,
  pairs,
  launch,
  import: importToken,
  vault,
  list,
  settle: async () => {
    const { pass } = await import("./keeper.js");
    await pass();
  },
};

const run = commands[cmd];
if (!run) {
  console.log("usage: node src/cli.js <" + Object.keys(commands).join(" | ") + ">");
  process.exit(1);
}
run().catch((e) => {
  console.error("error:", e.shortMessage || e.message);
  process.exit(1);
});
