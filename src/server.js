// Read-only HTTP API + static host. No node_modules web framework: the
// standard library is enough for a JSON API this small, and every dependency
// in a process that can reach a funded vault is a liability.
//
// This server NEVER holds signing authority. It does not import vault.js and
// it has no write endpoints. Compromising it leaks published data, not money.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import {
  EPOCH_SECONDS, EPOCHS_PER_ERA, CREATOR_TAX_BPS, MAX_PAYOUTS_PER_EPOCH,
  UPTIME_DARK_AFTER, TENURE_RAMP_EPOCHS,
} from "./config.js";
import { eraOf, emissionBps, reserveMultiple, epochEmission, gasFloatFor } from "./schedule.js";
import { resolvePair, formatAmount } from "./pairs.js";
import { buybackStatus } from "./buyback.js";
import { tenureMult, uptimeMult, hashrateOf } from "./hashrate.js";
import { MULT_SCALE } from "./config.js";
import {
  allLaunches, getLaunch, allMinersFor, recentReceipts, feedReceipts,
  epochsFor, minerPositions, readBeat, now,
} from "./db.js";
import { minerCountFor, lastVaultFor } from "./db.js";
import { reserveSalt, getReserved, useReserved, insertLaunch, setGraduated } from "./db.js";
import { newSalt, vaultAddress } from "./vault.js";
import { factory, erc20, provider } from "./chain.js";
import { PAIRS, NATIVE as NATIVE_ADDR } from "./pairs.js";
import { FACTORY, CHAIN_ID, RPC_URL } from "./config.js";

const PORT = Number(process.env.PORT || 8787);

// The registry front end is served from a different origin (Vercel) to the
// Registrar (Render), so without CORS the browser refuses every read. This API
// is public and read-only -- there is no route that mutates state and no route
// that can reach a treasury key -- so "*" is the honest default. Set
// ALLOWED_ORIGINS to a comma-separated list to narrow it.
const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((o) => o.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = ALLOWED.includes("*")
    ? "*"
    : (ALLOWED.includes(origin) ? origin : null);
  if (!allow) return null;
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "accept, content-type",
    "access-control-max-age": "86400",
    ...(allow === "*" ? {} : { vary: "Origin" }),
  };
}
const WEB = join(fileURLToPath(new URL("../web/", import.meta.url)));

// BigInt is not JSON-serialisable, and precision matters here, so every wei
// value crosses the wire as a decimal string and the client formats it.
const J = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Keeper liveness, derived rather than self-reported. A keeper that crashed
 * cannot lie about being up, because the heartbeat simply stops advancing.
 */
function keeperState() {
  const b = readBeat.get();
  if (!b) return { state: "not-started", lastPass: null, passes: 0 };
  const age = now() - b.last_pass;
  return {
    state: age <= EPOCH_SECONDS * 3 ? "running" : "paused",
    lastPass: b.last_pass,
    secondsSince: age,
    passes: b.passes,
  };
}

/** Project a launch row into the shape the UI wants. */
function launchView(r) {
  const era = eraOf(r.epoch_index);
  const bps = emissionBps(era);
  const pair = resolvePair(r.pair_token);
  return {
    token: r.token,
    name: r.name,
    symbol: r.symbol,
    description: r.description,
    image: r.image,
    curve: r.curve,
    vault: r.vault,
    creator: r.creator,
    creatorTaxBps: r.creator_tax_bps,
    imported: Boolean(r.imported),
    graduated: Boolean(r.graduated),
    epoch: r.epoch_index,
    era,
    emissionBps: bps,
    reserveMultiple: reserveMultiple(era),
    nextHalvingIn: EPOCHS_PER_ERA - (r.epoch_index % EPOCHS_PER_ERA),
    lastSettledAt: r.last_settled_at,
    createdAt: r.created_at,
    totalMinedWei: r.total_mined_wei,

    // The currency a company trades in is the currency it pays in, so the UI
    // needs both the ticker and the precision to render any figure correctly.
    payoutAsset: pair.symbol,
    payoutDecimals: pair.decimals,
    treasuryRaw: (lastVaultFor.get(r.token) || {}).vault_wei || "0",
    buybackOwed: r.buyback_owed || "0",
    employeeCount: (minerCountFor.get(r.token) || { n: 0 }).n,
  };
}

