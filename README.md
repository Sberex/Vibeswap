# Vibeswap

Vibeswap is a Liquid AMM prototype with a SimplicityHL pool covenant and a Liquid Testnet balance interface. Connect Humid to request permission to share a receiving address and the two selected asset balances. The starting pair is Testnet L-BTC (`144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49`) and `38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5`. If you edit the pair in Liquidity, use **Request wallet details** in the wallet menu to refresh the balances. Balances are displayed in units of 100 million atomic units and only held in memory until disconnect or reload. Browser transaction submission is disabled pending live Testnet integration.

```sh
npm start
npm test
```

The server binds to port 5173 by default. Set `PORT` to override it. The browser app has no package dependencies.

## Pool economics

All transaction arithmetic uses integer atomic units. For an input `dx` against reserves `x` and `y`, the covenant and quote engine use:

```text
dy = floor(99 × dx × y / (100 × x + 99 × dx))
new_x = x + dx
new_y = y - dy
```

The entire 1% fee stays in the reserves. There is no protocol fee split. The reserve product is nondecreasing across swaps. LP deposits round up per asset and redemption payouts round down. The browser treats deposits as maximums and computes the largest share issuance that fits both maximums. The initial price is the ratio of the two starting deposits. New pools allocate `floor(sqrt(x × y))` shares, with one atomic share permanently locked to keep the final reserve state spendable. Swaps and withdrawals whose payout rounds to zero are rejected. LPs bear impermanent loss when relative asset prices change.

## Covenant

[Pool source](contracts/pool.simf) uses a single, parameterized leaf for the reserve A, reserve B, and LP inventory UTXOs. The asset parameters use explicit asset ID bytes in the order returned by the Simplicity jet, which is the reverse of the usual Elements display hex. Each of the first three inputs checks the preceding transaction ID, output indexes, script hashes, explicit assets and amounts. The first three outputs recreate that bundle at the same script. Version 2 and a sequence of 1 on each pool input require the previous pool state to be at least one block old under Elements relative-lock rules. There is one action per confirmed pool transition. The implementation does not include a batcher.

LP shares use a one-time issuance instead of repeated asset issuance. The pool inventory holds the uncirculated supply. Adding liquidity releases shares from that inventory, and redeeming returns them to inventory. The covenant computes accounted supply as the fixed 10¹⁵ atomic LP units minus inventory. Swaps pay output 3, deposits pay LP units at output 3, and redemptions pay reserve assets at outputs 3 and 4. The caller supplies non-pool inputs, destination scripts, change, and Liquid network fees. A wallet or transaction builder must verify the intended recipient, amounts, and fees before signing.

A deployment must issue exactly the LP cap without a usable reissuance token, permanently lock one initial share, and create the initial bundle with the covenant as its sole Taproot leaf and an unspendable internal key. Clients need the canonical genesis outpoints and must follow their spend lineage. A matching script address alone does not identify the canonical state. Reserve and LP inventory outputs are explicit, so their assets and amounts are public.

## Validation and scope

Run the standalone covenant tests with Python, `simc` 0.7.2 and `hal-simplicity` 0.2.0 at revision `9ceb903d`:

```sh
python test/covenant.py
```

The test builds synthetic PSETs and executes each vector against all three covenant inputs. It covers both swap directions, deposits, redemptions, and rejection of incorrect math or pool wiring.

With Elements Core 23.3.4 on `PATH`, run the consensus test:

```sh
python -B test/regtest.py
```

This starts a fresh offline Elements node, issues three test assets, creates a pool, and mines swaps in both directions plus an LP deposit and withdrawal. It also checks that the next transition is rejected until the prior state confirms. You can set `SIMC`, `HAL_SIMPLICITY`, `ELEMENTSD`, and `ELEMENTS_CLI` to use binaries outside `PATH`.

The browser still needs canonical Testnet pool discovery, LP issuance and PSET construction, and funded Humid signing and broadcast validation before it can submit a pool action. The Humid session flow was exercised with a mock provider. The covenant has not undergone an independent security audit. The prototype is not intended for real funds.
