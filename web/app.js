/* Incorporate — registry front end.
 *
 * This page is static and deploys anywhere. It reads from a Registrar API if one
 * is reachable, and otherwise renders a clearly-labelled sample register so the
 * site is legible before the Registrar is hosted. It never invents numbers and
 * presents them as live: the banner says which mode you are looking at. */

/* ?api=<url> wins over the baked-in config, so a new Registrar can be checked
 * from the live page without a redeploy. */
const API = (new URLSearchParams(location.search).get("api")
  || window.INCORPORATE_API || "").replace(/\/+$/, "");

/* Money is carried as an integer string in the currency's smallest unit, exactly
 * as the Registrar computes it. It is only ever turned into a decimal for
 * display — never for arithmetic. */
function amount(raw, decimals, symbol) {
  const neg = String(raw).startsWith("-");
  const v = BigInt(String(raw).replace("-", "") || "0");
  const base = 10n ** BigInt(decimals ?? 18);
  const whole = (v / base).toString();
  let frac = (v % base).toString().padStart(Number(decimals ?? 18), "0").slice(0, 4).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "") + (symbol ? " " + symbol : "");
}

const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
const pct = (bps) => (bps / 100).toFixed(2) + "%";
const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------ sample register
 * Shown only when no Registrar is reachable. Deliberately modest numbers: a
 * demo that shows implausible yields would be a lie told in a nice font. */
const SAMPLE = {
  protocol: {
    epochSeconds: 60, epochsPerEra: 5, creatorTaxBps: 400,
    minerTaxBps: 300, buybackTaxBps: 100, maxPayoutsPerEpoch: 25,
    keeper: { state: "not-started", passes: 0 },
  },
  companies: [
    { symbol: "ACME", name: "Acme Holdings",     graduated: true,  era: 2, emissionBps: 200, reserveMultiple: 50,  treasury: "412900000000000000",  paid: "1840000000000000000", decimals: 18, cur: "ETH",  employees: 31 },
    { symbol: "MERID", name: "Meridian Freight", graduated: false, era: 0, emissionBps: 800, reserveMultiple: 13,  treasury: "86400000",            paid: "219600000",           decimals: 6,  cur: "USDG", employees: 12 },
    { symbol: "HRBR",  name: "Harbour & Co.",    graduated: false, era: 1, emissionBps: 400, reserveMultiple: 25,  treasury: "97300000000000000",   paid: "402000000000000000",  decimals: 18, cur: "ETH",  employees: 8 },
    { symbol: "LMDA",  name: "Lambda Works",     graduated: true,  era: 4, emissionBps: 50,  reserveMultiple: 200, treasury: "1290000000000000000", paid: "6110000000000000000", decimals: 18, cur: "ETH",  employees: 47 },
  ],
  cheques: [
    { symbol: "LMDA",  miner: "0x8a31c4de90b7f2a1cc4e6b9017d3f5a2e8b41c77", epoch: 118, amount_wei: "4120000000000000", decimals: 18, cur: "ETH",  status: "sent" },
    { symbol: "ACME",  miner: "0x3f72b9ae1c08d45e6f1a9b2c7d8e3f04a5b6c7d8", epoch: 64,  amount_wei: "2870000000000000", decimals: 18, cur: "ETH",  status: "sent" },
    { symbol: "MERID", miner: "0xbc41e7d2f9a06b38c5d1e4f7a2b9c8d3e6f05a1b", epoch: 9,   amount_wei: "1380000",          decimals: 6,  cur: "USDG", status: "sent" },
    { symbol: "HRBR",  miner: "0x5d9e2a7c4f1b8036e9d2c5a8b7f4e1d0c3b6a9f2", epoch: 27,  amount_wei: "910000000000000",  decimals: 18, cur: "ETH",  status: "sent" },
  ],
};

async function get(path) {
  if (!API) throw new Error("no api configured");
  const r = await fetch(API + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("api " + r.status);
  return r.json();
}

function banner(msg) {
  const b = el("banner");
  b.textContent = msg;
  b.hidden = false;
}

function renderStats(p, companies, employees, paidLabel) {
  el("s-co").textContent = companies.length;
  el("s-emp").textContent = employees;
  el("s-paid").textContent = paidLabel;
  el("s-period").textContent = (p.epochSeconds || 60) + "s";
  const k = (p.keeper && p.keeper.state) || "unknown";
  const label = { running: "Running", paused: "Paused", "not-started": "Not started" }[k] || k;
  el("s-reg").textContent = label;
  el("s-reg").style.color =
    k === "running" ? "var(--up)" : k === "paused" ? "var(--flag)" : "var(--ink-faint)";
}

function renderRegistry(rows) {
  const tb = el("registry");
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">No companies filed yet. Yours could be the first.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((c) => `
    <tr class="row">
      <td><span class="tick">${c.symbol}</span></td>
      <td><span class="coname">${c.name}</span></td>
      <td><span class="pill ${c.graduated ? "public" : "private"}">${c.graduated ? "Public" : "Private round"}</span></td>
      <td class="num">${amount(c.treasury, c.decimals, c.cur)}</td>
      <td class="num">Q${c.era}</td>
      <td class="num">${pct(c.emissionBps)}</td>
      <td class="num">${c.reserveMultiple}&times;</td>
      <td class="num">${amount(c.paid, c.decimals, c.cur)}</td>
    </tr>`).join("");
}

function renderFeed(rows) {
  const tb = el("feed");
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">No cheques issued yet.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td><span class="tick">${r.symbol || "—"}</span></td>
      <td><span class="coname" style="font-family:var(--mono)">${short(r.miner)}</span></td>
      <td class="num">${r.epoch}</td>
      <td class="num">${amount(r.amount_wei, r.decimals, r.cur)}</td>
      <td><span class="pill ${r.status === "sent" ? "public" : r.status === "failed" ? "off" : ""}">${r.status}</span></td>
    </tr>`).join("");
}

/* Map the Registrar's launch shape onto the registry row the table wants. */
function fromApi(l) {
  return {
    symbol: l.symbol, name: l.name,
    graduated: l.graduated, era: l.era,
    emissionBps: l.emissionBps, reserveMultiple: l.reserveMultiple,
    treasury: l.treasuryRaw || "0",
    paid: l.totalMinedWei || "0",
    decimals: l.payoutDecimals ?? 18,
    cur: l.payoutAsset || "ETH",
    employees: l.employeeCount ?? 0,
  };
}

async function boot() {
  try {
    const [p, launches, feed] = await Promise.all([
      get("/api/protocol"), get("/api/launches"), get("/api/feed?limit=25"),
    ]);
    const companies = launches.map(fromApi);
    const employees = companies.reduce((a, c) => a + (c.employees || 0), 0);
    renderStats(p, companies, employees, companies.length ? "live" : "—");
    renderRegistry(companies);
    renderFeed(feed.map((f) => ({ ...f, decimals: f.payoutDecimals ?? 18, cur: f.payoutAsset || "ETH" })));
  } catch {
    // No Registrar reachable — show the sample register, clearly labelled.
    banner("SAMPLE REGISTER — no Registrar connected. Figures below are illustrative, not live.");
    el("reg-note").textContent = "Illustrative sample. Connect a Registrar to see live companies.";
    const s = SAMPLE;
    const employees = s.companies.reduce((a, c) => a + c.employees, 0);
    renderStats(s.protocol, s.companies, employees, "sample");
    renderRegistry(s.companies);
    renderFeed(s.cheques);
  }
}

boot();
