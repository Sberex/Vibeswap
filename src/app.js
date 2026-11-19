import {
  DEMO_ASSETS, DEMO_PAIR, LOCKED_LP, SCALE, addLiquidity, createPool, formatAmount,
  pairKey, parseAmount, removeLiquidity, swap,
} from './amm.js';
import { connectHumid, disconnectHumid, readHumidAddress, readHumidBalance } from './humid.js';

const $ = id => document.getElementById(id);
const storageKey = 'vibeswap-sandbox-v1';
const defaultPair = pairKey(...DEMO_PAIR);
const defaultBudget = 1000000n * SCALE;
let view = 'swap';
let mode = 'add';
let direction = 0;
let selection = defaultPair;
let ids = [...DEMO_PAIR];
let action = null;
let state = initialState();
let wallet;

function initialState() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return JSON.parse(saved, (_, value) =>
      typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);
  } catch { /* Start a new sandbox if saved data cannot be read. */ }
  const demo = createPool(...DEMO_PAIR, 20n * SCALE, 1600000n * SCALE);
  return { pools: { [demo.key]: demo }, positions: {}, balances: {} };
}

function token(id) {
  return DEMO_ASSETS.find(asset => asset.id === id) ??
    { ticker: id.slice(0, 6) + '…', icon: '◇', color: '' };
}

function amountBox(id, label, asset, readOnly = false) {
  const { ticker, icon, color } = token(asset);
  return `<div class="amount-box"><label for="${id}">${label}</label>
    <div class="amount-row"><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="0.0" ${readOnly ? 'readonly' : ''}>
    <span class="token"><i class="${color}">${icon}</i>${ticker}</span></div></div>`;
}

function assetField(index) {
  return `<div class="asset-field"><label for="asset${index}">Asset ${index === 0 ? 'A' : 'B'} ID</label>
    <input id="asset${index}" spellcheck="false" autocomplete="off" maxlength="64"></div>`;
}

function render() {
  const isSwap = view === 'swap';
  $('page-title').innerHTML = isSwap ? 'Swap assets<span>.</span>' : 'Manage liquidity<span>.</span>';
  $('page-description').textContent = isSwap
    ? 'Trade Liquid assets with a fixed 1% swap fee.'
    : 'Create a pool or manage your share of an existing pair.';
  $('card-title').textContent = isSwap ? 'Swap' : 'Liquidity';
  const pool = state.pools[selection];
  const swapAssets = [pool.assets[direction], pool.assets[1 - direction]];
  const poolChoices = Object.values(state.pools).map(item =>
    `<option value="${item.key}">${item.assets.map(id => token(id).ticker).join(' / ')}</option>`).join('');
  $('fields').innerHTML = isSwap ? `
    ${Object.keys(state.pools).length > 1 ? `<div class="asset-field"><label for="pair">Pool</label><select id="pair">${poolChoices}</select></div>` : ''}
    ${amountBox('input', 'You pay', swapAssets[0])}
    <button type="button" id="flip" class="flip" aria-label="Reverse swap direction">↓</button>
    ${amountBox('output', 'You receive', swapAssets[1], true)}
  ` : `
    <div class="liquidity-tabs" aria-label="Liquidity action">
      <button type="button" data-mode="add" aria-pressed="${mode === 'add'}">Add / Create</button>
      <button type="button" data-mode="remove" aria-pressed="${mode === 'remove'}">Remove</button>
    </div>
    ${assetField(0)}${assetField(1)}
    ${mode === 'add' ? amountBox('input', 'Asset A amount', safeTokenId(ids[0])) +
    amountBox('second', 'Asset B amount', safeTokenId(ids[1])) :
    '<div class="amount-box"><label for="input">LP shares to withdraw</label><div class="amount-row"><input id="input" inputmode="decimal" placeholder="0.0"></div></div>'}
  `;
  if ($('pair')) $('pair').value = selection;
  if (!isSwap) ids.forEach((id, index) => { $('asset' + index).value = id; });
  quote();
}

function safeTokenId(id) {
  return /^[a-fA-F0-9]{64}$/.test(id) ? id.toLowerCase() : '';
}

function row(label, value) {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  $('quote').append(term, detail);
}

function showPool(pool) {
  $('pool-summary').replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'pool-icon';
  icon.textContent = '◇';
  const label = document.createElement('strong');
  label.textContent = pool ? pool.assets.map(id => token(id).ticker).join(' / ') + ' pool' : 'No pool for this pair';
  const data = document.createElement('span');
  data.className = 'pool-data';
  data.textContent = pool ? pool.reserves.map(formatAmount).join(' / ') : 'Set the initial ratio';
  $('pool-summary').append(icon, label, data);
}

