import {
  address, AssetHash, Creator, CreatorInput, CreatorOutput, ElementsValue,
  Finalizer, Pset, Updater, issuance, networks,
} from 'liquidjs-lib';
import { LP_CAP, LOCKED_LP, addLiquidity, createPool, removeLiquidity, swap } from '../src/amm.js';
import { TESTNET, TESTNET_PAIR } from '../src/testnet.js';

export const FEE = 5000n;
export const BURN = Buffer.from('6a00', 'hex');
export const HEX_ID = /^[0-9a-f]{64}$/;

export function explicit(output) {
  if (!output || output.asset[0] !== 1 || output.value[0] !== 1) {
    throw Error('Expected an explicit pool output.');
  }
  return [AssetHash.fromBytes(output.asset).hex, BigInt(ElementsValue.fromBytes(output.value).number)];
}

function output(asset, amount, script, blindingKey, blinder) {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unsupported output amount.');
  return new CreatorOutput(asset, Number(amount), script, blindingKey, blinder);
}

function chooseCoins(walletCoins, needs) {
  const inputs = [];
  const change = [];
  const seen = new Set();
  for (const [asset, needed] of needs) {
    let total = 0n;
    let blinder;
    for (const coin of walletCoins) {
      const key = coin.txid + ':' + coin.vout;
      if (!coin.spendable || coin.assetId !== TESTNET + '/elip144:' + asset || seen.has(key)) continue;
      if (!HEX_ID.test(coin.txid) || !Number.isInteger(coin.vout) || coin.vout < 0 ||
          typeof coin.amount !== 'string' || !/^\d+$/.test(coin.amount) || BigInt(coin.amount) === 0n ||
          typeof coin.address !== 'string') throw Error('Humid returned an invalid wallet UTXO.');
      blinder ??= inputs.length;
      inputs.push(coin);
      seen.add(key);
      total += BigInt(coin.amount);
      if (total > needed) break;
    }
    if (total < needed) throw Error('Insufficient spendable funds for asset ' + asset.slice(0, 8) + '… including any network fee.');
    if (total > needed) change.push({ asset, amount: total - needed, blinder });
  }
  return { inputs, change };
}

