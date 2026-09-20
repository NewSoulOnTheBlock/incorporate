/* Incorporate — the filing dapp.
 *
 * The founder signs in their own wallet. The Registrar never sees a private
 * key and never signs on anyone's behalf; its only role here is to hand out a
 * treasury address before the transaction is built, because
 * creatorFeeRecipient is immutable the moment the company exists. */

import { ethers } from "https://esm.sh/ethers@6.13.4";

const API = (new URLSearchParams(location.search).get("api")
  || window.INCORPORATE_API || "").replace(/\/+$/, "");

const el = (id) => document.getElementById(id);
const S = { chain: null, pairs: [], account: null, launchFee: 0n, busy: false };

/* The params tuple is ten fields whose fifth is ITSELF a five-string tuple.
 * Getting that nesting wrong encodes calldata that reverts with no usable
 * reason, so the shape is spelled out in full rather than abbreviated. */
const FACTORY_ABI = [
  "function launchToken((string name,string symbol,string logo,string description,(string website,string twitter,string telegram,string discord,string extra) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 configId, address pairToken) payable returns (address)",
  "function previewLaunchEconomics(uint256 configId, address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
];

function status(kind, html) {
  const s = el("status");
  s.hidden = false;
  s.className = "status " + kind;
  s.innerHTML = html;
}
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";

/* ------------------------------------------------------------------ wallet */
function provider() {
  if (!window.ethereum) throw new Error("No wallet found. Install a browser wallet and reload.");
  return new ethers.BrowserProvider(window.ethereum);
}

/* Reads go through a plain RPC rather than the wallet: they must work before
 * anyone connects, and they must not be blocked by a wallet on a wrong chain. */
const reader = () => new ethers.JsonRpcProvider(S.chain.rpcUrl, S.chain.chainId, { staticNetwork: true });

async function ensureChain() {
  const want = S.chain.chainIdHex;
  const have = await window.ethereum.request({ method: "eth_chainId" });
  if (have === want) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain", params: [{ chainId: want }],
    });
  } catch (err) {
    // 4902 = the wallet has never heard of this chain, so offer to add it.
    if (err.code === 4902 || /unrecognized|not added/i.test(err.message || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: want,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [S.chain.rpcUrl],
          blockExplorerUrls: [S.chain.explorer],
        }],
      });
    } else throw err;
  }
}

async function connect() {
  try {
    const accounts = await provider().send("eth_requestAccounts", []);
    await ensureChain();
    S.account = ethers.getAddress(accounts[0]);
    el("wallet").textContent = short(S.account);
    el("wallet").classList.add("on");
    el("r-from").textContent = S.account;
    el("st1").className = "step done";
    el("st2").className = "step on";
    refresh();
    status("ok", `Connected as <code>${S.account}</code>.`);
  } catch (err) {
    status("bad", err.message || String(err));
  }
}

/* ------------------------------------------------------------------- setup */
async function boot() {
  el("wallet").onclick = connect;

  if (!API) {
    status("bad", "No Registrar configured, so a treasury cannot be reserved and filing is disabled.");
    return;
  }
  try {
    const [chain, pairs] = await Promise.all([
      fetch(API + "/api/chain").then((r) => r.json()),
      fetch(API + "/api/pairs").then((r) => r.json()),
    ]);
    S.chain = chain; S.pairs = pairs;

    el("f-pair").innerHTML = pairs.map((p) =>
      `<option value="${p.address}" data-sym="${p.symbol}" data-native="${p.native}">${p.symbol} — ${p.label}</option>`).join("");

    S.launchFee = await new ethers.Contract(chain.factory, FACTORY_ABI, reader()).launchFee();
    el("r-fee").textContent = ethers.formatEther(S.launchFee) + " ETH";
    refresh();
  } catch (err) {
    status("bad", "Could not reach the Registrar: " + (err.message || err));
    return;
  }

  for (const id of ["f-name", "f-sym", "f-buy"]) el(id).oninput = refresh;
  el("f-pair").onchange = refresh;
  el("f-file").onchange = onFile;
  el("f-logo").oninput = () => {
    const u = el("f-logo").value.trim();
    el("prev").innerHTML = u ? `<img src="${u}" alt="">` : "no<br>logo";
  };
  el("submit").onclick = file;

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
}

function selectedPair() {
  const o = el("f-pair").selectedOptions[0];
  return o ? { address: o.value, symbol: o.dataset.sym, native: o.dataset.native === "true" } : null;
}

function refresh() {
  const pair = selectedPair();
  const buy = parseFloat(el("f-buy").value || "0") || 0;

  // A founder's opening position rides along as msg.value, which only works
  // when the share currency IS the native coin.
  if (pair && !pair.native) {
    el("f-buy").disabled = true;
    el("f-buy").value = "";
    el("buy-hint").textContent =
      `An opening position is only available for native-ETH companies. ${pair.symbol} companies are bought from the market after filing.`;
  } else {
    el("f-buy").disabled = false;
    el("buy-hint").textContent =
      "An anti-sniping rate applies for the first few seconds after filing — do not buy your own company immediately after it lands.";
  }
  if (pair) {
    el("pair-hint").textContent =
      `The currency a company trades in is the currency it pays in. Employees of this company will be paid in ${pair.symbol}.`;
  }

  const devBuy = pair && pair.native ? buy : 0;
  el("r-buy").textContent = devBuy ? devBuy + " ETH" : "0";
  el("r-total").textContent =
    (Number(ethers.formatEther(S.launchFee)) + devBuy).toFixed(4) + " ETH";

  const ok = S.account && el("f-name").value.trim() && el("f-sym").value.trim();
  el("submit").disabled = !ok || S.busy;
  el("submit").textContent = !S.account ? "Connect a wallet first"
    : S.busy ? "Working…" : "Sign and file";
}

