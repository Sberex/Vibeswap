import { execFile } from 'node:child_process';
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { address, AssetHash, ElementsValue, Transaction, issuance, networks } from 'liquidjs-lib';
import { LP_CAP, createPool, parseAmount } from '../src/amm.js';
import { assetPrecision, TESTNET_PAIR } from '../src/testnet.js';
import { acceptWalletSignature, buildPlan, BURN, explicit, FEE, HEX_ID } from './transactions.js';

const run = promisify(execFile);
const SIMC = process.env.SIMC || 'simc';
const HAL = process.env.HAL_SIMPLICITY || 'hal-simplicity';
const SCRIPT = fileURLToPath(new URL('../contracts/pool.simf', import.meta.url));
const KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
const API = (process.env.VIBESWAP_ESPLORA || 'https://blockstream.info/liquidtestnet/api').replace(/\/$/, '');
const registry = process.env.VIBESWAP_POOL_FILE || '.vibeswap-pool.json';
const genesis = Buffer.from(networks.testnet.genesisBlockHash).reverse().toString('hex');
let checkedNetwork;
let activePlan;
let busy = false;

async function command(program, args) {
  let stdout;
  try {
    ({ stdout } = await run(program, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) {
    throw Error(error.code === 'ENOENT'
      ? 'Install ' + program + ' and restart Vibeswap.'
      : 'Transaction tool ' + program + ' failed. Check the configured tool version.');
  }
  const result = JSON.parse(stdout);
  if (result?.error) throw Error(String(result.error));
  return result;
}

async function compile(lp) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeswap-'));
  try {
    const params = Object.fromEntries(['ASSET_A', 'ASSET_B', 'LP_ASSET'].map((name, i) => [
      name, { type: 'u256', value: '0x' + Buffer.from([...TESTNET_PAIR, lp][i], 'hex').reverse().toString('hex') },
    ]));
    const file = join(dir, 'params.json');
    await writeFile(file, JSON.stringify(params));
    const { cmr, program } = await command(SIMC, [SCRIPT, '-a', file, '--json']);
    const info = await command(HAL, ['simplicity', 'info', program]);
    return { cmr, program, script: address.toOutputScript(info.liquid_testnet_address_unconf, networks.testnet) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function explorer(path, options) {
  let response;
  try {
    response = await fetch(API + path, { ...options, signal: AbortSignal.timeout(10000) });
  } catch {
    throw Error('Cannot reach the Liquid Testnet explorer. Check VIBESWAP_ESPLORA and network access.');
  }
  const body = await response.text();
  if (!response.ok) {
    const detail = options?.method === 'POST' && response.status === 400 ? ' ' + body.slice(0, 320) : '';
    throw Error('Liquid Testnet explorer returned HTTP ' + response.status + '.' + detail);
  }
  return body;
}

async function checkNetwork() {
  checkedNetwork ??= explorer('/block-height/0').then(hash => {
    if (hash.trim() !== genesis) throw Error('The explorer is not on Liquid Testnet.');
  }).catch(error => {
    checkedNetwork = undefined;
    throw error;
  });
  await checkedNetwork;
}

async function anchor() {
  if (process.env.VIBESWAP_POOL_GENESIS) return process.env.VIBESWAP_POOL_GENESIS.trim();
  try {
    return JSON.parse(await readFile(registry, 'utf8')).genesis;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function rawTransaction(txid) {
  if (!HEX_ID.test(txid)) throw Error('Invalid pool transaction ID.');
  const transaction = Transaction.fromHex((await explorer('/tx/' + txid + '/hex')).trim());
  if (transaction.getId() !== txid) throw Error('The explorer returned a different pool transaction.');
  return transaction;
}

function issuedAsset(transaction) {
  const fresh = transaction.ins.filter(input => input.issuance && !issuance.isReissuance(input.issuance));
  if (fresh.length !== 1 || issuance.hasTokenAmount(fresh[0].issuance) ||
      fresh[0].issuance.assetAmount[0] !== 1 ||
      BigInt(ElementsValue.fromBytes(fresh[0].issuance.assetAmount).number) !== LP_CAP) {
    throw Error('Pool genesis does not contain the expected one-time LP issuance.');
  }
  return AssetHash.fromBytes(issuance.calculateAsset(issuance.issuanceEntropyFromInput(fresh[0]))).hex;
}

function state(transaction, lp, script) {
  const assets = [...TESTNET_PAIR, lp];
  const values = assets.map((expected, index) => {
    const out = transaction.outs[index];
    const [asset, value] = explicit(out);
    if (asset !== expected || !out.script.equals(script) || value <= 0n) {
      throw Error('Invalid pool covenant output at index ' + index + '.');
    }
    return value;
  });
  const shares = LP_CAP - values[2];
  if (shares <= 0n) throw Error('Invalid LP inventory.');
  return { txid: transaction.getId(), assets: TESTNET_PAIR, lp, reserves: values.slice(0, 2), shares, transaction };
}

async function discover() {
  await checkNetwork();
  const root = await anchor();
  if (root === null) return null;
  const transaction = await rawTransaction(root);
  const lp = issuedAsset(transaction);
  const contract = await compile(lp);
  let pool = state(transaction, lp, contract.script);
  const [burnAsset, burnAmount] = explicit(transaction.outs[4]);
  const [payoutAsset, payout] = explicit(transaction.outs[3]);
  if (!transaction.outs[4].script.equals(BURN) || burnAsset !== lp || burnAmount !== 1n ||
      payoutAsset !== lp || payout !== pool.shares - 1n ||
      createPool(...TESTNET_PAIR, ...pool.reserves).shares !== pool.shares) {
    throw Error('The configured genesis does not match Vibeswap’s LP allocation.');
  }
  for (let i = 0; i < 500; i++) {
    const spend = JSON.parse(await explorer('/tx/' + pool.txid + '/outspend/0'));
    if (!spend.spent) {
      const status = JSON.parse(await explorer('/tx/' + pool.txid + '/status'));
      return { ...pool, confirmed: status.confirmed === true };
    }
    const next = await rawTransaction(spend.txid);
    if (!next.ins.slice(0, 3).every((input, index) =>
      Buffer.from(input.hash).reverse().toString('hex') === pool.txid && input.index === index &&
      input.sequence === 1) || next.ins.length < 3 || next.version !== 2) {
      throw Error('Invalid spend of the canonical pool.');
    }
    pool = state(next, lp, contract.script);
  }
  throw Error('Canonical pool history exceeds the discovery limit.');
}

async function prepare(body) {
  if (activePlan?.expires > Date.now()) throw Error('A wallet review is active. Finish or cancel it first.');
  const pool = await discover();
  if (body.expectedTxid !== (pool?.txid ?? null)) throw Error('The pool changed. Refresh the quote.');
  if (!Array.isArray(body.coins) || body.coins.length > 1000) throw Error('Invalid wallet UTXO list.');
  const plan = await buildPlan({
    action: body.action, pool,
    amount: parseAmount(body.amount, assetPrecision(body.action === 'swap' ? body.inputAsset : TESTNET_PAIR[0])),
    second: ['create', 'add'].includes(body.action) ? parseAmount(body.second, assetPrecision(TESTNET_PAIR[1])) : undefined,
    inputAsset: body.inputAsset, recipient: body.address, coins: body.coins, compile,
  });
  activePlan = { ...plan, id: randomUUID(), expires: Date.now() + 5 * 60 * 1000, isGenesis: !pool };
  return { id: activePlan.id, pset: plan.pset.toBase64(), signInputs: plan.signInputs };
}

async function broadcast(body) {
  if (activePlan?.id !== body.id || activePlan.expires <= Date.now()) throw Error('The wallet review expired.');
  const plan = activePlan;
  let pset = acceptWalletSignature(plan, body.pset);
  for (let i = 0; i < plan.prefix; i++) {
    const out = plan.pset.inputs[i].witnessUtxo;
    const [asset, amount] = explicit(out);
    const decimal = (amount / 100000000n) + '.' + String(amount % 100000000n).padStart(8, '0');
    pset = (await command(HAL, ['simplicity', 'pset', 'update-input', pset, String(i), '-i',
      out.script.toString('hex') + ':' + asset + ':' + decimal, '-c', plan.contract.cmr, '-p', KEY])).pset;
    pset = (await command(HAL, ['simplicity', 'pset', 'finalize', pset, String(i), plan.contract.program, ''])).pset;
  }
  const raw = await command(HAL, ['simplicity', 'pset', 'extract', pset]);
  const id = Transaction.fromHex(raw).getId();
  await checkNetwork();
  try {
    const result = (await explorer('/tx', { method: 'POST', body: raw })).trim();
    if (result !== id) throw Error('Unexpected explorer broadcast response.');
  } catch (error) {
    // A timeout can occur after the explorer has already relayed the transaction.
    const accepted = await rawTransaction(id).then(() => true, () => false);
    if (!accepted) throw Error(error.message + ' Candidate transaction ID: ' + id + '.');
  }
  if (plan.isGenesis) {
    const temp = registry + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify({ genesis: id }) + '\n', { mode: 0o600 });
      await rename(temp, registry);
    } catch {
      throw Error('Pool broadcast as ' + id + '. Save it as VIBESWAP_POOL_GENESIS before restarting.');
    }
  }
  activePlan = undefined;
  return { txid: id };
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function testnetRequest(request, response, path) {
  const methods = { '/api/pool': 'GET', '/api/prepare': 'POST', '/api/broadcast': 'POST', '/api/cancel': 'POST' };
  const send = (code, data) => response.writeHead(code, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  }).end(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  if (methods[path] !== request.method) return send(405, { error: 'Invalid API method.' });
  if (request.method === 'POST' && (!request.headers['content-type']?.startsWith('application/json') ||
      (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host))) {
    return send(403, { error: 'Use the Vibeswap page to submit wallet transactions.' });
  }
  if (path === '/api/pool') {
    try {
      const pool = await discover();
      if (!pool) return send(200, { pool: null, fee: FEE });
      const { transaction, ...display } = pool;
      return send(200, { pool: display, fee: FEE });
    } catch (error) {
      return send(502, { error: error.message });
    }
  }
  if (busy) return send(409, { error: 'Another wallet action is in progress.' });
  busy = true;
  try {
    const body = await bodyJson(request);
    if (path === '/api/prepare') return send(200, await prepare(body));
    if (path === '/api/broadcast') return send(200, await broadcast(body));
    if (activePlan?.id === body.id) activePlan = undefined;
    return send(200, {});
  } catch (error) {
    return send(400, { error: error.message });
  } finally {
    busy = false;
  }
}
