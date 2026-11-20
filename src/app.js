import { addLiquidity, createPool, formatAmount, parseAmount, removeLiquidity, swap } from './amm.js';
import { connectHumid, disconnectHumid, popupUnavailable, readHumidAddress, readHumidBalance, readHumidCoins, signHumidPset } from './humid.js';

import { assetPrecision, TESTNET_PAIR } from './testnet.js';

const $ = id => document.getElementById(id);
let view = 'swap';
let mode = 'add';
let direction = 0;
const ids = [...TESTNET_PAIR];
let wallet;
let pool;
let networkFee;
let poolError;
let pending = false;
let action;
let readingWallet = false;

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const response = await fetch('/api/' + path, opts);
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Vibeswap could not complete the request.');
  return result;
}

async function refreshPool() {
  try {
    const result = await api('pool');
    networkFee = BigInt(result.fee);
    pool = result.pool ? {
      ...result.pool, shares: BigInt(result.pool.shares), reserves: result.pool.reserves.map(BigInt),
    } : null;
    poolError = undefined;
  } catch (error) {
    poolError = error.message;
  }
  quote();
}

function showWalletError(error, fallback) {
  const recovery = popupUnavailable(error);
  $('wallet-reload').hidden = !recovery;
  $('status').textContent = recovery
    ? 'Humid’s approval window is unavailable. Close any open Humid popup, reload Vibeswap, then try again.'
    : error.message || fallback;
}


