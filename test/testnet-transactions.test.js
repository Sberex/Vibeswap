import assert from 'node:assert/strict';
import test from 'node:test';
import { address, AssetHash, ElementsValue, issuance, networks, Pset } from 'liquidjs-lib';
import { LP_CAP } from '../src/amm.js';
import { TESTNET, TESTNET_PAIR } from '../src/testnet.js';
import { acceptWalletSignature, buildPlan, BURN, explicit, FEE } from '../lib/transactions.js';

const [A, B] = TESTNET_PAIR;
const compile = async () => ({ script: Buffer.from('5120' + 'ab'.repeat(32), 'hex') });
const script = (await compile()).script;
const walletScript = Buffer.from('0014' + 'cd'.repeat(20), 'hex');
const blindKey = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
const recipient = address.toConfidential(address.fromOutputScript(walletScript, networks.testnet), blindKey);
function coin(asset, index, amount = '1000000') {
  return { assetId: TESTNET + '/elip144:' + asset, txid: index.toString(16).padStart(64, '0'),
    vout: 0, amount, address: recipient, spendable: true, confidential: true };
}

const base = { recipient, compile, amount: 100000n, second: 200000n };
const creation = await buildPlan({ ...base, coins: [coin(A, 1), coin(B, 2)], action: 'create' });
const transaction = Pset.fromBase64(creation.pset.toBase64()).unsignedTx();
const pool = {
  assets: TESTNET_PAIR, reserves: [100000n, 200000n], shares: 141421n,
  txid: transaction.getId(), transaction, lp: creation.lp, confirmed: true,
};

test('genesis issues precisely the LP cap, funds reserves, and locks one share', () => {
  const input = transaction.ins[0];
  assert.ok(!issuance.hasTokenAmount(input.issuance));
  assert.equal(BigInt(ElementsValue.fromBytes(input.issuance.assetAmount).number), LP_CAP);
  assert.equal(AssetHash.fromBytes(issuance.calculateAsset(issuance.issuanceEntropyFromInput(input))).hex, pool.lp);
  const expected = [[A, 100000n], [B, 200000n], [pool.lp, LP_CAP - pool.shares], [pool.lp, pool.shares - 1n], [pool.lp, 1n]];
  assert.deepEqual(transaction.outs.slice(0, 5).map(explicit), expected);
  assert.ok(transaction.outs.slice(0, 3).every(out => out.script.equals(script)));
  assert.ok(transaction.outs[4].script.equals(BURN));
  assert.deepEqual(explicit(transaction.outs.at(-1)), [A, FEE]);
  assert.deepEqual(creation.signInputs.map(item => item.index), [0, 1]);
});

test('builds both swap directions and both LP transitions as explicit covenant outputs', async () => {
  for (const action of ['add', 'remove', 'swap', 'reverse']) {
    const inputAsset = action === 'reverse' ? B : A;
    const plan = await buildPlan({
      ...base, action: action === 'reverse' ? 'swap' : action, inputAsset, pool,
      amount: 10000n, second: 20000n, coins: [coin(A, 3), coin(B, 4), coin(pool.lp, 5)],
    });
    const tx = Pset.fromBase64(plan.pset.toBase64()).unsignedTx();
    assert.deepEqual(tx.ins.slice(0, 3).map(input => input.sequence), [1, 1, 1]);
    assert.ok(tx.outs.slice(0, 3).every(out => out.script.equals(script)));
    assert.ok(plan.signInputs.every(input => input.index >= 3));
    const [asset, amount] = explicit(tx.outs[3]);
    if (action === 'add') assert.deepEqual([asset, amount], [pool.lp, 14142n]);
    if (action === 'remove') assert.deepEqual([asset, amount], [A, 7071n]);
    if (action === 'swap') assert.deepEqual([asset, amount], [B, 18016n]);
    if (action === 'reverse') assert.deepEqual([asset, amount], [A, 4716n]);
  }
});

test('rejects unconfirmed state and missing funds and validates wallet modifications', async () => {
  await assert.rejects(buildPlan({ ...base, action: 'swap', inputAsset: A, pool: { ...pool, confirmed: false }, coins: [] }), /confirm/);
  await assert.rejects(buildPlan({ ...base, action: 'create', coins: [coin(A, 7)] }), /Insufficient/);
  const tampered = Pset.fromBase64(creation.pset.toBase64());
  tampered.outputs[0].value += 1;
  assert.throws(() => acceptWalletSignature(creation, tampered.toBase64()), /changed a transaction output/);
});

test('TEST displays 702 atomic units as 0.702 and parses the amount exactly', async () => {
  const { parseAmount, formatAmount } = await import('../src/amm.js');
  const { assetPrecision } = await import('../src/testnet.js');
  assert.equal(formatAmount(702n, assetPrecision(B)), '0.702');
  assert.equal(parseAmount('0.702', assetPrecision(B)), 702n);
  assert.equal(parseAmount('0.00000702', assetPrecision(A)), 702n);
  assert.throws(() => parseAmount('0.7021', assetPrecision(B)), /3 decimal/);
});
