/* Shared connect button for the registry and docs pages.
 *
 * Raw EIP-1193 on purpose: these pages only need to show which account is
 * connected, and pulling a signing library onto a page that never signs would
 * be weight for nothing. The filing page loads ethers because it actually
 * builds a transaction. */

(function () {
  const btn = document.getElementById("wallet");
  if (!btn) return;

  const CHAIN_HEX = "0x1237"; // 4663 — Robinhood Chain
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  function show(account, wrongChain) {
    if (!account) {
      btn.textContent = "Connect wallet";
      btn.classList.remove("on");
      btn.title = "";
      return;
    }
    btn.textContent = wrongChain ? "Wrong network" : short(account);
    btn.classList.toggle("on", !wrongChain);
    btn.title = wrongChain
      ? "Connected, but not on Robinhood Chain. Click to switch."
      : account;
  }

  async function chainOk() {
    try {
      return (await window.ethereum.request({ method: "eth_chainId" })) === CHAIN_HEX;
    } catch { return false; }
  }

  async function refresh() {
    if (!window.ethereum) return;
    try {
      // eth_accounts does NOT prompt. It only reports an existing connection,
      // so the button can show state on load without nagging every visitor.
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      show(accounts[0], accounts[0] ? !(await chainOk()) : false);
    } catch { /* leave the button as-is */ }
  }

  btn.onclick = async () => {
    if (!window.ethereum) {
      btn.textContent = "No wallet found";
      setTimeout(() => show(null), 2200);
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      // The account is banked the moment it is approved. Network switching is
      // a separate step that is allowed to fail without undoing the connection.
      show(accounts[0], !(await chainOk()));

      if (!(await chainOk())) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }],
          });
        } catch (err) {
          const code = err.code ?? err?.data?.originalError?.code;
          if (code !== 4001) {
            // Almost certainly means the wallet has never heard of chain 4663.
            try {
              await window.ethereum.request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId: CHAIN_HEX,
                  chainName: "Robinhood Chain",
                  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
                  blockExplorerUrls: ["https://explorer.mainnet.chain.robinhood.com"],
                }],
              });
            } catch { /* declined; the button will read "Wrong network" */ }
          }
        }
      }
      show(accounts[0], !(await chainOk()));
    } catch {
      show(null); // rejected the prompt; say nothing and leave it alone
    }
  };

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", refresh);
    window.ethereum.on?.("chainChanged", refresh);
  }
  refresh();
})();