export async function buildPlan({ action, pool, amount, second, inputAsset, recipient, coins, compile }) {
  if (!address.isConfidential(recipient) || address.getNetwork(recipient).name !== 'testnet') {
    throw Error('Approve a confidential Liquid Testnet receiving address in Humid.');
  }
  const destination = address.fromConfidential(recipient);
  const needs = new Map([[TESTNET_PAIR[0], FEE]]);
  const need = (asset, value) => needs.set(asset, (needs.get(asset) ?? 0n) + value);
  const payout = [];
  let next;
  let shares;
  if (action === 'create') {
    if (pool) throw Error('A canonical pool already exists. Add liquidity instead.');
    next = createPool(...TESTNET_PAIR, amount, second);
    need(TESTNET_PAIR[0], amount);
    need(TESTNET_PAIR[1], second);
    shares = next.shares;
  } else {
    if (!pool) throw Error('Create the pool before submitting this action.');
    if (!pool.confirmed) throw Error('Wait for the current pool transaction to confirm.');
    if (action === 'swap') {
      next = swap(pool, inputAsset, amount);
      const other = TESTNET_PAIR.find(asset => asset !== inputAsset);
      need(inputAsset, amount);
      payout.push(output(other, next.output, destination.scriptPubKey));
      shares = pool.shares;
    } else if (action === 'add') {
      next = addLiquidity(pool, [amount, second]);
      TESTNET_PAIR.forEach((asset, i) => need(asset, next.deposits[i]));
      payout.push(output(pool.lp, next.minted, destination.scriptPubKey));
      shares = next.shares;
    } else if (action === 'remove') {
      next = removeLiquidity(pool, amount);
      need(pool.lp, amount);
      TESTNET_PAIR.forEach((asset, i) => payout.push(output(asset, next.payouts[i], destination.scriptPubKey)));
      shares = next.shares;
    } else {
      throw Error('Unknown pool action.');
    }
  }

  const wallet = chooseCoins(coins, needs);
  if (wallet.inputs.length > 32) throw Error('Too many wallet inputs. Consolidate coins in Humid or reduce the amount.');
  const prefix = pool ? 3 : 0;
  const inputs = [
    ...(pool ? TESTNET_PAIR.concat(pool.lp).map((_, i) => new CreatorInput(pool.txid, i, 1)) : []),
    ...wallet.inputs.map(coin => new CreatorInput(coin.txid, coin.vout)),
  ];
  const pset = Creator.newPset({ inputs });
  for (const input of pset.inputs) {
    input.requiredHeightLocktime = undefined;
    input.requiredTimeLocktime = undefined;
  }
  let lp = pool?.lp;
  if (!pool) {
    // Use the wallet's first selected fee input as the one-time issuance outpoint.
    // The updater creates an issuance output, which is replaced by the keyed pool outputs below.
    new Updater(pset).addInIssuance(0, {
      assetAmount: Number(LP_CAP), tokenAmount: 0,
      assetAddress: destination.unconfidentialAddress, blindedIssuance: false,
    });
    lp = AssetHash.fromBytes(pset.outputs[0].asset).hex;
    pset.outputs = [];
    pset.globals.outputCount = 0;
    payout.push(output(lp, shares - LOCKED_LP, destination.scriptPubKey), output(lp, LOCKED_LP, BURN));
  }
  const contract = await compile(lp);
  const updater = new Updater(pset);
  for (let i = 0; i < prefix; i++) updater.addInWitnessUtxo(i, pool.transaction.outs[i]);
  for (let i = prefix; i < inputs.length; i++) updater.addInSighashType(i, 1);
  if (wallet.inputs.some(coin => coin.confidential) && wallet.change.length === 0) {
    throw Error('The wallet needs a change output to blind this transaction. Choose a different amount.');
  }
  const outputs = [
    ...next.reserves.map((value, i) => output(TESTNET_PAIR[i], value, contract.script)),
    output(lp, LP_CAP - shares, contract.script),
    ...payout,
    ...wallet.change.map(({ asset, amount, blinder }) =>
      output(asset, amount, destination.scriptPubKey, destination.blindingKey, prefix + blinder)),
    output(TESTNET_PAIR[0], FEE),
  ];
  outputs.forEach(item => pset.addOutput(item.toPartialOutput()));
  return {
    pset,
    contract,
    prefix,
    signInputs: wallet.inputs.map((coin, i) => ({ address: coin.address, index: prefix + i, sighashTypes: [1] })),
    lp,
  };
}

export function acceptWalletSignature(plan, signed) {
  const original = plan.pset;
  const pset = Pset.fromBase64(signed);
  const before = original.unsignedTx();
  const after = pset.unsignedTx();
  if (before.version !== after.version || before.locktime !== after.locktime ||
      before.ins.length !== after.ins.length || before.outs.length !== after.outs.length) {
    throw Error('Humid changed the transaction layout.');
  }
  before.ins.forEach((input, i) => {
    const actual = after.ins[i];
    const fields = ['assetBlindingNonce', 'assetEntropy', 'assetAmount', 'tokenAmount'];
    const issuanceDiff = fields.some(field => !input.issuance?.[field]?.equals(actual.issuance?.[field] ?? Buffer.alloc(0)) &&
      Boolean(input.issuance?.[field] || actual.issuance?.[field]));
    if (!input.hash.equals(actual.hash) || input.index !== actual.index ||
        input.sequence !== actual.sequence || Boolean(input.isPegin) !== Boolean(actual.isPegin) || issuanceDiff) {
      throw Error('Humid changed a transaction input.');
    }
  });
  before.outs.forEach((out, i) => {
    const actual = after.outs[i];
    const expected = original.outputs[i];
    const metadata = pset.outputs[i];
    if (!out.script.equals(actual.script) ||
        (expected.blindingPubkey?.length
          ? metadata.value !== expected.value || !metadata.asset?.equals(expected.asset) || actual.value[0] === 1
          : !out.asset.equals(actual.asset) || !out.value.equals(actual.value) || !out.nonce.equals(actual.nonce))) {
      throw Error('Humid changed a transaction output.');
    }
  });
  const finalizer = new Finalizer(pset);
  for (const { index } of plan.signInputs) {
    if (pset.inputs[index].sighashType !== 1) throw Error('Humid changed a wallet input signature mode.');
    finalizer.finalizeInput(index);
  }
  return pset.toBase64();
}
