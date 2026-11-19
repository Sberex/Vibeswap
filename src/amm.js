export const SCALE = 100000000n;
export const MAX_AMOUNT = 100000000000000000n;
export const LP_CAP = 1000000000000000n;
export const LOCKED_LP = 1n;
export const DEMO_ASSETS = [
  { ticker: 'L-BTC', name: 'Liquid Bitcoin', id: '11'.repeat(32), icon: '₿', color: 'orange' },
  { ticker: 'USDt', name: 'Tether USD', id: '22'.repeat(32), icon: '₮', color: 'green' },
];
export const DEMO_PAIR = DEMO_ASSETS.map(asset => asset.id);

export function parseAmount(value) {
  if (!/^\d{1,10}(\.\d{0,8})?$/.test(value)) throw Error('Enter an amount with up to 8 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return amount(BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0')));
}

export function formatAmount(value) {
  const fraction = String(value % SCALE).padStart(8, '0').replace(/0+$/, '');
  return String(value / SCALE) + (fraction ? '.' + fraction : '');
}

export function assetId(value) {
  const id = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw Error('Each asset ID must contain 64 hexadecimal characters.');
  return id;
}

export function pairKey(a, b) {
  const pair = [assetId(a), assetId(b)].sort();
  if (pair[0] === pair[1]) throw Error('Choose two different assets.');
  return pair.join(':');
}

function amount(value) {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_AMOUNT) throw Error('Amount is outside the supported range.');
  return value;
}

function ceilDiv(n, d) {
  return (n + d - 1n) / d;
}

function sqrt(value) {
  let result = value;
  let next = (result + 1n) / 2n;
  while (next < result) {
    result = next;
    next = (result + value / result) / 2n;
  }
  return result;
}

export function createPool(a, b, depositA, depositB) {
  const key = pairKey(a, b);
  const assets = key.split(':');
  const deposits = a.toLowerCase().trim() === assets[0] ? [depositA, depositB] : [depositB, depositA];
  const reserves = deposits.map(amount);
  const shares = sqrt(reserves[0] * reserves[1]);
  if (shares <= LOCKED_LP) throw Error('Initial liquidity is too small.');
  if (shares >= LP_CAP) throw Error('Initial liquidity exceeds the LP supply limit.');
  return { key, assets, reserves, shares, revision: 0 };
}

export function swap(pool, inputId, input) {
  amount(input);
  const inIndex = pool.assets.indexOf(assetId(inputId));
  if (inIndex < 0) throw Error('Asset is outside the pool.');
  const outIndex = 1 - inIndex;
  const x = pool.reserves[inIndex];
  const y = pool.reserves[outIndex];
  const effective = 99n * input;
  const output = effective * y / (100n * x + effective);
  amount(output);
  const reserves = [...pool.reserves];
  reserves[inIndex] = amount(x + input);
  reserves[outIndex] = y - output;
  return { output, reserves };
}

export function addLiquidity(pool, maximums) {
  maximums.forEach(amount);
  const limits = maximums.map((max, index) => max * pool.shares / pool.reserves[index]);
  const minted = amount(limits[0] < limits[1] ? limits[0] : limits[1]);
  if (pool.shares + minted >= LP_CAP) throw Error('The pool would exceed the LP supply limit.');
  const deposits = pool.reserves.map(reserve => ceilDiv(reserve * minted, pool.shares));
  const reserves = pool.reserves.map((reserve, index) => amount(reserve + deposits[index]));
  return { minted, deposits, reserves, shares: pool.shares + minted };
}

export function removeLiquidity(pool, burned) {
  amount(burned);
  if (burned >= pool.shares) throw Error('The pool must retain some liquidity.');
  const payouts = pool.reserves.map(reserve => amount(reserve * burned / pool.shares));
  const reserves = pool.reserves.map((reserve, index) => reserve - payouts[index]);
  return { burned, payouts, reserves, shares: pool.shares - burned };
}
