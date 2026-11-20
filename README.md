# Vibeswap

Vibeswap is a Liquid Testnet AMM prototype. The browser asks Humid to share balances and UTXOs, then requests a signature on the prepared PSET. The local server completes any covenant inputs and submits the transaction to the Liquid Testnet explorer. The page shows the resulting txid or an error.

## Run locally

Use Node.js 22+, [`simc` 0.7.2](https://github.com/BlockstreamResearch/SimplicityHL/releases/tag/simplicityhl-0.7.2), and `hal-simplicity` 0.2.0 at revision `9ceb903d`. Install a current Humid extension with `getUTXOs` and `signPset` support and select a funded Liquid Testnet account. Use `SIMC` and `HAL_SIMPLICITY` if the binaries are outside `PATH`. To install the pinned HAL with Rust:

```sh
cargo install --locked --git https://github.com/BlockstreamResearch/hal-simplicity --rev 9ceb903dd079c081598652faec4ca04cca98dac2
```

```sh
npm ci
npm start
npm test
```

Open `http://localhost:5173` in the browser with Humid installed. The default explorer API is `https://blockstream.info/liquidtestnet/api`. Set `VIBESWAP_ESPLORA` to a reachable Liquid Testnet Esplora API if needed. The server checks the network against the Testnet genesis hash. `HOST` and `PORT` override the local bind address. Keep this single-user prototype on loopback when using a funded wallet.

1. Connect Humid and approve the address, balance, spendable-coin, and PSET permissions. If the Humid popup reports a missing confirmation handler, close it, use **Reload to reconnect Humid**, and reconnect.
2. Choose **Liquidity**. Fund both configured assets and allow 5,000 atomic units of Testnet L-BTC for each transaction. The pair is `144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49` and `38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5`. Testnet funding is available through [the Liquid Testnet faucet](https://liquidtestnet.com/faucet).
3. Create the pool if none is registered. Review the PSET inputs, payouts, and fee in Humid before signing. Copy the txid and wait for a confirmation, then click **Refresh pool**.
4. Add liquidity, swap, and remove liquidity, repeating the confirmation and refresh after each action. Use **Request wallet details** in the wallet menu to refresh balances after transactions. The Remove view uses the canonical pool’s LP asset balance. Vibeswap displays TEST with three decimals and tL-BTC and LP shares with eight. Transactions use exact integer atomic units.

The first genesis broadcast by this server becomes its canonical pool and is saved in `.vibeswap-pool.json`. Keep that file or set `VIBESWAP_POOL_GENESIS` to the genesis txid to share an existing pool across installations. `VIBESWAP_POOL_FILE` changes the registry path. The server verifies the registered genesis and follows its on-chain spend lineage. Independent installations need the same genesis anchor to use the same pool.

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

Run `npm run test:browser` to check all four browser handoffs and popup recovery against mocked Humid and explorer responses. Set `CHROMIUM_PATH` to your Chromium executable if it is outside `/usr/bin/chromium`. The transaction planner and covenant tests run offline. A real Humid extension with a funded Testnet account is required for browser acceptance. The covenant has not undergone an independent security audit. Use Testnet assets only.
