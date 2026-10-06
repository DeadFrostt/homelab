#!/usr/bin/env python3
"""Offline recovery verifier. No routing changes or automatic promotion."""
import argparse, datetime as dt, hashlib, json, os, re, shutil, subprocess, tarfile, tempfile
from pathlib import Path
from retention import retention_plan

CONFIG = Path('/etc/homelab-dr')
CACHE = Path('/var/lib/homelab-dr/cache')
STAMP = re.compile(r'20[0-9]{6}T[0-9]{6}Z')
APPS = {'gatus','vaultwarden','actual-budget','couch-db','infisical','authentik','zipline','matrix','mas'}

def run(args, **kw):
    env = dict(os.environ); env.pop('JOURNAL_STREAM', None)
    return subprocess.run(args, env=env, check=True, **kw)

def guard():
    expected = json.loads((CONFIG/'recovery.json').read_text())
    uid = run(['k3s','kubectl','get','namespace','kube-system','-o','jsonpath={.metadata.uid}'],capture_output=True).stdout.decode()
    nodes = json.loads(run(['k3s','kubectl','get','nodes','-o','json'],capture_output=True).stdout)
    if uid != expected['cluster_uid'] or len(nodes['items']) != 1:
        raise ValueError('Recovery cluster identity mismatch')
    node = nodes['items'][0]['metadata']
    if node['name'] != 'ackermann-dr' or node.get('labels',{}).get('homelab.dev/site') != 'home-recovery':
        raise ValueError('Recovery node identity mismatch')
    return expected

