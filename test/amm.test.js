import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEMO_PAIR, LOCKED_LP, MAX_AMOUNT, addLiquidity, createPool, formatAmount,
  pairKey, parseAmount, removeLiquidity, swap,
} from '../src/amm.js';

const [a, b] = DEMO_PAIR;
const pool = createPool(a, b, 1000n, 2000n);

test('asset order is canonical while the initial price follows the supplied asset order', () => {
  assert.equal(pairKey(a, b), pairKey(b, a.toUpperCase()));
  assert.deepEqual(createPool(b, a, 2000n, 1000n), pool);
  assert.equal(pool.shares, 1414n);
  assert.throws(() => pairKey(a, a), /different assets/);
  assert.throws(() => createPool(a, b, 1n, 1n), /too small/);
});

test('fixed 1% fee, rounding and rising constant product in both swap directions', () => {
  assert.deepEqual(swap(pool, a, 100n), { output: 180n, reserves: [1100n, 1820n] });
  assert.deepEqual(swap(pool, b, 200n), { output: 90n, reserves: [910n, 2200n] });
  for (const asset of [a, b]) {
    for (let input = 25n; input < 500n; input += 17n) {
      const { output, reserves } = swap(pool, asset, input);
      const [x, y] = asset === a ? pool.reserves : [...pool.reserves].reverse();
      const denominator = 100n * x + 99n * input;
      const numerator = 99n * input * y;
      assert.ok(output * denominator <= numerator && (output + 1n) * denominator > numerator);
      assert.ok(reserves[0] * reserves[1] >= pool.reserves[0] * pool.reserves[1]);
    }
  }
});

test('adds proportionally using only the required amounts up to the deposit limits', () => {
  const next = addLiquidity(pool, [110n, 200n]);
  assert.equal(next.minted, 141n);
  assert.deepEqual(next.deposits, [100n, 200n]);
  assert.deepEqual(next.reserves, [1100n, 2200n]);
  assert.equal(next.shares, 1555n);
});

test('redeems proportionally after a swap and retains the locked share', () => {
  const traded = { ...pool, ...swap(pool, a, 100n) };
  assert.deepEqual(removeLiquidity(traded, 707n), {
    burned: 707n, payouts: [550n, 910n], reserves: [550n, 910n], shares: 707n,
  });
  assert.equal(removeLiquidity(traded, traded.shares - LOCKED_LP).shares, LOCKED_LP);
  assert.throws(() => removeLiquidity(traded, traded.shares), /retain/);
});

test('rejects out-of-range, malformed and dust amounts', () => {
  assert.equal(formatAmount(parseAmount('25.12345678')), '25.12345678');
  for (const invalid of ['0', '-1', '1e3', '0.000000001']) assert.throws(() => parseAmount(invalid));
  assert.throws(() => swap(pool, a, MAX_AMOUNT), /range/);
  assert.throws(() => swap(pool, b, 1n), /range/);
  assert.throws(() => swap(pool, '33'.repeat(32), 100n), /outside the pool/);
});