function balance(id) {
  return state.balances[id] ?? defaultBudget;
}

function checkBudget(assets, quantities) {
  if (assets.some((id, index) => balance(id) < quantities[index])) throw Error('Insufficient sandbox balance.');
}

function quote() {
  $('quote').replaceChildren();
  $('submit').disabled = true;
  $('submit').textContent = 'Enter an amount';
  action = null;
  if ($('output')) $('output').value = '';
  if (view === 'liquidity' && mode === 'add') {
    ids.forEach((id, index) => {
      const { icon, color, ticker } = token(safeTokenId(id));
      const badge = $(index === 0 ? 'input' : 'second').nextElementSibling;
      badge.firstElementChild.textContent = icon;
      badge.firstElementChild.className = color;
      badge.lastChild.textContent = ticker || 'Asset';
    });
  }
  try {
    const key = view === 'swap' ? selection : pairKey(...ids);
    const pool = state.pools[key];
    showPool(pool);
    if (view === 'swap') {
      row('Swap fee', '1% · retained in pool');
      const id = pool.assets[direction];
      row('Sandbox balance', formatAmount(balance(id)) + ' ' + token(id).ticker);
      if (wallet) {
        const assets = [null, ...pool.assets.filter(asset => !DEMO_PAIR.includes(asset))];
        for (const asset of assets) {
          const shared = wallet.balances.get(asset);
          row(asset ? 'Humid · ' + token(asset).ticker : 'Humid · Testnet L-BTC',
            shared === undefined ? 'Not shared' : formatAmount(shared));
        }
      }
      if (!$('input').value) return;
      const input = parseAmount($('input').value);
      checkBudget([id], [input]);
      const next = swap(pool, id, input);
      $('output').value = formatAmount(next.output);
      row('Quote', token(id).ticker + ' → ' + token(pool.assets[1 - direction]).ticker);
      action = { key, next, assets: [id, pool.assets[1 - direction]], deltas: [-input, next.output], shares: 0n, label: 'Swap' };
    } else {
      const position = state.positions[key] ?? 0n;
      row('Pair', pool ? 'Existing pool' : 'New pool');
      row('Your LP shares', formatAmount(position));
      if (mode === 'remove' && !pool) throw Error('Create a pool before removing liquidity.');
      if (!$('input').value || (mode === 'add' && !$('second').value)) return;
      if (mode === 'remove') {
        const input = parseAmount($('input').value);
        if (input > position) throw Error('You do not hold that many LP shares.');
        const next = removeLiquidity(pool, input);
        next.payouts.forEach((value, index) => row('Receive ' + token(pool.assets[index]).ticker, formatAmount(value)));
        action = { key, next, assets: pool.assets, deltas: next.payouts, shares: -input, label: 'Remove liquidity' };
      } else {
        const quantities = [parseAmount($('input').value), parseAmount($('second').value)];
        const assets = key.split(':');
        const sorted = safeTokenId(ids[0]) === assets[0] ? quantities : [...quantities].reverse();
        const next = pool ? addLiquidity(pool, sorted) : createPool(...assets, ...sorted);
        const deposits = pool ? next.deposits : sorted;
        checkBudget(assets, deposits);
        const minted = pool ? next.minted : next.shares - LOCKED_LP;
        if (!pool) row('Initial price', (Number(quantities[1]) / Number(quantities[0])).toPrecision(7) + ' B per A');
        deposits.forEach((value, index) => row('Deposit ' + token(assets[index]).ticker, formatAmount(value)));
        row('New LP shares', formatAmount(minted));
        action = { key, next, assets, deltas: deposits.map(value => -value), shares: minted, label: pool ? 'Add liquidity' : 'Create pool' };
      }
    }
    $('submit').textContent = action.label + ' in sandbox';
    $('submit').disabled = false;
  } catch (error) {
    if (view === 'liquidity') {
      try { pairKey(...ids); } catch { showPool(null); }
    }
    row('Status', error.message);
    $('submit').textContent = 'Review details';
  }
}

document.querySelector('nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button || button.dataset.view === view) return;
  view = button.dataset.view;
  if (view === 'liquidity') ids = [...state.pools[selection].assets];
  document.querySelector('nav [aria-current]').removeAttribute('aria-current');
  button.setAttribute('aria-current', 'page');
  $('status').textContent = '';
  render();
});

