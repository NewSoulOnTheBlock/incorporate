/* Incorporate: one company.
 *
 * The page is state-aware by necessity. A company on the bonding curve has no
 * DEX pair and no LP position to take: the curve IS its liquidity. Rendering a
 * chart frame or an "earn fees" button in that state would be showing someone
 * a door that does not open, so both slots report the real situation instead
 * and fill themselves in once the company goes public. */

const API = (new URLSearchParams(location.search).get("api")
  || window.INCORPORATE_API || "").replace(/\/+$/, "");
const TOKEN = (new URLSearchParams(location.search).get("token") || "").toLowerCase();

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Money stays an integer string until the moment it is displayed. */
function amount(raw, decimals, symbol) {
  const v = BigInt(String(raw ?? "0") || "0");
  const base = 10n ** BigInt(decimals ?? 18);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % base).toString().padStart(Number(decimals ?? 18), "0")
    .slice(0, 4).replace(/0+$/, "");
  return whole + (frac ? "." + frac : "") + (symbol ? " " + symbol : "");
}
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "—");
const pct = (bps) => (bps / 100).toFixed(2) + "%";

function banner(msg) { const b = el("banner"); b.textContent = msg; b.hidden = false; }

/* ------------------------------------------------------------------- market */

/* DexScreener indexes by pair, not by token, so the pair has to be looked up.
 * A company that just graduated may not be indexed for a few minutes -- that is
 * a real state and gets its own message rather than an empty frame. */
async function findPair(token) {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + token);
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === "robinhood");
    if (!pairs.length) return null;
    // Deepest liquidity is the pair worth charting.
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch { return null; }
}

function emptyChart(title, body) {
  el("chart-slot").innerHTML =
    `<div class="chart-empty"><div class="big">${esc(title)}</div><p>${body}</p></div>`;
}

async function renderMarket(d) {
  const cs = d.curveState;
  const pairSym = d.payoutAsset || "ETH";

  if (!cs) {
    el("chart-title").textContent = "Price";
    emptyChart("Market state unavailable",
      "The curve for this company could not be read just now. The payroll is unaffected.");
    el("lp-slot").innerHTML =
      `<p style="color:var(--ink-faint);font-size:13.5px;margin:0">Unavailable.</p>`;
    return;
  }

  if (!cs.graduated) {
    // ---- still on the curve -------------------------------------------------
    const done = amount(cs.reserveRaw, d.payoutDecimals, pairSym);
    const goal = amount(cs.targetRaw, d.payoutDecimals, pairSym);
    const p = Math.min(100, Math.max(0, cs.progressBps / 100));

    el("chart-title").textContent = "Private round";
    el("mkt-note").textContent = "Not yet listed. Trading on its bonding curve.";
    el("chart-slot").innerHTML = `
      <div class="panel-body">
        <p style="color:var(--ink-soft);margin:0 0 18px;max-width:60ch">
          This company has not gone public yet. Its shares trade against a bonding
          curve rather than an open market, so there is no exchange pair to chart.
          When the curve reaches its threshold the company lists, and a live price
          chart replaces this panel automatically.
        </p>
        <div class="prog">
          <div class="track"><div class="fill" style="width:${p.toFixed(1)}%"></div></div>
          <div class="ends"><span>${esc(done)}</span><span>${p.toFixed(1)}% &rarr; ${esc(goal)}</span></div>
        </div>
      </div>`;

    el("lp-slot").innerHTML = `
      <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 12px">
        <strong>There is no liquidity to provide yet.</strong> On the private round
        the curve itself is the liquidity: it prices every buy and sell directly,
        so there is no pool to deposit into and no LP fee to earn.
      </p>
      <p style="color:var(--ink-faint);font-size:13.5px;margin:0">
        Providing liquidity becomes possible once the company goes public. Until
        then the only way to earn from it is to hold its shares and be on the
        payroll.
      </p>`;
    return;
  }

  // ---- public --------------------------------------------------------------
  el("mkt-note").textContent = "Listed and trading on the open market.";
  el("chart-title").textContent = "Price";

  const pair = await findPair(d.token);
  if (!pair) {
    emptyChart("Listed, not yet indexed",
      "This company has gone public, but the market data provider has not picked up " +
      "its pair yet. That usually takes a few minutes after the first trades.");
  } else {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches
      || document.documentElement.dataset.theme === "dark";
    const src = `https://dexscreener.com/robinhood/${pair.pairAddress}`
      + `?embed=1&loadChartSettings=0&trades=0&info=0`
      + `&theme=${dark ? "dark" : "light"}&chartTheme=${dark ? "dark" : "light"}`;
    el("chart-slot").innerHTML =
      `<iframe class="chartframe" src="${esc(src)}" title="Price chart" loading="lazy"></iframe>`;
  }

  const poolUrl = pair
    ? `https://dexscreener.com/robinhood/${pair.pairAddress}`
    : null;

  el("lp-slot").innerHTML = `
    <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 12px">
      This company is public, so its shares trade in an open pool. Depositing
      both sides of that pair makes you a liquidity provider and earns you a
      share of the pool's trading fees, proportional to your share of the pool.
    </p>
    <div class="kv"><span class="k">Pair</span><span class="v">${esc(d.symbol)} / ${esc(pairSym)}</span></div>
    <div class="kv"><span class="k">Pool liquidity</span><span class="v">${
      pair && pair.liquidity?.usd ? "$" + Math.round(pair.liquidity.usd).toLocaleString() : "—"}</span></div>
    <div class="kv"><span class="k">24h volume</span><span class="v">${
      pair && pair.volume?.h24 ? "$" + Math.round(pair.volume.h24).toLocaleString() : "—"}</span></div>
    ${poolUrl ? `<a class="btn" style="margin-top:14px" href="${esc(poolUrl)}" target="_blank" rel="noopener">View the pool</a>` : ""}
    <p style="color:var(--flag);font-size:13px;margin:14px 0 0">
      <strong>LP fees are not yield.</strong> Providing liquidity exposes you to
      impermanent loss: if the price moves, withdrawing can return less value than
      simply holding would have. Fees may or may not cover it.
    </p>
    <p style="color:var(--ink-faint);font-size:13px;margin:10px 0 0">
      LP fees are separate from payroll. Shares committed to a pool are held by
      the pool, not by you, so they do not accrue seniority.
    </p>`;
}