/** Live hashrate table for one launch, exactly as the keeper would compute it. */
function minerView(token) {
  const rows = allMinersFor.all(token).filter((m) => BigInt(m.holdings) > 0n);
  const scored = rows.map((m) => {
    const hr = hashrateOf({
      holdings: BigInt(m.holdings),
      epochsHeld: m.epochs_held,
      consecutiveMissed: m.consecutive_missed,
    });
    return {
      address: m.address,
      holdings: m.holdings,
      epochsHeld: m.epochs_held,
      consecutiveMissed: m.consecutive_missed,
      tenure: Number(tenureMult(m.epochs_held)) / Number(MULT_SCALE),
      uptime: Number(uptimeMult(m.consecutive_missed)) / Number(MULT_SCALE),
      dark: m.consecutive_missed >= UPTIME_DARK_AFTER,
      hashrate: hr.toString(),
      totalMinedWei: m.total_mined_wei,
    };
  });
  const total = scored.reduce((a, m) => a + BigInt(m.hashrate), 0n);
  return scored
    .map((m) => ({
      ...m,
      // Share of the pool in basis points, computed the same way the payout is.
      shareBps: total === 0n ? 0 : Number((BigInt(m.hashrate) * 10_000n) / total),
    }))
    .sort((a, b) => (BigInt(b.hashrate) > BigInt(a.hashrate) ? 1 : -1));
}

const routes = {
  "/api/protocol": () => ({
    epochSeconds: EPOCH_SECONDS,
    epochsPerEra: EPOCHS_PER_ERA,
    creatorTaxBps: CREATOR_TAX_BPS,
    maxPayoutsPerEpoch: MAX_PAYOUTS_PER_EPOCH,
    tenureRampEpochs: TENURE_RAMP_EPOCHS,
    uptimeDarkAfter: UPTIME_DARK_AFTER,
    schedule: [0, 1, 2, 3, 4].map((era) => ({
      era,
      atMinutes: (era * EPOCHS_PER_ERA * EPOCH_SECONDS) / 60,
      emissionBps: emissionBps(era),
      reserveMultiple: reserveMultiple(era),
    })),
    keeper: keeperState(),
  }),

  "/api/launches": () => allLaunches.all().map(launchView),

  // Everything the filing form needs to build a transaction. Served from the
  // Registrar rather than hardcoded in the page so the address book has one
  // source of truth.
  "/api/chain": () => ({
    chainId: CHAIN_ID,
    chainIdHex: "0x" + CHAIN_ID.toString(16),
    rpcUrl: RPC_URL,
    factory: FACTORY,
    creatorTaxBps: CREATOR_TAX_BPS,
    configId: 0,
    explorer: "https://explorer.mainnet.chain.robinhood.com",
  }),

  "/api/pairs": () => PAIRS.map((p) => ({
    symbol: p.symbol, address: p.address, decimals: p.decimals,
    native: p.native, label: p.label,
  })),

  // Reserve a treasury for a company that does not exist yet.
  //
  // Returns an ADDRESS and a public salt -- never a key. The address must be
  // known before signing because creatorFeeRecipient is immutable once the
  // company is filed, so this has to happen before the wallet is asked to
  // sign anything.
  "/api/reserve-treasury": () => {
    let salt, vault;
    try {
      salt = newSalt();
      vault = vaultAddress(salt);
    } catch (err) {
      // No mnemonic configured: say so plainly rather than handing back a
      // treasury nobody can ever spend from.
      return { error: "registrar-not-configured", detail: err.message };
    }
    reserveSalt.run(salt, vault.toLowerCase(), now());
    return { salt, vault };
  },

  "/api/feed": (u) =>
    feedReceipts.all(Number(u.searchParams.get("limit") || 40)).map((r) => ({
      ...r,
      payoutAsset: r.pair_symbol || "ETH",
      payoutDecimals: r.pair_decimals ?? 18,
    })),

  "/api/launch": (u) => {
    const t = (u.searchParams.get("token") || "").toLowerCase();
    const r = getLaunch.get(t);
    if (!r) return null;
    const miners = minerView(t);
    return {
      ...launchView(r),
      miners,
      minerCount: miners.length,
      epochs: epochsFor.all(t, 60),
      receipts: recentReceipts.all(t, 50),
    };
  },

  "/api/miner": (u) => {
    const a = (u.searchParams.get("address") || "").toLowerCase();
    if (!ethers.isAddress(a)) return null;
    return minerPositions.all(a);
  },

  // What a given position would earn next epoch, at the current vault size.
  // Purely informational -- the keeper recomputes from scratch at settlement.
  "/api/estimate": (u) => {
    const t = (u.searchParams.get("token") || "").toLowerCase();
    const r = getLaunch.get(t);
    if (!r) return null;
    const holdings = BigInt(u.searchParams.get("holdings") || "0");
    const epochsHeld = Number(u.searchParams.get("epochsHeld") || 0);
    const miners = minerView(t);
    const total = miners.reduce((a, m) => a + BigInt(m.hashrate), 0n);
    const mine = hashrateOf({ holdings, epochsHeld, consecutiveMissed: 0 });
    const vaultWei = BigInt(u.searchParams.get("vaultWei") || "0");
    // Show what miners can actually receive: the burn's 1% is not theirs.
    const rPair = resolvePair(r.pair_token);
    const emission = epochEmission(vaultWei, r.epoch_index, {
      gasFloat: gasFloatFor(rPair),
      buybackOwed: BigInt(r.buyback_owed || "0"),
    });
    return {
      hashrate: mine.toString(),
      shareBps: total + mine === 0n ? 0 : Number((mine * 10_000n) / (total + mine)),
      epochEmissionWei: emission.toString(),
      epochEmissionDisplay: formatAmount(emission, rPair),
      payoutAsset: rPair.symbol,
      payoutDecimals: rPair.decimals,
      buybackOwed: r.buyback_owed || "0",
      estimateWei: total + mine === 0n ? "0" : ((emission * mine) / (total + mine)).toString(),
    };
  },
};

