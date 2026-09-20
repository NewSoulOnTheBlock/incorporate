// The Registrar, as a single process.
//
// Render gives a web service one port and one process, so this entry runs both
// halves together: the read-only HTTP API that the registry front end reads,
// and the payroll loop that actually pays people.
//
// Importing server.js starts the HTTP listener as a side effect, which also
// satisfies Render's health check -- a service that never binds a port is
// killed before the first payroll run ever happens.
//
//   node src/registrar.js
//
// Payroll is a DRY RUN unless KEEPER_EXECUTE=1. That default is deliberate:
// this process holds the mnemonic that can spend every treasury, so moving
// real money has to be switched on explicitly, never inherited by accident.

import "./server.js";
import { pass } from "./keeper.js";
import { EPOCH_SECONDS } from "./config.js";
import { buybackStatus } from "./buyback.js";

const EXECUTE = process.env.KEEPER_EXECUTE === "1";
const log = (...a) => console.log(new Date().toISOString(), "[registrar]", ...a);

log(`pay period ${EPOCH_SECONDS}s`);
log(EXECUTE
  ? "EXECUTE MODE -- real transfers will be sent"
  : "DRY RUN -- set KEEPER_EXECUTE=1 to actually pay");
log("buyback:", buybackStatus().note);

/* One run at a time. If a run overruns its period -- a slow RPC, a long payout
 * queue -- the next tick is skipped rather than started concurrently. Two runs
 * against the same period would collide on the cheque record anyway, but not
 * starting them is cheaper than relying on the collision. */
let running = false;

async function tick() {
  if (running) { log("previous run still going -- skipping this period"); return; }
  running = true;
  try { await pass(); }
  catch (err) { log("run failed:", err.shortMessage || err.message); }
  finally { running = false; }
}

await tick();
setInterval(tick, EPOCH_SECONDS * 1000);

// A crash in a detached promise must not silently stop payroll.
process.on("unhandledRejection", (e) => log("unhandled:", e && (e.message || e)));
process.on("SIGTERM", () => { log("SIGTERM -- shutting down"); process.exit(0); });
