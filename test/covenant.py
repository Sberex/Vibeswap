"""Execute Vibeswap's covenant against synthetic Elements PSETs.

Requires simc 0.7.2 and hal-simplicity 0.2.0 at 9ceb903d.
Set SIMC or HAL_SIMPLICITY to override the executable paths.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


SIMC = os.environ.get("SIMC", "simc")
HAL = os.environ.get("HAL_SIMPLICITY", "hal-simplicity")
CONTRACT = Path(__file__).resolve().parents[1] / "contracts" / "pool.simf"
A, B, LP, FEE = (bytes(range(n, n + 32)).hex() for n in (1, 33, 65, 97))
KEY = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"
CAP = 10**15
ASSETS = (A, B, LP)
OLD = (1000, 2000, CAP - 1414)


def call(*args):
    command = subprocess.run(args, text=True, capture_output=True, check=False)
    if command.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed: {command.stderr}")
    result = json.loads(command.stdout)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result


def compile_pool(assets=ASSETS):
    params = {key: {"value": "0x" + bytes.fromhex(value)[::-1].hex(), "type": "u256"}
              for key, value in zip(("ASSET_A", "ASSET_B", "LP_ASSET"), assets)}
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / "params.json"
        path.write_text(json.dumps(params), encoding="utf-8")
        return call(SIMC, str(CONTRACT), "-a", str(path), "--json")


def decimal(sats):
    return f"{sats // 10**8}.{sats % 10**8:08d}"


def outputs_json(outputs):
    return "[" + ",".join(
        f'{{"address":{json.dumps(address)},"asset":"{asset}","amount":{decimal(sats)}}}'
        for address, asset, sats in outputs
    ) + "]"


def main():
    program = compile_pool()
    encoded, cmr = program["program"], program["cmr"]
    address = call(HAL, "simplicity", "info", encoded)["liquid_testnet_address_unconf"]
    script = call(HAL, "address", "inspect", address)["script_pub_key"]["hex"]
    # Payout scripts are intentionally irrelevant to this covenant. The trader's
    # signed funding inputs protect the actual recipient in a real transaction.
    recipient = address

    def vector(name, replacements, payouts, expected, *,
               foreign_origin=False, old_sequence=1, wrong_script=False,
               wrong_asset=False):
        inputs = [
            {"txid": ("bb" if foreign_origin and i == 1 else "aa") * 32,
             "vout": i, "sequence": old_sequence}
            for i in range(len(OLD))
        ]
        outputs = []
        for index, (asset, amount) in enumerate(zip(ASSETS, replacements)):
            destination = "fee" if wrong_script and index == 1 else address
            outputs.append((destination, FEE if wrong_asset and index == 1 else asset, amount))
        outputs.extend((recipient, asset, amount) for asset, amount in payouts)
        outputs.append(("fee", FEE, 200))
        pset = call(HAL, "simplicity", "pset", "create", json.dumps(inputs),
                    outputs_json(outputs))["pset"]
        for index, (asset, amount) in enumerate(zip(ASSETS, OLD)):
            pset = call(HAL, "simplicity", "pset", "update-input", pset,
                        str(index), "-i", f"{script}:{asset}:{decimal(amount)}",
                        "-c", cmr, "-p", KEY)["pset"]
        for index in range(len(OLD)):
            result = call(HAL, "simplicity", "pset", "run", pset, str(index), encoded, "")
            jets = result["jets"]
            if len(jets) == 1 and jets[0]["jet"] == "eq_256" and not jets[0]["success"]:
                raise AssertionError(
                    f"{name}, input {index}: HAL failed before producing the first "
                    "equality result. Check the native Simplicity ABI. On Intel macOS, "
                    "rebuild HAL with simplicity-sys 0.6.2 as described in README.md. "
                    f"Trace: {jets}"
                )
            if result["success"] != expected:
                raise AssertionError(f"{name}, input {index}: {jets[-4:]}")
        print(f"PASS {name}")

    vector("A to B", (1100, 1820, OLD[2]), [(B, 180)], True)
    vector("B to A", (910, 2200, OLD[2]), [(A, 90)], True)
    vector("add liquidity", (1100, 2200, OLD[2] - 141), [(LP, 141)], True)
    vector("remove liquidity", (500, 1000, OLD[2] + 707), [(A, 500), (B, 1000)], True)
    vector("reject excess swap output", (1100, 1819, OLD[2]), [(B, 181)], False)
    vector("reject incorrect swap recipient amount", (1100, 1820, OLD[2]), [(B, 179)], False)
    vector("reject underfunded liquidity", (1099, 2200, OLD[2] - 141), [(LP, 141)], False)
    vector("reject excess withdrawal", (499, 1000, OLD[2] + 707), [(A, 501), (B, 1000)], False)
    vector("reject mixed origins", (1100, 1820, OLD[2]), [(B, 180)], False, foreign_origin=True)
    vector("reject disabled pool delay", (1100, 1820, OLD[2]), [(B, 180)], False, old_sequence=0)
    vector("reject substituted output script", (1100, 1820, OLD[2]), [(B, 180)], False, wrong_script=True)
    vector("reject substituted reserve asset", (1100, 1820, OLD[2]), [(B, 180)], False, wrong_asset=True)


if __name__ == "__main__":
    main()