$('info-button').addEventListener('click', () => { $('notice').hidden = !$('notice').hidden; });

$('fields').addEventListener('click', event => {
  const modeButton = event.target.closest('[data-mode]');
  if (event.target.id === 'flip') direction = 1 - direction;
  else if (modeButton) mode = modeButton.dataset.mode;
  else return;
  $('status').textContent = '';
  render();
});

$('fields').addEventListener('change', event => {
  if (event.target.id !== 'pair') return;
  selection = event.target.value;
  direction = 0;
  render();
});

$('fields').addEventListener('input', event => {
  if (event.target.id === 'asset0') ids[0] = event.target.value;
  if (event.target.id === 'asset1') ids[1] = event.target.value;
  $('status').textContent = '';
  quote();
});

$('trade-form').addEventListener('submit', event => {
  event.preventDefault();
  quote();
  if (!action) return;
  const { key, next, assets, deltas, shares, label } = action;
  const pool = state.pools[key];
  const updated = {
    pools: { ...state.pools, [key]: {
      key, assets: key.split(':'), reserves: next.reserves,
      shares: next.shares ?? pool.shares, revision: (pool?.revision ?? -1) + 1,
    } },
    balances: { ...state.balances },
    positions: { ...state.positions, [key]: (state.positions[key] ?? 0n) + shares },
  };
  assets.forEach((id, index) => { updated.balances[id] = balance(id) + deltas[index]; });
  try {
    localStorage.setItem(storageKey, JSON.stringify(updated, (_, value) => typeof value === 'bigint' ? value + 'n' : value));
  } catch {
    $('status').textContent = 'Browser storage is unavailable. No sandbox change was saved.';
    return;
  }
  state = updated;
  selection = key;
  render();
  $('status').textContent = label + ' complete in the sandbox.';
});

render();

function showWallet() {
  $('wallet').hidden = Boolean(wallet);
  $('wallet-menu').hidden = !wallet;
  $('wallet-address').hidden = !wallet?.address;
  $('wallet-address').textContent = wallet?.address ?? '';
  const address = wallet?.address;
  $('wallet-label').textContent = address
    ? address.slice(0, 10) + '…' + address.slice(-6)
    : 'Humid connected';
  $('wallet-label').title = address ?? '';
  quote();
}

async function loadWalletDetails() {
  const current = wallet;
  const controls = [$('wallet-refresh'), $('wallet-disconnect')];
  controls.forEach(button => { button.disabled = true; });
  let unavailable = false;
  $('status').textContent = 'Approve the sharing requests in Humid.';
  try {
    if (!current.address) {
      try {
        current.address = await readHumidAddress(current);
        showWallet();
      } catch { unavailable = true; }
    }
    const assets = [null, ...state.pools[selection].assets.filter(id => !DEMO_PAIR.includes(id))];
    for (const asset of assets) {
      current.balances.delete(asset);
      try {
        current.balances.set(asset, await readHumidBalance(current, asset));
      } catch { unavailable = true; }
      showWallet();
    }
    $('status').textContent = unavailable
      ? 'Some wallet details were not shared. You can request them from the wallet menu.'
      : 'Wallet details shared. Swaps still use sandbox funds.';
  } finally {
    controls.forEach(button => { button.disabled = false; });
  }
}

$('wallet').addEventListener('click', async () => {
  const button = $('wallet');
  button.disabled = true;
  try {
    const session = await connectHumid(window.humid);
    wallet = { ...session, address: '', balances: new Map() };
    showWallet();
    await loadWalletDetails();
  } catch (error) {
    $('status').textContent = error.message || 'Unable to connect to Humid.';
  } finally {
    button.disabled = false;
  }
});

$('wallet-refresh').addEventListener('click', () => {
  $('wallet-menu').open = false;
  void loadWalletDetails();
});

$('wallet-disconnect').addEventListener('click', async () => {
  $('wallet-disconnect').disabled = true;
  $('wallet-refresh').disabled = true;
  try {
    await disconnectHumid(wallet.provider);
    wallet = undefined;
    $('wallet-menu').open = false;
    showWallet();
    $('wallet').focus();
    $('status').textContent = 'Humid disconnected.';
  } catch (error) {
    $('status').textContent = error.message || 'Unable to disconnect Humid.';
  } finally {
    $('wallet-disconnect').disabled = false;
    $('wallet-refresh').disabled = false;
  }
});