def verify(path, max_age_hours=24, expected_site='yeager'):
    path = Path(path)
    if not STAMP.fullmatch(path.name): raise ValueError('Invalid snapshot identifier')
    sums = path/'SHA256SUMS'
    if expected_site not in ['yeager','ackermann-dr']: raise ValueError('Unknown backup site')
    public_key=CONFIG/('source-signing.pub' if expected_site=='yeager' else 'home-signing.pub')
    run(['openssl','pkeyutl','-verify','-pubin','-inkey',str(public_key),'-rawin','-in',str(sums),'-sigfile',str(path/'SHA256SUMS.sig')],capture_output=True)
    seen = set()
    for line in sums.read_text().splitlines():
        digest, name = line.split('  ',1)
        relative = Path(name)
        if not re.fullmatch('[0-9a-f]{64}',digest) or relative.is_absolute() or '..' in relative.parts or name in seen:
            raise ValueError('Unsafe checksum manifest')
        seen.add(name); f = path/relative
        if f.is_symlink() or not f.is_file() or not f.resolve().is_relative_to(path.resolve()):
            raise ValueError('Missing or unsafe snapshot file')
        with f.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=digest: raise ValueError('Snapshot checksum mismatch')
    if 'manifest.json' not in seen: raise ValueError('Unsigned snapshot metadata')
    manifest=json.loads((path/'manifest.json').read_text())
    if manifest['snapshot']!=path.name or manifest['source_site']!=expected_site or manifest.get('format')!=1:
        raise ValueError('Snapshot metadata mismatch')
    if not manifest['applications'] or not set(manifest['applications'])<=APPS:
        raise ValueError('Unexpected protected application')
    age=(dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(manifest['started_utc'])).total_seconds()/3600
    if age < -0.1 or age > max_age_hours: raise ValueError('Recovery point outside allowed age')
    for name in seen:
        if name.endswith('.age'):
            run(['age','-d','-i',str(CONFIG/'identity.txt'),str(path/name)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    return manifest

def mirror():
    config=guard(); CACHE.mkdir(parents=True,exist_ok=True,mode=0o700)
    base=['rclone','--config',str(CONFIG/'rclone.conf')]
    directories=json.loads(run(base+['lsjson',config['remote'],'--dirs-only'],capture_output=True).stdout)
    candidates=sorted([x['Name'] for x in directories if STAMP.fullmatch(x['Name'])],reverse=True)
    # Preserve independent latest priority and full sets; never replace a good set
    # with a partial upload or a set with an invalid signature.
    complete=False; priority=False
    for stamp in candidates:
        final=CACHE/stamp
        try:
            if not final.exists():
                if shutil.disk_usage(CACHE).free < 8*1024**3: raise ValueError('Home disk reserve below 8 GiB')
                temp=CACHE/('.'+stamp+'.incomplete')
                if temp.exists(): shutil.rmtree(temp)
                temp.mkdir(mode=0o700)
                run(base+['copy',config['remote']+'/'+stamp,str(temp),'--transfers','2','--max-transfer','2G','--cutoff-mode','cautious','--retries','1','--low-level-retries','1'],timeout=600,capture_output=True)
                # Verification uses the signed timestamp, so rename only within
                # a private staging parent before validation.
                staging=CACHE/('.stage-'+stamp); staging.mkdir(mode=0o700,exist_ok=True)
                candidate=staging/stamp; temp.rename(candidate)
                try:
                    verify(candidate)
                    candidate.rename(final)
                finally: shutil.rmtree(staging)
            manifest=verify(final)
            apps=set(manifest['applications'])
            complete=complete or set(config['protected'])<=apps
            priority=priority or set(config['priority'])<=apps
            marker={'snapshot':stamp,'verified_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'applications':sorted(apps)}
            (final/'.verified.json').write_text(json.dumps(marker)+'\n')
            if complete and priority: break
        except (ValueError,subprocess.CalledProcessError,FileNotFoundError,KeyError) as error:
            if isinstance(error,subprocess.CalledProcessError) and b'download_cap_exceeded' in (error.stderr or b''):
                raise ValueError('Backblaze download cap reached; cached sets retained, download attempts stopped') from error
            print('Rejected recovery set '+stamp+': '+type(error).__name__,flush=True)
    if not priority: raise ValueError('No fresh verified priority recovery set')
    for old in retention_plan(CACHE,limit_bytes=6*1024**3): shutil.rmtree(old)
    print(json.dumps({'priority_available':priority,'full_available':complete}))

def extract_files(snapshot, app, claim, destination):
    guard(); manifest=verify(CACHE/snapshot)
    if claim not in [x['claim'] for x in manifest['applications'][app]['files']]: raise ValueError('Unknown application claim')
    destination=Path(destination).resolve()
    storage=Path('/var/lib/rancher/k3s/storage').resolve()
    if not destination.is_relative_to(storage) or destination==storage or not destination.is_dir() or any(destination.iterdir()):
        raise ValueError('Restore requires an empty recovery storage directory')
    # Refuse all live application writers before touching storage.
    pods=json.loads(run(['k3s','kubectl','-n',app,'get','pods','-o','json'],capture_output=True).stdout)['items']
    if any(p.get('status',{}).get('phase') not in ['Succeeded','Failed'] and p['metadata'].get('labels',{}).get('homelab.dev/restore-helper')!='true' for p in pods):
        raise ValueError('Stop application writers before restore')
    pv=json.loads(run(['k3s','kubectl','get','pv','-o','json'],capture_output=True).stdout)['items']
    if not any(p['spec'].get('claimRef',{}).get('namespace')==app and p['spec'].get('claimRef',{}).get('name')==claim and p['spec'].get('hostPath',p['spec'].get('local',{})).get('path')==str(destination) for p in pv):
        raise ValueError('Destination does not belong to this recovery claim')
    Path('/run/homelab-dr').mkdir(mode=0o700,exist_ok=True)
    with tempfile.TemporaryDirectory(dir='/run/homelab-dr') as plain:
        archive=Path(plain)/'files.tar.gz'
        with archive.open('wb') as output:
            run(['age','-d','-i',str(CONFIG/'identity.txt'),str(CACHE/snapshot/app/(claim+'.tar.gz.age'))],stdout=output,stderr=subprocess.PIPE)
        with tarfile.open(archive) as tar:
            members=tar.getmembers()
            for member in members:
                target=(destination/member.name).resolve()
                if not target.is_relative_to(destination) or not (member.isfile() or member.isdir()): raise ValueError('Unsafe archive member; links require manual review')
            tar.extractall(destination,members=members, numeric_owner=True,filter='fully_trusted')
    print(json.dumps({'restored':claim,'snapshot':snapshot}))

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(); commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('mirror')
    p=commands.add_parser('verify');p.add_argument('snapshot');p.add_argument('--max-age-hours',type=float,default=24)
    p=commands.add_parser('verify-home');p.add_argument('snapshot')
    p=commands.add_parser('restore-files');p.add_argument('snapshot');p.add_argument('app');p.add_argument('claim');p.add_argument('destination')
    args=parser.parse_args()
    if args.command=='mirror': mirror()
    elif args.command=='verify': guard();print(json.dumps(verify(CACHE/args.snapshot,args.max_age_hours)))
    elif args.command=='verify-home': guard();print(json.dumps(verify(Path('/var/lib/homelab-dr/home-writes')/args.snapshot,expected_site='ackermann-dr')))
    else: extract_files(args.snapshot,args.app,args.claim,args.destination)
if __name__=='__main__': main()