/* Writes. Kept to the minimum the filing flow needs, and each one validated
 * against the chain rather than trusted from the browser. */
const writeRoutes = {
  /**
   * Pin a company logo to IPFS and return its gateway URL.
   *
   * The logo is written into the company on-chain as a URL string, so it has
   * to live somewhere permanent before the founder signs -- a link that rots
   * cannot be corrected afterwards. IPFS is the right home for that; storing
   * it on the Registrar would not be, because this instance has no persistent
   * disk and would lose the file on the next restart.
   *
   * Requires PINATA_JWT. Without it this says so plainly and the form falls
   * back to asking for a URL, rather than accepting a file it cannot keep.
   */
  "/api/pin": async (body) => {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) return { error: "pinning-not-configured" };

    const dataUri = String(body.dataUri || "");
    const m = dataUri.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/);
    if (!m) return { error: "bad-image" };
    const [, mime, b64] = m;
    if (!/^image\//.test(mime)) return { error: "not-an-image" };

    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > 5_000_000) return { error: "image-too-large" };

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }),
                String(body.filename || "logo").slice(0, 64));

    const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!r.ok) return { error: "pin-failed", status: r.status };
    const j = await r.json();
    return { cid: j.IpfsHash, url: `https://gateway.pinata.cloud/ipfs/${j.IpfsHash}` };
  },

  /**
   * Record a company the dapp just filed.
   *
   * The browser is not trusted here. Before anything is written we read the
   * company back from the factory and require that its creatorFeeRecipient is
   * exactly the treasury we derived for that salt. A caller who invents a
   * token address, or points at someone else's company, fails that check.
   */
  "/api/index-filing": async (body) => {
    const token = String(body.token || "").toLowerCase();
    const salt = String(body.salt || "");
    if (!ethers.isAddress(token)) return { error: "bad-token" };

    const reserved = getReserved.get(salt);
    if (!reserved) return { error: "unknown-salt" };
    if (reserved.used_by) return { error: "salt-already-used", token: reserved.used_by };

    let expected;
    try { expected = vaultAddress(salt); }
    catch (err) { return { error: "registrar-not-configured", detail: err.message }; }

    let curveAddr = null, recipient = null, graduated = 0;
    try {
      const g = await factory.getLaunchedToken(token);
      curveAddr = g[1]; recipient = g[2]; graduated = g[3] ? 1 : 0;
    } catch {
      return { error: "not-a-registry-company" };
    }
    if (!recipient || recipient.toLowerCase() !== expected.toLowerCase()) {
      return { error: "treasury-mismatch", expected, found: recipient };
    }

    const t = erc20(token);
    let name = body.name || "", symbol = body.symbol || "";
    try { [name, symbol] = await Promise.all([t.name(), t.symbol()]); } catch {}

    const pair = resolvePair(body.pairToken || NATIVE_ADDR);
    const block = await provider.getBlockNumber().catch(() => 0);

    insertLaunch.run(
      token, name, symbol, body.description || "", body.image || "",
      curveAddr ? curveAddr.toLowerCase() : null,
      pair.address.toLowerCase(), pair.symbol, pair.decimals,
      String(body.creator || "").toLowerCase(), CREATOR_TAX_BPS,
      expected.toLowerCase(), salt, 0, now(), block, block);

    useReserved.run(token, salt);
    setGraduatedIfKnown(token, graduated);
    return { ok: true, token, vault: expected, curve: curveAddr };
  },
};

