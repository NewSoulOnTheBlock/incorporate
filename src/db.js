// Storage. node:sqlite is built into Node 22.5+, so the whole protocol runs
// with exactly one dependency (ethers) and no native build step.
//
// Wei values are stored as TEXT. SQLite integers are 64-bit and wei routinely
// exceeds that; storing them as strings and parsing to BigInt keeps precision
// exact. Nothing in this file ever converts a money value to a JS number.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/deepshaft.db";

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS launches (
  token           TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  description     TEXT DEFAULT '',
  image           TEXT DEFAULT '',
  curve           TEXT,
  pair_token      TEXT NOT NULL,          -- quote asset AND payout asset
  pair_symbol     TEXT NOT NULL DEFAULT 'ETH',
  pair_decimals   INTEGER NOT NULL DEFAULT 18,
  creator         TEXT NOT NULL,
  creator_tax_bps INTEGER NOT NULL,
  vault           TEXT NOT NULL,
  vault_salt      TEXT,
  imported        INTEGER NOT NULL DEFAULT 0,
  graduated       INTEGER NOT NULL DEFAULT 0,
  epoch_index     INTEGER NOT NULL DEFAULT 0,
  last_settled_at INTEGER,
  created_at      INTEGER NOT NULL,
  launch_block    INTEGER NOT NULL DEFAULT 0,
  scanned_block   INTEGER NOT NULL DEFAULT 0,
  total_mined_wei TEXT NOT NULL DEFAULT '0',
  -- Opt-in platform fee accounting. Both stay '0' unless PLATFORM_FEE_BPS is
  -- set, so the money is auditable whether or not the fee is switched on.
  buyback_owed    TEXT NOT NULL DEFAULT '0',
  buyback_sent    TEXT NOT NULL DEFAULT '0'
);

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
);

CREATE TABLE IF NOT EXISTS receipts (
  token       TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  miner       TEXT NOT NULL,
  amount_wei  TEXT NOT NULL,
  hashrate    TEXT NOT NULL,
  tx_hash     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  paid_at     INTEGER NOT NULL,
  PRIMARY KEY (token, epoch, miner)
);

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
  settled_at     INTEGER NOT NULL,
  PRIMARY KEY (token, epoch)
);

-- One row per executed buyback-and-burn. Until the platform token is
-- deployed, no rows land here and the owed balance simply accrues -- which is
-- exactly what makes "not deployed yet" auditable rather than invisible.
CREATE TABLE IF NOT EXISTS buybacks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL,
  spent_raw    TEXT NOT NULL,   -- payout-asset units spent
  pair_symbol  TEXT NOT NULL,
  burned_raw   TEXT NOT NULL DEFAULT '0',  -- platform tokens sent to 0xdEaD
  tx_hash      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL
);

-- Treasuries handed out to the filing form but not yet used by a company.
-- The dapp must know its treasury address BEFORE it can sign, because
-- creatorFeeRecipient is immutable once the company exists. Recording the
-- salt here is what lets the Registrar later prove a submitted company really
-- is one of ours, rather than trusting whatever the browser posts back.
CREATE TABLE IF NOT EXISTS reserved_salts (
  salt       TEXT PRIMARY KEY,
  vault      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by    TEXT
);

