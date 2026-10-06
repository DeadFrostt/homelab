#!/usr/bin/env python3
"""Exercise corruption, incomplete, stale and wrong-cluster refusal without writers."""
import json, shutil, sys, tempfile
from pathlib import Path
import recovery
from recovery import verify,guard,CACHE,CONFIG
def refused(call):
    try:call()
    except Exception:return
    raise AssertionError('Unsafe recovery input was accepted')
def main(snapshot):
    guard();verify(CACHE/snapshot);tests=[]
    with tempfile.TemporaryDirectory(prefix='dr-rejection-') as temporary:
        target=Path(temporary)/snapshot;shutil.copytree(CACHE/snapshot,target)
        original=(target/'manifest.json').read_bytes()
        (target/'manifest.json').write_bytes(original+b' ')
        refused(lambda:verify(target));tests.append('corrupt metadata')
        (target/'manifest.json').write_bytes(original)
        encrypted=next(target.rglob('*.age'));saved=encrypted.read_bytes();encrypted.unlink()
        refused(lambda:verify(target));tests.append('missing encrypted object');encrypted.write_bytes(saved)
        sig=(target/'SHA256SUMS.sig').read_bytes();(target/'SHA256SUMS.sig').write_bytes(bytes([sig[0]^1])+sig[1:])
        refused(lambda:verify(target));tests.append('invalid source signature');(target/'SHA256SUMS.sig').write_bytes(sig)
        refused(lambda:verify(target,max_age_hours=0));tests.append('stale recovery point')
        verify(target)
    with tempfile.TemporaryDirectory(prefix='dr-identity-') as temporary:
        wrong=json.loads((CONFIG/'recovery.json').read_bytes());wrong['cluster_uid']='primary-cluster-must-be-refused'
        (Path(temporary)/'recovery.json').write_text(json.dumps(wrong))
        original_config=recovery.CONFIG
        try:
            recovery.CONFIG=Path(temporary)
            refused(guard);tests.append('wrong cluster identity')
        finally:recovery.CONFIG=original_config
    print(json.dumps({'snapshot':snapshot,'refusal_tests_passed':tests}))
if __name__=='__main__':main(sys.argv[1])
