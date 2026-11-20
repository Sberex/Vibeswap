"""Exercise confirmed Vibeswap transitions on a fresh, offline Elements regtest."""
from decimal import Decimal
from functools import partial
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

from covenant import HAL, KEY, CAP, decimal, outputs_json, compile_pool, call


def rpc_call(cli, method, *args):
    proc = subprocess.run([*cli, method, *args], text=True, capture_output=True, timeout=30)
    if proc.returncode:
        raise RuntimeError(f"Elements RPC {method} failed: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout, parse_float=Decimal)
    except json.JSONDecodeError:
        return proc.stdout.strip()

def sats(value):
    return int(value * 10**8)

def unconf(rpc):
    return rpc('getaddressinfo', rpc('getnewaddress'))['unconfidential']

def pick(rpc, asset, minimum):
    for coin in rpc('listunspent', '0'):
        if coin['asset'] == asset and 'amountcommitment' not in coin and sats(coin['amount']) >= minimum:
            return coin
    raise ValueError(f'No explicit {minimum} {asset}')

def run_pool(rpc):
    rpc('createwallet', 'sandbox')
    rpc('rescanblockchain', '0')
    miner = rpc('getnewaddress')
    rpc('generatetoaddress', '2', miner)
    assets = sorted(rpc('issueasset', '1', '0', 'false')['asset'] for _ in range(2))
    a, b = assets
    lp = rpc('issueasset', decimal(CAP), '0', 'false')['asset']
    btc = rpc('dumpassetlabels')['bitcoin']
    rpc('generatetoaddress', '1', miner)
    address = unconf(rpc)
    for asset, value in [(a, 10000000), (b, 10000000), (lp, CAP), (btc, 100000000)]:
        rpc('-named', 'sendtoaddress', 'address=' + address, 'amount=' + decimal(value), 'assetlabel=' + asset, 'fee_rate=1')
    rpc('generatetoaddress', '1', miner)
    program = compile_pool((a, b, lp))
    encoded, cmr = program['program'], program['cmr']
    origin = call(HAL, 'simplicity', 'info', encoded)['liquid_testnet_address_unconf']
    script = call(HAL, 'address', 'inspect', origin)['script_pub_key']['hex']
    fee = 5000

    def execute(name, prior, prior_values, values, payouts, funding, mine=True, require_confirmation=False):
        pool_inputs = [] if prior is None else [
            {'txid': prior, 'vout': i, 'sequence': 1, 'asset': asset,
             'scriptPubKey': script, 'amount': Decimal(decimal(qty))}
            for i, (asset, qty) in enumerate(zip((a, b, lp), prior_values))
        ]
        funding = [*funding, (btc, fee)]
        wallet_inputs = [pick(rpc, asset, qty) for asset, qty in funding]
        inputs = pool_inputs + wallet_inputs
        outputs = [(origin, asset, qty) for asset, qty in zip((a, b, lp), values)]
        outputs.extend(payouts)
        for coin, (asset, qty) in zip(wallet_inputs, funding):
            change = sats(coin['amount']) - qty
            if change:
                outputs.append((address, asset, change))
        outputs.append(('fee', btc, fee))
        pset = call(HAL, 'simplicity', 'pset', 'create',
                    json.dumps([{k: c[k] for k in ('txid', 'vout', 'sequence') if k in c} for c in inputs]),
                    outputs_json(outputs))['pset']
        for i, coin in enumerate(pool_inputs):
            amount = decimal(sats(coin['amount']))
            pset = call(HAL, 'simplicity', 'pset', 'update-input', pset, str(i),
                        '-i', f"{coin['scriptPubKey']}:{coin['asset']}:{amount}", '-c', cmr, '-p', KEY)['pset']
        pset = rpc('walletprocesspsbt', pset, 'false', 'ALL', 'true', 'false')['psbt']
        signed = rpc('walletprocesspsbt', pset, 'true', 'ALL', 'true', 'false')['psbt']
        finalized = subprocess.run(
            ['node', '--input-type=module', '-e', '''
                import { readFileSync } from 'node:fs';
                import { Pset } from 'liquidjs-lib';
                import { acceptWalletSignature } from './lib/transactions.js';
                const { unsigned, signed, indexes } = JSON.parse(readFileSync(0, 'utf8'));
                const pset = Pset.fromBase64(unsigned);
                const signInputs = indexes.map(index => ({ index }));
                process.stdout.write(acceptWalletSignature({ pset, signInputs }, signed));
            '''],
            input=json.dumps({
                'unsigned': pset,
                'signed': signed,
                'indexes': list(range(len(pool_inputs), len(inputs))),
            }),
            cwd=Path(__file__).resolve().parents[1],
            text=True, capture_output=True, check=False, timeout=30,
        )
        if finalized.returncode:
            raise RuntimeError(f"Vibeswap failed to finalize signed wallet inputs: {finalized.stderr}")
        pset = finalized.stdout
        for i in range(len(pool_inputs)):
            pset = call(HAL, 'simplicity', 'pset', 'finalize', pset, str(i), encoded, '')['pset']
        raw = call(HAL, 'simplicity', 'pset', 'extract', pset)
        raw_list = json.dumps([raw])
        result = rpc('testmempoolaccept', raw_list)[0]
        if require_confirmation:
            if result['allowed'] or 'non-BIP68-final' not in result.get('reject-reason', ''):
                raise AssertionError(f"Expected a relative-lock rejection: {result}")
            print("PASS rejects a second transition while the prior state is unconfirmed")
            rpc('generatetoaddress', '1', miner)
            result = rpc('testmempoolaccept', raw_list)[0]
        if not result['allowed']:
            raise AssertionError(f"{name}: {result}")
        txid = rpc('sendrawtransaction', raw)
        if mine:
            rpc('generatetoaddress', '1', miner)
            if rpc('gettxout', txid, '0')['confirmations'] < 1:
                raise AssertionError(f"{name}: pool state was not confirmed")
        print(f"PASS {name}")
        return txid

    initial = (1000000, 2000000, CAP - 1414213)
    tx = execute('genesis', None, None, initial, [(address, lp, 1414212), ('data:', lp, 1)], [(a, initial[0]), (b, initial[1]), (lp, CAP)])
    output = 99*100000*initial[1]//(100*initial[0]+99*100000)
    traded = (1100000, 2000000-output, initial[2])
    tx = execute('swap A to B', tx, initial, traded, [(address, b, output)], [(a, 100000)], mine=False)
    minted = 100000
    added = tuple((q*minted+1414213-1)//1414213 for q in traded[:2])
    supplied = (traded[0]+added[0], traded[1]+added[1], traded[2]-minted)
    tx = execute('add liquidity', tx, traded, supplied, [(address, lp, minted)], [(a, added[0]), (b, added[1])], require_confirmation=True)
    withdrawn = tuple(q*minted//(1414213+minted) for q in supplied[:2])
    remaining = (supplied[0]-withdrawn[0], supplied[1]-withdrawn[1], supplied[2]+minted)
    tx = execute('remove liquidity', tx, supplied, remaining, [(address, a, withdrawn[0]), (address, b, withdrawn[1])], [(lp, minted)])

    input_b = 100000
    output_a = 99 * input_b * remaining[0] // (100 * remaining[1] + 99 * input_b)
    reverse_swap = (remaining[0] - output_a, remaining[1] + input_b, remaining[2])
    execute('swap B to A', tx, remaining, reverse_swap, [(address, a, output_a)], [(b, input_b)])


def main():
    cli_bin = os.environ.get('ELEMENTS_CLI', 'elements-cli')
    daemon_bin = os.environ.get('ELEMENTSD', 'elementsd')
    with tempfile.TemporaryDirectory(prefix='vibeswap-regtest-') as directory:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        options = ['-chain=elementsregtest', f'-datadir={directory}', f'-rpcport={port}']
        cli = [cli_bin, *options]
        daemon = [daemon_bin, *options, '-bech32_hrp=tex', '-listen=0', '-dnsseed=0',
                  '-discover=0', '-connect=0', '-initialfreecoins=2100000000000000',
                  '-anyonecanspendaremine=1', '-con_connect_genesis_outputs=1',
                  '-validatepegin=0', '-daemonwait']
        subprocess.run(daemon, check=True, capture_output=True, timeout=30)
        try:
            run_pool(partial(rpc_call, cli))
        finally:
            subprocess.run([*cli, 'stop'], check=False, capture_output=True, timeout=30)


if __name__ == '__main__':
    main()