CREATE TABLE IF NOT EXISTS keeper_heartbeat (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_pass INTEGER NOT NULL,
  passes    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_receipts_miner ON receipts(miner);
CREATE INDEX IF NOT EXISTS idx_receipts_token_epoch ON receipts(token, epoch DESC);
CREATE INDEX IF NOT EXISTS idx_miners_token ON miners(token);
`);

export const now = () => Math.floor(Date.now() / 1000);

export const insertLaunch = db.prepare(`
  INSERT INTO launches (token,name,symbol,description,image,curve,pair_token,pair_symbol,
                        pair_decimals,creator,creator_tax_bps,vault,vault_salt,imported,
                        created_at,launch_block,scanned_block)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(token) DO NOTHING`);
export const getLaunch = db.prepare(`SELECT * FROM launches WHERE token = ?`);
export const allLaunches = db.prepare(`SELECT * FROM launches ORDER BY created_at DESC`);
export const activeLaunches = db.prepare(`SELECT * FROM launches`);
export const bumpEpoch = db.prepare(`
  UPDATE launches SET epoch_index = epoch_index + 1, last_settled_at = ?,
         total_mined_wei = ? WHERE token = ?`);
export const setScanned = db.prepare(`UPDATE launches SET scanned_block = ? WHERE token = ?`);
export const setGraduated = db.prepare(`UPDATE launches SET graduated = ? WHERE token = ?`);

export const upsertMiner = db.prepare(`
  INSERT INTO miners (token,address,holdings,first_epoch) VALUES (?,?,?,?)
  ON CONFLICT(token,address) DO UPDATE SET holdings = excluded.holdings`);
export const minersFor = db.prepare(`SELECT * FROM miners WHERE token = ? AND holdings != '0'`);
export const allMinersFor = db.prepare(`SELECT * FROM miners WHERE token = ?`);
export const minerPositions = db.prepare(`
  SELECT m.*, l.symbol, l.name FROM miners m JOIN launches l ON l.token = m.token
  WHERE m.address = ? AND m.holdings != '0'`);
export const updateMinerEpoch = db.prepare(`
  UPDATE miners SET epochs_held = ?, consecutive_missed = ?, total_mined_wei = ?
  WHERE token = ? AND address = ?`);
export const resetMinerTenure = db.prepare(`
  UPDATE miners SET epochs_held = 0, first_epoch = ?, consecutive_missed = 0
  WHERE token = ? AND address = ?`);

export const insertReceipt = db.prepare(`
  INSERT INTO receipts (token,epoch,miner,amount_wei,hashrate,status,paid_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(token,epoch,miner) DO NOTHING`);
export const markReceipt = db.prepare(`
  UPDATE receipts SET status = ?, tx_hash = ? WHERE token = ? AND epoch = ? AND miner = ?`);
export const recentReceipts = db.prepare(`
  SELECT * FROM receipts WHERE token = ? ORDER BY epoch DESC LIMIT ?`);
export const feedReceipts = db.prepare(`
  SELECT r.*, l.symbol, l.pair_symbol, l.pair_decimals
  FROM receipts r JOIN launches l ON l.token = r.token
  ORDER BY r.paid_at DESC LIMIT ?`);

// Headcount on the books right now.
export const minerCountFor = db.prepare(`
  SELECT COUNT(*) AS n FROM miners WHERE token = ? AND holdings != '0'`);

// Treasury balance as of the last payroll run. Read from the books rather than
// from the chain: an RPC call per company on every page load would make the
// registry as slow as the slowest node, and this figure is exact as of the
// last run, which is the only moment it actually mattered.
export const lastVaultFor = db.prepare(`
  SELECT vault_wei, emission_wei, paid_wei, settled_at
  FROM epochs WHERE token = ? ORDER BY epoch DESC LIMIT 1`);

export const insertEpoch = db.prepare(`
  INSERT INTO epochs (token,epoch,era,emission_bps,vault_wei,emission_wei,paid_wei,
                      total_hashrate,miner_count,paid_count,settled_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(token,epoch) DO NOTHING`);
export const epochsFor = db.prepare(`SELECT * FROM epochs WHERE token = ? ORDER BY epoch DESC LIMIT ?`);

// Buyback buffer. Owed only ever grows on claim and resets on a completed
// burn, so the 1% cannot be spent on anything else by accident.

// Buyback buffer. `owed` only grows on claim and resets on a completed burn,
// so the 1% cannot be spent on anything else by accident.
export const addBuybackOwed = db.prepare(`
  UPDATE launches SET buyback_owed = ? WHERE token = ?`);
export const settleBuyback = db.prepare(`
  UPDATE launches SET buyback_owed = '0', buyback_sent = ? WHERE token = ?`);
export const insertBuyback = db.prepare(`
  INSERT INTO buybacks (token,spent_raw,pair_symbol,burned_raw,status,created_at)
  VALUES (?,?,?,?,?,?)`);
export const markBuyback = db.prepare(`
  UPDATE buybacks SET status = ?, tx_hash = ?, burned_raw = ? WHERE id = ?`);
export const pendingBuybacks = db.prepare(`
  SELECT token, pair_token, pair_symbol, pair_decimals, buyback_owed, buyback_sent
  FROM launches WHERE buyback_owed != '0'`);
export const recentBuybacks = db.prepare(`
  SELECT * FROM buybacks ORDER BY created_at DESC LIMIT ?`);

export const reserveSalt = db.prepare(`
  INSERT INTO reserved_salts (salt,vault,created_at) VALUES (?,?,?)`);
export const getReserved = db.prepare(`SELECT * FROM reserved_salts WHERE salt = ?`);
export const useReserved = db.prepare(`
  UPDATE reserved_salts SET used_by = ? WHERE salt = ?`);

export const beat = db.prepare(`
  INSERT INTO keeper_heartbeat (id,last_pass,passes) VALUES (1,?,1)
  ON CONFLICT(id) DO UPDATE SET last_pass = excluded.last_pass, passes = passes + 1`);
export const readBeat = db.prepare(`SELECT * FROM keeper_heartbeat WHERE id = 1`);