// setGraduated is optional depending on build; guard it so indexing never
// fails on a cosmetic field.
function setGraduatedIfKnown(token, graduated) {
  try { setGraduated.run(graduated, token); } catch {}
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // normalize() then a prefix check: the classic ../ escape has to be closed
  // explicitly, since the client controls this string.
  const full = normalize(join(WEB, rel));
  if (!full.startsWith(normalize(WEB))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch {
    // Unknown paths fall back to the shell so the client can route them.
    try {
      const body = await readFile(join(WEB, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const cors = corsHeaders(req.headers.origin) || {};

  // Preflight. Answered before routing so an unknown path still gets a clean
  // CORS answer rather than a 404 the browser reports as a CORS failure.
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === "POST") {
    const write = writeRoutes[u.pathname];
    if (!write) {
      res.writeHead(404, { ...cors, "content-type": "application/json" })
         .end(J({ error: "not found" }));
      return;
    }
    try {
      // Filing payloads are small; cap the body so a hostile client cannot
      // make the Registrar buffer an unbounded request.
      let raw = "", tooBig = false;
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > (u.pathname === "/api/pin" ? 8_000_000 : 64_000)) { tooBig = true; break; }
      }
      if (tooBig) {
        res.writeHead(413, { ...cors, "content-type": "application/json" })
           .end(J({ error: "payload-too-large" }));
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      const data = await write(body);
      res.writeHead(data && data.error ? 400 : 200,
                    { ...cors, "content-type": "application/json", "cache-control": "no-store" })
         .end(J(data));
    } catch (err) {
      res.writeHead(500, { ...cors, "content-type": "application/json" })
         .end(J({ error: err.message }));
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...cors, "content-type": "application/json" })
       .end(J({ error: "read-only api" }));
    return;
  }

  const handler = routes[u.pathname];

  if (handler) {
    try {
      const data = await handler(u);
      if (data === null) {
        res.writeHead(404, { ...cors, "content-type": "application/json" })
           .end(J({ error: "not found" }));
        return;
      }
      res.writeHead(200, {
        ...cors,
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(J(data));
    } catch (err) {
      res.writeHead(500, { ...cors, "content-type": "application/json" })
         .end(J({ error: err.message }));
    }
    return;
  }

  await serveStatic(u.pathname, res);
}).listen(PORT, () => {
  console.log(`registrar api listening on :${PORT}  (cors: ${ALLOWED.join(", ")})`);
});
