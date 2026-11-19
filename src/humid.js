const TESTNET = 'bip122:a771da8e52ee6ad581ed1e9a99825e5b';

export async function connectHumid(provider) {
  if (typeof provider?.request !== 'function') {
    throw Error('The Humid browser extension was not found.');
  }
  const result = await provider.request({
    method: 'wallet_createSession',
    params: {
      optionalScopes: {
        [TESTNET]: { methods: ['getAddress', 'getBalance'], notifications: [] },
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
  if (!session.methods.includes(method)) throw Error('Sharing permission was not granted.');
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