/* -------------------------------------------------------------- leaderboard */
function renderLeaderboard(d) {
  const rows = (d.miners || []).slice()
    // Longest serving first; break ties by the larger position.
    .sort((a, b) => (b.epochsHeld - a.epochsHeld)
      || (BigInt(b.holdings) > BigInt(a.holdings) ? 1 : -1));

  const tb = el("lb");
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Nobody is on this payroll yet.</td></tr>';
    return;
  }
  const maxHeld = Math.max(...rows.map((m) => m.epochsHeld), 1);

  tb.innerHTML = rows.map((m, i) => {
    const w = Math.max(2, Math.round((m.epochsHeld / maxHeld) * 60));
    return `<tr>
      <td><span class="rank ${i < 3 ? "top" : ""}">${i + 1}</span></td>
      <td><span style="font-family:var(--mono);font-size:12.5px">${esc(short(m.address))}</span></td>
      <td class="num">${m.epochsHeld}
        <span class="bar ${m.dark ? "dim" : ""}" style="width:${w}px;margin-left:8px"></span></td>
      <td class="num">${Number(m.tenure).toFixed(2)}&times;</td>
      <td class="num">${m.dark
        ? '<span class="pill off">off payroll</span>'
        : Number(m.uptime).toFixed(3) + "&times;"}</td>
      <td class="num">${(m.shareBps / 100).toFixed(2)}%</td>
      <td class="num">${esc(amount(m.totalMinedWei, d.payoutDecimals, d.payoutAsset))}</td>
    </tr>`;
  }).join("");
}

/* ------------------------------------------------------------------- cheques */
function renderCheques(d) {
  const rows = d.receipts || [];
  const tb = el("cheques");
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">No cheques issued yet.</td></tr>';
    return;
  }
  tb.innerHTML = rows.slice(0, 40).map((r) => `<tr>
    <td><span style="font-family:var(--mono);font-size:12.5px">${esc(short(r.miner))}</span></td>
    <td class="num">${r.epoch}</td>
    <td class="num">${esc(amount(r.amount_wei, d.payoutDecimals, d.payoutAsset))}</td>
    <td><span class="pill ${r.status === "sent" ? "public" : r.status === "failed" ? "off" : ""}">${esc(r.status)}</span></td>
  </tr>`).join("");
}

/* ---------------------------------------------------------------------- boot */
async function boot() {
  if (!TOKEN) { banner("No company specified."); el("co-name").textContent = "No company specified"; return; }
  if (!API) { banner("No Registrar connected."); el("co-name").textContent = "No Registrar connected"; return; }

  let d;
  try {
    const r = await fetch(`${API}/api/launch?token=${TOKEN}`);
    if (r.status === 404) { el("co-name").textContent = "Not on the register"; return; }
    d = await r.json();
  } catch {
    banner("Could not reach the Registrar.");
    el("co-name").textContent = "Could not load this company";
    return;
  }
  if (!d) { el("co-name").textContent = "Not on the register"; return; }

  document.title = `${d.symbol} — Incorporate`;
  el("co-name").textContent = d.name || "Unnamed company";
  el("co-ticker").textContent = d.symbol || "";
  el("co-token").textContent = d.token;
  el("co-desc").textContent = d.description || "";
  // Only create the image element when there is actually a logo to show.
  // An image tag with no source renders as a broken-image box.
  if (d.image) {
    const g = document.createElement("img");
    g.className = "co-logo";
    g.src = d.image;
    g.alt = d.name || "";
    g.onerror = () => g.remove();
    el("co-logo-slot").appendChild(g);
  }

  const graduated = d.curveState ? d.curveState.graduated : d.graduated;
  el("co-status").innerHTML =
    ` &nbsp;<span class="pill ${graduated ? "public" : "private"}">${graduated ? "Public" : "Private round"}</span>`;

  el("s-q").textContent = "Q" + d.era;
  el("s-rate").textContent = pct(d.emissionBps);
  el("s-tre").textContent = amount(d.treasuryRaw, d.payoutDecimals, d.payoutAsset);
  el("s-paid").textContent = amount(d.totalMinedWei, d.payoutDecimals, d.payoutAsset);
  el("s-emp").textContent = d.minerCount ?? 0;
  el("s-run").textContent = d.reserveMultiple + "×";

  el("facts").insertAdjacentHTML("beforeend", `
    <div class="kv"><span class="k">Share currency</span><span class="v">${esc(d.payoutAsset)}</span></div>
    <div class="kv"><span class="k">Treasury</span><span class="v" style="font-size:11px">${esc(short(d.vault))}</span></div>
    <div class="kv"><span class="k">Buyback buffer</span><span class="v">${esc(amount(d.buybackOwed, d.payoutDecimals, d.payoutAsset))}</span></div>
    <div class="kv"><span class="k">Next halving in</span><span class="v">${d.nextHalvingIn} periods</span></div>`);

  renderLeaderboard(d);
  renderCheques(d);
  await renderMarket(d);
}

boot();
