export const TESTNET = 'bip122:a771da8e52ee6ad581ed1e9a99825e5b';
export const TESTNET_PAIR = [
  '144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
  '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5',
];

// Registered display precision for the fixed pair. Vibeswap LP shares use 8 decimals.
export function assetPrecision(asset) {
  return asset === TESTNET_PAIR[1] ? 3 : 8;
}
