// Storage, on Neon Postgres.
//
// This replaced SQLite-on-local-disk for one reason: on an ephemeral host, the
// books did not survive a restart. A company's age is its number of payroll
// runs and a treasury is recoverable only from its recorded salt, so losing
// this database does not lose a cache -- it loses what people are owed, and it
// strands the revenue of every company whose salt went with it.
//
// Two conventions carried over unchanged:
//
//   1. Wei values are TEXT. Postgres BIGINT is 64-bit and wei routinely
//      exceeds it. Storing decimal strings and parsing to BigInt keeps every
//      figure exact; no money value is ever a JS number.
//
//   2. The prepared-statement surface keeps the names and the .get/.all/.run
//      shape it had under SQLite. Postgres is async, so these now return
//      promises and every call site awaits -- but nothing else had to move.

import { neon } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "node:fs";

/* Render supplies DATABASE_URL as an env var. Locally it lands in .env.local
 * from `neon link`, which is gitignored -- read it rather than making every
 * developer export it by hand. */
function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (k !== "DATABASE_URL") continue;
      return line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(
    "DATABASE_URL is not set. Run `neon link` locally, or set it in the host's environment.");
}

const sql = neon(connectionString());

/* SQLite took `?`; Postgres takes $1..$n. Converting here means the query
 * strings below stay readable and unchanged from the original schema.
 *
 * Note the driver is a TAGGED-TEMPLATE function: sql`...` tags, while
 * sql(`...`) is an ordinary call and is rejected. Everything here goes through
 * sql.query(text, params), which is the conventional-call form. */
function toPg(text) {
  let n = 0;
  return text.replace(/\?/g, () => `$${++n}`);
}

/* The schema is created once, lazily, and every query waits on it. Doing it
 * this way keeps startup ordering out of the callers entirely. */
const ready = (async () => {
  await sql.query(`
CREATE TABLE IF NOT EXISTS launches (
  token           TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  description     TEXT DEFAULT '',
  image           TEXT DEFAULT '',
  curve           TEXT,
  pair_token      TEXT NOT NULL,
  pair_symbol     TEXT NOT NULL DEFAULT 'ETH',
  pair_decimals   INTEGER NOT NULL DEFAULT 18,
  creator         TEXT NOT NULL,
  creator_tax_bps INTEGER NOT NULL,
  vault           TEXT NOT NULL,
  vault_salt      TEXT,
  imported        INTEGER NOT NULL DEFAULT 0,
  graduated       INTEGER NOT NULL DEFAULT 0,
  epoch_index     INTEGER NOT NULL DEFAULT 0,
  last_settled_at BIGINT,
  created_at      BIGINT NOT NULL,
  launch_block    BIGINT NOT NULL DEFAULT 0,
  scanned_block   BIGINT NOT NULL DEFAULT 0,
  total_mined_wei TEXT NOT NULL DEFAULT '0',
  buyback_owed    TEXT NOT NULL DEFAULT '0',
  buyback_sent    TEXT NOT NULL DEFAULT '0'
)`);

  await sql.query(`
CREATE TABLE IF NOT EXISTS miners (
  token               TEXT NOT NULL,
  address             TEXT NOT NULL,
  holdings            TEXT NOT NULL DEFAULT '0',
  first_epoch         INTEGER NOT NULL,
  epochs_held         INTEGER NOT NULL DEFAULT 0,
  consecutive_missed  INTEGER NOT NULL DEFAULT 0,
  total_mined_wei     TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (token, address),
  FOREIGN KEY (token) REFERENCES launches(token) ON DELETE CASCADE
)`);

  // (token, epoch, miner) is what makes paying a period twice structurally
  // impossible: a restarted run collides on insert instead of double-paying.
  await sql.query(`
CREATE TABLE IF NOT EXISTS receipts (
  token       TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  miner       TEXT NOT NULL,
  amount_wei  TEXT NOT NULL,
  hashrate    TEXT NOT NULL,
  tx_hash     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  paid_at     BIGINT NOT NULL,
  PRIMARY KEY (token, epoch, miner)
)`);

  await sql.query(`
CREATE TABLE IF NOT EXISTS epochs (
  token          TEXT NOT NULL,
  epoch          INTEGER NOT NULL,
  era            INTEGER NOT NULL,
  emission_bps   INTEGER NOT NULL,
  vault_wei      TEXT NOT NULL,
  emission_wei   TEXT NOT NULL,
  paid_wei       TEXT NOT NULL,
  total_hashrate TEXT NOT NULL,
  miner_count    INTEGER NOT NULL,
  paid_count     INTEGER NOT NULL,
  settled_at     BIGINT NOT NULL,
  PRIMARY KEY (token, epoch)
)`);

  await sql.query(`
CREATE TABLE IF NOT EXISTS buybacks (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token        TEXT NOT NULL,
  spent_raw    TEXT NOT NULL,
  pair_symbol  TEXT NOT NULL,
  burned_raw   TEXT NOT NULL DEFAULT '0',
  tx_hash      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   BIGINT NOT NULL
)`);

  // Treasuries handed to the filing form but not yet used by a company. The
  // salt recorded here is the ONLY way the treasury's key can ever be
  // re-derived, which is precisely why this table must outlive a restart.
  await sql.query(`
CREATE TABLE IF NOT EXISTS reserved_salts (
  salt       TEXT PRIMARY KEY,
  vault      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  used_by    TEXT
)`);

  await sql.query(`
CREATE TABLE IF NOT EXISTS keeper_heartbeat (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_pass BIGINT NOT NULL,
  passes    INTEGER NOT NULL DEFAULT 0
)`);

  await sql.query(`CREATE INDEX IF NOT EXISTS idx_receipts_miner ON receipts(miner)`);
  await sql.query(`CREATE INDEX IF NOT EXISTS idx_receipts_token_epoch ON receipts(token, epoch DESC)`);
  await sql.query(`CREATE INDEX IF NOT EXISTS idx_miners_token ON miners(token)`);
})();

