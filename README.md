# Deepshaft

A fee-mining protocol on Robinhood Chain (4663). Every coin launched here
charges a fixed **4% tax on its own trading**, and that tax is paid back out to
the people holding the coin on a Bitcoin-style halving schedule.

Every holder is already a miner. Nothing is staked, locked, or deposited, and
the only way to stop mining is to sell.

```
hashrate = holdings × tenure × uptime
payout   = (your hashrate ÷ total hashrate) × epoch emission
```

## How it works

| Unit | Value | Meaning |
|------|-------|---------|
| Epoch | 60s | one settlement cycle |
| Era | 5 epochs | one halving interval |

| Era | From | Per epoch | Reserve backing |
|-----|------|-----------|-----------------|
| 0 | t+0m | 8.00% | ~13× inflow |
| 1 | t+5m | 4.00% | 25× |
| 2 | t+10m | 2.00% | 50× |
| 3 | t+15m | 1.00% | 100× |
| 4+ | t+20m | 0.50% | 200× |

Each epoch pays a percentage of **what the vault currently holds**, not a fixed
sum. That makes the schedule geometric, so the vault asymptotes rather than
empties and cannot be drained. Halving does not shrink what miners earn in
steady state — it doubles the reserve standing behind what they earn.

- **Tenure** climbs 1× → 4× over three eras of holding, accruing continuously
  against the pool's own clock. It cannot be bought.
- **Uptime** starts at 1× and halves for each consecutive epoch a miner goes
  unpaid. After four straight misses the miner goes dark at 0× and its weight
  is divided among the miners still lit.
- **Holdings** scale linearly, so splitting a bag across wallets gains nothing.

A pool ages only when the keeper actually settles it. A keeper outage pauses the
halving schedule instead of fast-forwarding through it.

## Architecture

This is an indexer, a keeper, and a web front end over an ordinary bonding-curve
launchpad. There is no new smart contract — the only on-chain requirement is a
launchpad whose creator fee can be routed to an address the keeper controls.

```
src/config.js     every protocol constant, in one screen
src/schedule.js   eras, halvings, emission          (pure)
src/hashrate.js   tenure, uptime, share allocation  (pure)
src/chain.js      Pons v2 + RPC adapter
src/vault.js      deterministic per-launch fee vaults
src/indexer.js    holder set from Transfer logs
src/keeper.js     sweep → claim → settle → pay
src/cli.js        launch / import / diagnostics
src/server.js     read-only JSON API + static host
web/index.html    front end
```

The money math in `schedule.js` and `hashrate.js` is pure, BigInt end-to-end,
and covered by `npm test`. No floating-point value ever becomes a payout.

The server never holds signing authority — it does not import `vault.js` and has
no write endpoints. Compromising it leaks published data, not money.

## Running it

```bash
npm install
cp .env.example .env

node src/cli.js newmnemonic        # generate the keeper secret -> .env
node src/cli.js doctor             # verify chain, factory, schedule
npm test                           # 24 economics tests

node src/cli.js launch             # DRY RUN unless LAUNCH_EXECUTE=1
node src/cli.js import <address>   # index a token that already exists

npm run keeper                     # DRY RUN unless KEEPER_EXECUTE=1
npm run serve                      # http://localhost:8787
```

Both the launcher and the keeper are **dry runs by default**. Watch a few
passes and agree with what they say they would pay before setting
`KEEPER_EXECUTE=1`.

## Operational notes

These were established by on-chain recon, not from published documentation.
The public Pons docs describe an **older** factory (`0xA5aA…`); a token launched
by the current factory is not in that locker and its fees are not claimable the
way those docs describe.

- factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- feeEscrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`
- launch fee 0.0005 ETH · `maxCreatorTaxBps` 1000 (the 400 we use is allowed)
- `expectedEconomics` comes from `previewLaunchEconomics(configId, pairToken)`.
  Read it immediately before sending; a stale value reverts the launch.
- **Snipe tax is 9900 bps for the first 3 seconds.** Never buy your own launch
  immediately — a dev buy in that window burns 99% of itself.
- `creatorFeeRecipient` is set at launch and is **immutable**. This is why the
  vault address is derived *before* the token exists. Pointing it anywhere else
  permanently severs the coin from its mining pool.

## Known deviations and limits

- **Sweep is best-effort.** The escrow `claim()` path is verified; the curve-side
  sweep selector is not documented and is attempted opportunistically. Fees route
  to the escrow on trade regardless, so claim is the load-bearing step.
- **Imported tokens** keep their original fee recipient — a vault cannot be
  derived for a wallet we do not control. Mining is inert for an import whose
  creator tax is 0%, or whose recipient the keeper cannot spend from.
- **The 25-payout cap is faithful to spec and has teeth.** Missing the cut counts
  as a missed epoch, so positions too small to place decay toward dark and their
  weight accrues to large holders. `MAX_PAYOUTS_PER_EPOCH` and
  `UPTIME_DARK_AFTER` are single constants in `config.js` if that is not wanted.
