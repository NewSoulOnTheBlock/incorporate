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
    "access-control-allow-methods": "GET, OPTIONS",
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
