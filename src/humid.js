const TESTNET = 'bip122:a771da8e52ee6ad581ed1e9a99825e5b';

export async function connectHumid(provider) {
  if (typeof provider?.request !== 'function') {
    throw Error('The Humid browser extension was not found.');
  }
  const result = await provider.request({
    method: 'wallet_createSession',
    params: {
      optionalScopes: {
        [TESTNET]: { methods: [], notifications: [] },
      },
    },
  });
  const account = result?.sessionScopes?.[TESTNET]?.accounts?.[0];
  if (typeof account !== 'string' || !account.startsWith(TESTNET + ':') ||
      account.length === TESTNET.length + 1) {
    throw Error('Approve a Liquid Testnet account in Humid to connect.');
  }
  return account;
}

export async function disconnectHumid(provider) {
  const result = await provider.request({ method: 'wallet_revokeSession' });
  if (result?.revoked !== true) throw Error('Humid did not confirm disconnection.');
}
