# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: founders filing a company.** Someone who wants to launch a token that
pays the people holding it. They arrive to pick a name, ticker, logo and share
currency, sign the filing from their own wallet, and then watch their company
get paid. The register and the documentation exist mainly to convince them that
filing is worth doing and to show them their company is alive.

Shareholders who hold filed companies are a real second audience, but the
product is currently built and judged around the founder's job. Not confirmed
as an equal priority.

## Product Purpose

Incorporate turns a token launch into a "company". Every trade of a company's
shares pays that company 4% revenue. Three of those four points are paid out to
everyone holding the shares, automatically, every 60 seconds. One point buys
back and retires the platform token.

Success is a founder filing a company and that company paying its holders from
revenue it actually earned.

## Positioning

Most launchpads pay the trading tax to whoever created the token. Incorporate
pays it to the people holding it instead, on a fixed decelerating schedule.

Three mechanisms a neighbouring product could not truthfully copy without
rebuilding:

- **The split happens at inflow, not at emission.** Revenue is divided the
  moment it lands, so the payout schedule only ever operates on money already
  earmarked for holders. The buyback cannot reach wages already earned.
- **Each period pays a percentage of what remains**, halving each quarter to a
  0.50% floor. The treasury is therefore mathematically undrainable — it
  converges rather than empties.
- **Weight is `shares × seniority × attendance`.** Seniority runs 1× to 4× over
  three quarters and cannot be bought, only served. It is the one form of
  standing in the system that capital cannot shortcut.

## Operating Context

Robinhood Chain (chain 4663), filing through the Pons v2 factory. A single
Registrar service runs payroll for every company once per 60-second pay period.

Front end is static and hosted on Vercel. The Registrar (read-only HTTP API plus
the payroll loop) runs on Render. The books live in Neon Postgres — durability
matters because a company's age *is* its number of payroll runs, and a treasury
is recoverable only from its recorded salt.

Founders file from a browser wallet; the Registrar never holds a founder key.

## Capabilities and Constraints

- Creator tax is **4%**, fixed at filing and immutable thereafter. The 3%/1%
  split is performed off-chain by the Registrar because the chain supports only
  one tax and one recipient.
- The **treasury address is written into the company at filing and can never be
  changed**. This is the single most unforgiving field in the product.
- **The quote asset is the payout asset.** A company denominated in a stablecoin
  earns and pays in that stablecoin. 11 approved currencies; precision varies
  (USDG 6dp, cbBTC 8dp, the rest 18dp).
- Pay period 60s. Fiscal quarter 5 periods. Payout 8.00% → 4 → 2 → 1 → 0.50%
  floor. Seniority 1× → 4× over 3 quarters. Attendance halves per consecutive
  missed period and reaches zero (off payroll) at 4. Maximum 25 cheques per
  period.
- Transaction costs are always paid in the native coin, even for a company
  denominated in something else.
- **The platform token is not issued yet.** The 1% accrues, fully accounted and
  excluded from payroll, buying and burning nothing until it exists.
- The Registrar currently runs on a free instance that sleeps when idle, so
  payroll pauses while asleep. The schedule freezes and resumes rather than
  fast-forwarding.

## Brand Commitments

- Name: **Incorporate**.
- **The corporate vocabulary is binding.** Filing terminology replaced mining
  terminology throughout and must be preserved: company (not coin), shares (not
  tokens), employee (not holder), payroll, payroll weight, seniority,
  attendance, off payroll, pay period, fiscal quarter, treasury, the Registrar,
  runway, cheque, filing, going public.
- **Tone: this is a game, not a financial product.** Confirmed by the user. The
  company roleplay is the point; institutional financial seriousness is not.
  Note: the current implementation reads as a serious financial registry, so
  this is a stated direction the existing surfaces do not yet match.

## Evidence on Hand

- **No companies have been filed yet.** The register is empty.
- **No users, testimonials, customers, benchmarks, or press exist.** These must
  never be fabricated to fill space.
- A live Registrar API serving real protocol constants and, once companies
  exist, real treasury balances and real cheques. Real figures are available;
  invented ones are not.
- The front end ships a clearly-labelled sample register for when no Registrar
  is reachable. Any illustrative data must stay labelled as such.

## Product Principles

- **Never promise yield, income, APY, or projected earnings.** A company pays
  only what its own trading earned, which may be nothing. No rate of return, no
  example earnings, no projections.
- A company can only ever pay out what its own trading earned. There is no
  shared pool and no outside subsidy.
- Mechanics that disadvantage someone are stated plainly rather than buried —
  notably that the 25-cheque cap and attendance decay fall hardest on the
  smallest holders and redistribute their weight to the largest.
- Numbers shown are facts read from the register, never forecasts.