/** Surface the schema promise so a process can fail fast on a bad connection. */
export const dbReady = ready;

/**
 * A prepared statement, in the same shape the SQLite version had.
 * .get -> first row or undefined, .all -> rows, .run -> executes.
 */
function q(text) {
  const pg = toPg(text);
  return {
    async get(...p) { await ready; return (await sql.query(pg, p))[0]; },
    async all(...p) { await ready; return await sql.query(pg, p); },
    async run(...p) { await ready; await sql.query(pg, p); },
  };
}

export const db = { sql, ready };
export const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ launches
export const insertLaunch = q(`
  INSERT INTO launches (token,name,symbol,description,image,curve,pair_token,pair_symbol,
                        pair_decimals,creator,creator_tax_bps,vault,vault_salt,imported,
                        created_at,launch_block,scanned_block)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (token) DO NOTHING`);
export const getLaunch = q(`SELECT * FROM launches WHERE token = ?`);
export const allLaunches = q(`SELECT * FROM launches ORDER BY created_at DESC`);
export const activeLaunches = q(`SELECT * FROM launches`);
export const bumpEpoch = q(`
  UPDATE launches SET epoch_index = epoch_index + 1, last_settled_at = ?,
         total_mined_wei = ? WHERE token = ?`);
export const setScanned = q(`UPDATE launches SET scanned_block = ? WHERE token = ?`);
export const setGraduated = q(`UPDATE launches SET graduated = ? WHERE token = ?`);

// -------------------------------------------------------------------- miners
export const upsertMiner = q(`
  INSERT INTO miners (token,address,holdings,first_epoch) VALUES (?,?,?,?)
  ON CONFLICT (token,address) DO UPDATE SET holdings = excluded.holdings`);
export const minersFor = q(`SELECT * FROM miners WHERE token = ? AND holdings != '0'`);
export const allMinersFor = q(`SELECT * FROM miners WHERE token = ?`);
export const minerPositions = q(`
  SELECT m.*, l.symbol, l.name FROM miners m JOIN launches l ON l.token = m.token
  WHERE m.address = ? AND m.holdings != '0'`);