function token(id) {
  if (id === TESTNET_PAIR[0]) return { ticker: 'tL-BTC', icon: '₿', color: 'orange' };
  if (id === TESTNET_PAIR[1]) return { ticker: 'TEST', icon: '◇', color: '' };
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
    <input id="asset${index}" spellcheck="false" autocomplete="off" readonly></div>`;
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
  $('submit').disabled = true;
  $('submit').textContent = pending ? 'Wallet action in progress…' : 'Enter an amount';
  action = undefined;
  if ($('output')) $('output').value = '';

  const isSwap = view === 'swap';
  const assets = isSwap && direction === 1 ? [...ids].reverse() : ids;
  assets.forEach((asset, index) => {
    const shared = wallet?.balances.get(asset);
    const role = isSwap ? ['Pay', 'Receive'][index] : ['Asset A', 'Asset B'][index];
    row(role + ' available · ' + token(asset).ticker, shared === undefined
      ? (wallet ? 'Not shared' : 'Connect Humid')
      : formatAmount(shared, assetPrecision(asset)));
  });
  if (pool) {
    row('Pool reserves', pool.reserves.map((amount, i) => formatAmount(amount, assetPrecision(ids[i]))).join(' / '));
    if (view === 'liquidity' && mode === 'remove') {
      const balance = wallet?.balances.get(pool.lp);
      row('LP shares available', balance === undefined ? 'Not shared' : formatAmount(balance));
    }
  }
  if (poolError || pool === undefined) {
    $('submit').textContent = poolError ? 'Testnet unavailable' : 'Checking Testnet…';
    if (poolError) row('Status', poolError);
    return;
  }
  if (pool && !pool.confirmed) {
    $('submit').textContent = 'Waiting for pool confirmation';
    return;
  }
  if (!pool && (isSwap || mode === 'remove')) {
    $('submit').textContent = 'Create the pool first';
    return;
  }
  row('Network fee', formatAmount(networkFee) + ' tL-BTC');
  if (isSwap) row('Swap fee', '1% · retained in pool');

  try {
    if (!$('input').value || ($('second') && !$('second').value)) return;
    const value = parseAmount($('input').value, isSwap ? assetPrecision(assets[0]) : 8);
    const second = $('second') ? parseAmount($('second').value, assetPrecision(ids[1])) : undefined;
    let next;
    const needs = new Map([[TESTNET_PAIR[0], networkFee]]);
    const need = (asset, amount) => needs.set(asset, (needs.get(asset) ?? 0n) + amount);
    if (isSwap) {
      next = swap(pool, assets[0], value);
      $('output').value = formatAmount(next.output, assetPrecision(assets[1]));
      need(assets[0], value);
      action = 'swap';
    } else if (mode === 'remove') {
      next = removeLiquidity(pool, value);
      next.payouts.forEach((amount, index) => row('Receive ' + token(ids[index]).ticker, formatAmount(amount, assetPrecision(ids[index]))));
      need(pool.lp, value);
      action = 'remove';
    } else if (pool) {
      next = addLiquidity(pool, [value, second]);
      next.deposits.forEach((amount, index) => {
        need(ids[index], amount);
        row('Deposit ' + token(ids[index]).ticker, formatAmount(amount, assetPrecision(ids[index])));
      });
      row('LP shares received', formatAmount(next.minted));
      action = 'add';
    } else {
      next = createPool(...ids, value, second);
      need(ids[0], value);
      need(ids[1], second);
      row('Initial price', (Number(second) / Number(value) * 10 ** (assetPrecision(ids[0]) - assetPrecision(ids[1]))).toPrecision(7) + ' B per A');
      row('LP shares received', formatAmount(next.shares - 1n));
      action = 'create';
    }
    if (pending || readingWallet) return;
    if (!wallet?.address) {
      $('submit').textContent = 'Connect Humid and share an address';
      return;
    }
    for (const [asset, amount] of needs) {
      const balance = wallet.balances.get(asset);
      if (balance !== undefined && amount > balance) throw Error('Insufficient shared balance for ' + token(asset).ticker + '.');
    }
    $('submit').textContent = { create: 'Create pool', add: 'Add liquidity', remove: 'Remove liquidity', swap: 'Swap' }[action];
    $('submit').disabled = false;
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
  $('status').textContent = '';
  quote();
});

$('trade-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('submit').disabled || pending || !wallet?.address) return;
  const currentAction = action;
  const payload = {
    action: currentAction, expectedTxid: pool?.txid ?? null, inputAsset: ids[direction],
    amount: $('input').value, second: $('second')?.value, address: wallet.address,
  };
  let prepared;
  pending = true;
  $('wallet-disconnect').disabled = true;
  $('wallet-refresh').disabled = true;
  quote();
  try {
    $('status').textContent = 'Approve sharing spendable coins in Humid.';
    const assets = new Set([TESTNET_PAIR[0]]);
    if (currentAction === 'create' || currentAction === 'add') assets.add(TESTNET_PAIR[1]);
    if (currentAction === 'swap') assets.add(payload.inputAsset);
    if (currentAction === 'remove') assets.add(pool.lp);
    payload.coins = [];
    for (const asset of assets) payload.coins.push(...await readHumidCoins(wallet, asset));
    prepared = await api('prepare', payload);
    $('status').textContent = 'Review and sign the Liquid Testnet transaction in Humid.';
    const pset = await signHumidPset(wallet, prepared);
    $('status').textContent = 'Broadcasting to Liquid Testnet…';
    const { txid } = await api('broadcast', { id: prepared.id, pset });
    wallet.balances.clear();
    const link = $('txid');
    link.href = 'https://blockstream.info/liquidtestnet/tx/' + txid;
    link.textContent = txid;
    link.hidden = false;
    $('status').textContent = 'Broadcast accepted. Waiting for confirmation.';
  } catch (error) {
    showWalletError(error, 'Transaction failed.');
  } finally {
    if (prepared) await api('cancel', { id: prepared.id }).catch(() => {});
    await refreshPool();
    pending = false;
    $('wallet-disconnect').disabled = false;
    $('wallet-refresh').disabled = false;
    quote();
  }
});

render();
void refreshPool();
$('pool-refresh').addEventListener('click', () => { if (!pending) void refreshPool(); });
$('wallet-reload').addEventListener('click', () => window.location.reload());

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
  if (!wallet || readingWallet || pending) return;
  readingWallet = true;
  quote();
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
      } catch (error) { if (popupUnavailable(error)) throw error; unavailable = true; }
    }
    const assets = new Set([...ids, ...(pool ? [pool.lp] : [])]);
    for (const asset of assets) {
      current.balances.delete(asset);
      try {
        current.balances.set(asset, await readHumidBalance(current, asset));
      } catch (error) { if (popupUnavailable(error)) throw error; unavailable = true; }
      showWallet();
    }
    $('status').textContent = unavailable
      ? 'Some wallet details were not shared. You can request them from the wallet menu.'
      : 'Wallet details shared.';
  } catch (error) {
    showWalletError(error, 'Could not refresh wallet details.');
  } finally {
    readingWallet = false;
    controls.forEach(button => { button.disabled = false; });
    quote();
  }
}

$('wallet').addEventListener('click', async () => {
  const button = $('wallet');
  button.disabled = true;
  try {
    $('wallet-reload').hidden = true;
    const session = await connectHumid(window.humid);
    wallet = { ...session, address: '', balances: new Map() };
    showWallet();
    await loadWalletDetails();
  } catch (error) {
    showWalletError(error, 'Unable to connect to Humid.');
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