/* --------------------------------------------------------------- logo file */
async function onFile() {
  const f = el("f-file").files[0];
  if (!f) return;
  if (f.size > 5_000_000) { status("bad", "That image is over 5MB. Use a smaller one."); return; }

  const dataUri = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
  });
  el("prev").innerHTML = `<img src="${dataUri}" alt="">`;

  status("work", '<span class="spin"></span>Pinning the logo to IPFS…');
  try {
    const r = await fetch(API + "/api/pin", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUri, filename: f.name }),
    });
    const j = await r.json();
    if (j.url) {
      el("f-logo").value = j.url;
      status("ok", `Logo pinned. <code>${j.cid}</code>`);
    } else if (j.error === "pinning-not-configured") {
      status("bad", "IPFS pinning is not configured on this Registrar, so the file cannot be " +
        "given a permanent home. Paste an image URL instead — the logo is written on-chain " +
        "and cannot be changed later, so it must not be a link that rots.");
    } else {
      status("bad", "Could not pin the logo: " + (j.error || "unknown"));
    }
  } catch (err) {
    status("bad", "Could not pin the logo: " + (err.message || err));
  }
}

/* -------------------------------------------------------------- the filing */
async function file() {
  if (S.busy) return;
  S.busy = true; refresh();
  try {
    const pair = selectedPair();
    const name = el("f-name").value.trim();
    const symbol = el("f-sym").value.trim().toUpperCase();

    // 1. Reserve the treasury. This must happen BEFORE the transaction is
    //    built: creatorFeeRecipient is immutable, so the company and its
    //    payroll are bound together permanently at this moment.
    status("work", '<span class="spin"></span>Reserving a treasury…');
    const res = await fetch(API + "/api/reserve-treasury").then((r) => r.json());
    if (res.error) {
      throw new Error(res.error === "registrar-not-configured"
        ? "The Registrar has no keeper mnemonic set, so it cannot derive a treasury. Filing is disabled until it does."
        : res.error);
    }
    el("r-vault").textContent = res.vault;

    // 2. Read the economics hash immediately before sending. A stale value
    //    reverts with LaunchEconomicsMismatch, so it is never cached.
    status("work", '<span class="spin"></span>Reading launch economics…');
    const ro = new ethers.Contract(S.chain.factory, FACTORY_ABI, reader());
    const [economics, fee] = await Promise.all([
      ro.previewLaunchEconomics(S.chain.configId, pair.address),
      ro.launchFee(),
    ]);

    const buy = pair.native ? (parseFloat(el("f-buy").value || "0") || 0) : 0;
    const value = fee + ethers.parseEther(String(buy));

    const params = {
      name,
      symbol,
      logo: el("f-logo").value.trim(),
      description: el("f-desc").value.trim(),
      socials: {
        website: el("f-web").value.trim(),
        twitter: el("f-tw").value.trim(),
        telegram: el("f-tg").value.trim(),
        discord: el("f-dc").value.trim(),
        extra: "",
      },
      creatorFeeRecipient: res.vault,
      creatorTaxBps: S.chain.creatorTaxBps,
      buybackEnabled: false,
      expectedEconomics: economics,
      salt: ethers.hexlify(ethers.randomBytes(32)),
    };

    await ensureChain();
    const signer = await provider().getSigner();
    const rw = new ethers.Contract(S.chain.factory, FACTORY_ABI, signer);

    // Simulate first so a revert surfaces as a readable error instead of a
    // failed transaction the founder has already paid gas for.
    status("work", '<span class="spin"></span>Checking the filing will succeed…');
    const predicted = await rw.launchToken.staticCall(params, S.chain.configId, pair.address, { value });

    status("work", '<span class="spin"></span>Confirm the filing in your wallet…');
    const tx = await rw.launchToken(params, S.chain.configId, pair.address, { value });

    status("work", `<span class="spin"></span>Filing sent. Waiting for it to land…<br>
      <code>${tx.hash}</code>`);
    const rcpt = await tx.wait();

    // 3. Tell the Registrar. It verifies against the chain that this company's
    //    revenue really does route to the treasury we reserved before it
    //    writes anything, so this call cannot be used to inject a fake.
    status("work", '<span class="spin"></span>Registering the company for payroll…');
    const idx = await fetch(API + "/api/index-filing", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: predicted, salt: res.salt, pairToken: pair.address,
        creator: S.account, description: params.description, image: params.logo,
        name, symbol,
      }),
    }).then((r) => r.json());

    el("st2").className = "step done";
    el("st3").className = "step on";

    const ex = S.chain.explorer;
    status("ok", `
      <strong>${name} (${symbol}) is filed.</strong><br><br>
      Company &nbsp;<code>${predicted}</code><br>
      Treasury &nbsp;<code>${res.vault}</code><br>
      Block &nbsp;<code>${rcpt.blockNumber}</code> ·
      <a href="${ex}/tx/${tx.hash}" target="_blank" rel="noopener">view transaction</a><br><br>
      ${idx.ok
        ? "It is on the register and will be paid at the next pay period."
        : `<span style="color:var(--flag)">The company exists on-chain, but the Registrar did not index it (${idx.error}). Payroll will not run until it does.</span>`}
      <br><br>
      <strong>Fund the treasury</strong> with a little ETH for transaction costs, or its
      payroll runs will be skipped. Do not buy your own company for the first few seconds.
      <br><br><a href="./">Back to the registry</a>`);
  } catch (err) {
    const m = err.shortMessage || err.reason || err.message || String(err);
    status("bad", "Filing failed: " + m +
      (/user rejected|denied/i.test(m) ? "" : "<br><br>Nothing was filed and no treasury was used."));
  } finally {
    S.busy = false; refresh();
  }
}

boot();
