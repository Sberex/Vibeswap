import { createPool, formatAmount, pairKey, parseAmount } from './amm.js';
import { connectHumid, disconnectHumid, readHumidAddress, readHumidBalance } from './humid.js';

const $ = id => document.getElementById(id);
const TESTNET_PAIR = [
  '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
  '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5',
];
let view = 'swap';
let mode = 'add';
let direction = 0;
const ids = [...TESTNET_PAIR];
let wallet;

function token(id) {
  if (id === TESTNET_PAIR[0]) return { ticker: 'tL-BTC', icon: '₿', color: 'orange' };
  return { ticker: id ? id.slice(0, 6) + '…' : 'Asset', icon: '◇', color: '' };
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
    ? 'View available Liquid Testnet balances for your pair.'
    : 'Create a pool or manage your share of an existing pair.';
  $('card-title').textContent = isSwap ? 'Swap' : 'Liquidity';
  const assets = ids.map(safeTokenId);
  const swapAssets = [assets[direction], assets[1 - direction]];
  $('fields').innerHTML = isSwap ? `
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

function quote() {
  $('quote').replaceChildren();
  if (view === 'liquidity' && mode === 'add') {
    ids.forEach((id, index) => {
      const { icon, color, ticker } = token(safeTokenId(id));
      const badge = $(index === 0 ? 'input' : 'second').nextElementSibling;
      badge.firstElementChild.textContent = icon;
      badge.firstElementChild.className = color;
      badge.lastChild.textContent = ticker;
    });
  }

  try {
    pairKey(...ids);
    const assets = ids.map(safeTokenId);
    if (view === 'swap' && direction === 1) assets.reverse();
    assets.forEach((asset, index) => {
      const shared = wallet?.balances.get(asset);
      const role = view === 'swap' ? ['Pay', 'Receive'][index] : ['Asset A', 'Asset B'][index];
      const balance = shared === undefined
        ? (wallet ? 'Not shared' : 'Connect Humid')
        : formatAmount(shared);
      row(role + ' available · ' + token(asset).ticker, balance);
    });

    if (view === 'swap') {
      row('Swap fee', '1% · retained in pool');
    } else if (mode === 'add' && $('input').value && $('second').value) {
      const amounts = [parseAmount($('input').value), parseAmount($('second').value)];
      const exceedsBalance = amounts.some((amount, index) => {
        const shared = wallet?.balances.get(assets[index]);
        return shared !== undefined && amount > shared;
      });
      if (exceedsBalance) throw Error('Deposit exceeds the balance shared by Humid.');
      const estimate = createPool(...assets, ...amounts);
      row('Estimated initial price', (Number(amounts[1]) / Number(amounts[0])).toPrecision(7) + ' B per A');
      row('Estimated starting LP supply', formatAmount(estimate.shares));
    }
  } catch (error) {
    row('Status', error.message);
  }
}

document.querySelector('nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button || button.dataset.view === view) return;
  view = button.dataset.view;
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

$('fields').addEventListener('input', event => {
  if (event.target.id === 'asset0') ids[0] = event.target.value;
  if (event.target.id === 'asset1') ids[1] = event.target.value;
  $('status').textContent = '';
  quote();
});

$('trade-form').addEventListener('submit', event => event.preventDefault());

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
    const assets = new Set(ids.map(safeTokenId).filter(Boolean));
    for (const asset of assets) {
      current.balances.delete(asset);
      try {
        current.balances.set(asset, await readHumidBalance(current, asset));
      } catch { unavailable = true; }
      showWallet();
    }
    $('status').textContent = unavailable
      ? 'Some wallet details were not shared. You can request them from the wallet menu.'
      : 'Wallet details shared.';
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
