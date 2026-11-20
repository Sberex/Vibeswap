import { TESTNET } from './testnet.js';

export async function connectHumid(provider) {
  if (typeof provider?.request !== 'function') {
    throw Error('The Humid browser extension was not found.');
  }
  const result = await provider.request({
    method: 'wallet_createSession',
    params: {
      optionalScopes: {
        [TESTNET]: { methods: ['getAddress', 'getBalance', 'getUTXOs', 'signPset'], notifications: [] },
      },
    },
  });
  const account = result?.sessionScopes?.[TESTNET]?.accounts?.[0];
  if (typeof account !== 'string' || !account.startsWith(TESTNET + ':') ||
      account.length === TESTNET.length + 1) {
    throw Error('Approve a Liquid Testnet account in Humid to connect.');
  }
  return { provider, methods: result.sessionScopes[TESTNET].methods ?? [] };
}

export async function disconnectHumid(provider) {
  const result = await provider.request({ method: 'wallet_revokeSession' });
  if (result?.revoked !== true) throw Error('Humid did not confirm disconnection.');
}

function read(session, method, params) {
  if (!session.methods.includes(method)) throw Error('Humid permission for ' + method + ' was not granted. Reconnect and approve it.');
  return session.provider.request({
    method: 'wallet_invokeMethod',
    params: { scope: TESTNET, request: { method, params } },
  });
}

export async function readHumidAddress(session) {
  const result = await read(session, 'getAddress', { confidential: true });
  if (result?.chainId !== TESTNET || typeof result.address !== 'string' || !result.address.trim()) {
    throw Error('Humid did not return a Liquid Testnet address.');
  }
  return result.address;
}

export async function readHumidBalance(session, asset) {
  const assetId = asset ? TESTNET + '/elip144:' + asset : undefined;
  const result = await read(session, 'getBalance', assetId ? { assetId } : {});
  const expected = assetId ?? result?.policyAssetId;
  if (result?.chainId !== TESTNET || typeof expected !== 'string' ||
      result.assetId !== expected || typeof result.balance !== 'string' || !/^\d+$/.test(result.balance)) {
    throw Error('Humid did not return a valid Liquid Testnet balance.');
  }
  return BigInt(result.balance);
}

export async function readHumidCoins(session, asset) {
  const assetId = TESTNET + '/elip144:' + asset;
  const result = await read(session, 'getUTXOs', { assetId });
  if (result?.chainId !== TESTNET || result.assetId !== assetId || !Array.isArray(result.utxos)) {
    throw Error('Humid did not provide Testnet coins for ' + asset.slice(0, 8) + '….');
  }
  // Only send the transaction planner the fields needed for coin selection and signing.
  return result.utxos.map(({ address, amount, assetId, confidential, spendable, txid, vout }) =>
    ({ address, amount, assetId, confidential, spendable, txid, vout }));
}

export async function signHumidPset(session, { pset, signInputs }) {
  const result = await read(session, 'signPset', { pset, signInputs, broadcast: false });
  if (typeof result?.pset !== 'string' || !result.pset || result.txid) {
    throw Error('Humid did not return a signed PSET for finalization.');
  }
  return result.pset;
}

export function popupUnavailable(error) {
  return [error?.message, error?.data?.message, error?.cause?.message, error]
    .some(message => typeof message === 'string' && /No handler registered.*requestConfirmation/i.test(message));
}