export const updateMinerEpoch = q(`
  UPDATE miners SET epochs_held = ?, consecutive_missed = ?, total_mined_wei = ?
  WHERE token = ? AND address = ?`);
export const resetMinerTenure = q(`
  UPDATE miners SET epochs_held = 0, first_epoch = ?, consecutive_missed = 0
  WHERE token = ? AND address = ?`);
// COUNT returns bigint, which the pg driver hands back as a string; cast so
// callers get a number and never accidentally concatenate.
export const minerCountFor = q(`
  SELECT COUNT(*)::int AS n FROM miners WHERE token = ? AND holdings != '0'`);

// ------------------------------------------------------------------ receipts
export const insertReceipt = q(`
  INSERT INTO receipts (token,epoch,miner,amount_wei,hashrate,status,paid_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT (token,epoch,miner) DO NOTHING`);
export const markReceipt = q(`
  UPDATE receipts SET status = ?, tx_hash = ? WHERE token = ? AND epoch = ? AND miner = ?`);
export const recentReceipts = q(`
  SELECT * FROM receipts WHERE token = ? ORDER BY epoch DESC LIMIT ?`);
export const feedReceipts = q(`
  SELECT r.*, l.symbol, l.pair_symbol, l.pair_decimals
  FROM receipts r JOIN launches l ON l.token = r.token
  ORDER BY r.paid_at DESC LIMIT ?`);

// -------------------------------------------------------------------- epochs
export const insertEpoch = q(`
  INSERT INTO epochs (token,epoch,era,emission_bps,vault_wei,emission_wei,paid_wei,
                      total_hashrate,miner_count,paid_count,settled_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (token,epoch) DO NOTHING`);
export const epochsFor = q(`SELECT * FROM epochs WHERE token = ? ORDER BY epoch DESC LIMIT ?`);
// Treasury balance as of the last payroll run, read from the books rather than
// the chain: an RPC per company per page load would make the registry as slow
// as the slowest node.
export const lastVaultFor = q(`
  SELECT vault_wei, emission_wei, paid_wei, settled_at
  FROM epochs WHERE token = ? ORDER BY epoch DESC LIMIT 1`);

// ------------------------------------------------------------------ buybacks
export const addBuybackOwed = q(`UPDATE launches SET buyback_owed = ? WHERE token = ?`);
export const settleBuyback = q(`
  UPDATE launches SET buyback_owed = '0', buyback_sent = ? WHERE token = ?`);
export const insertBuyback = q(`
  INSERT INTO buybacks (token,spent_raw,pair_symbol,burned_raw,status,created_at)
  VALUES (?,?,?,?,?,?)`);
export const markBuyback = q(`
  UPDATE buybacks SET status = ?, tx_hash = ?, burned_raw = ? WHERE id = ?`);
export const pendingBuybacks = q(`
  SELECT token, pair_token, pair_symbol, pair_decimals, buyback_owed, buyback_sent
  FROM launches WHERE buyback_owed != '0'`);
export const recentBuybacks = q(`SELECT * FROM buybacks ORDER BY created_at DESC LIMIT ?`);

// ------------------------------------------------------------- filing salts
export const reserveSalt = q(`
  INSERT INTO reserved_salts (salt,vault,created_at) VALUES (?,?,?)`);
export const getReserved = q(`SELECT * FROM reserved_salts WHERE salt = ?`);
export const useReserved = q(`UPDATE reserved_salts SET used_by = ? WHERE salt = ?`);

// ----------------------------------------------------------------- heartbeat
export const beat = q(`
  INSERT INTO keeper_heartbeat (id,last_pass,passes) VALUES (1,?,1)
  ON CONFLICT (id) DO UPDATE SET last_pass = excluded.last_pass,
                                 passes = keeper_heartbeat.passes + 1`);
export const readBeat = q(`SELECT * FROM keeper_heartbeat WHERE id = 1`);
