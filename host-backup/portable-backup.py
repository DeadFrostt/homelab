#!/usr/bin/env python3
"""Consistent, encrypted, portable application recovery sets; never copies PGDATA."""
import argparse, datetime as dt, fcntl, hashlib, json, os, shutil, sqlite3
import subprocess, tarfile, tempfile, time, signal
from pathlib import Path
from retention import retention_plan

APPS = ['gatus', 'vaultwarden', 'actual-budget', 'couch-db', 'zipline', 'infisical', 'authentik', 'matrix', 'mas']
DATABASES = {'authentik': 'authentik-pg', 'infisical': 'infisical-pg', 'mas': 'mas-pg', 'matrix': 'matrix-pg', 'zipline': 'zipline-pg'}
FILES = {'gatus': ['gatus-data'], 'vaultwarden': ['vaultwarden-data'], 'actual-budget': ['actual-budget-data'],
 'couch-db': ['couchdb-data', 'couchdb-config'], 'zipline': ['zipline-uploads', 'zipline-public', 'zipline-themes'],
 'authentik': ['authentik-media', 'authentik-certs', 'authentik-templates'], 'matrix': ['matrix-synapse']}
EXCLUDE_NAMES = {'icon_cache', 'tmp', 'lost+found'}

def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def run(args, **kwargs):
    env = dict(os.environ); env.pop('JOURNAL_STREAM', None)
    return subprocess.run(args, env=env, check=True, **kwargs)
def kube(*args):
    return ['kubectl', '--kubeconfig', os.environ.get('BACKUP_KUBECONFIG', '/home/ubuntu/.kube/config'), *args]
def get(*args): return json.loads(run(kube(*args, '-o', 'json'), capture_output=True).stdout)
def excluded(path):
    return any(x in EXCLUDE_NAMES for x in path.parts) or path.name.endswith('-shm') or (path.name.startswith('db_') and path.suffix == '.sqlite3')
def tree_signature(root):
    result = {}
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root)
        if excluded(rel) or (p.is_dir() and not p.is_symlink()): continue
        s = p.lstat(); result[str(rel)] = (s.st_ino, s.st_size, s.st_mtime_ns, s.st_mode)
    return result

def copy_consistent_tree(source, target, deadline_seconds=60):
    """Online SQLite snapshots + stable file inventory; fail if writers change the set."""
    source, target = Path(source), Path(target)
    before = tree_signature(source)
    target.mkdir(parents=True, exist_ok=True)
    # The plaintext parent remains mode 0700; preserve container UID/GID and
    # directory permissions inside it so non-root applications can recover.
    for directory in sorted(source.rglob('*')):
        rel=directory.relative_to(source)
        if directory.is_dir() and not directory.is_symlink() and not excluded(rel):
            dest=target/rel;dest.mkdir(parents=True,exist_ok=True)
            shutil.copystat(directory,dest)
            if os.geteuid()==0:
                st=directory.stat();os.chown(dest,st.st_uid,st.st_gid)
    shutil.copystat(source,target)
    if os.geteuid()==0:
        st=source.stat();os.chown(target,st.st_uid,st.st_gid)
    sqlite_count = 0
    deadline = time.monotonic() + deadline_seconds
    for rel in before:
        p, q = source/rel, target/rel
        if p.is_symlink():
            raise ValueError('Archive links require review; refusing a set the recovery helper cannot restore')
        if p.name.endswith('-wal'): continue
        q.parent.mkdir(parents=True, exist_ok=True)
        with p.open('rb') as f: is_sqlite = f.read(16) == b'SQLite format 3\0'
        if is_sqlite:
            with sqlite3.connect(p.as_uri()+'?mode=ro', uri=True, timeout=5) as src, sqlite3.connect(q) as dst:
                def progress(status, remaining, total):
                    if time.monotonic() > deadline: raise TimeoutError('SQLite backup time limit exceeded')
                src.backup(dst, pages=256, progress=progress, sleep=0.05)
                if dst.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise ValueError('SQLite integrity check failed')
            shutil.copystat(p, q); sqlite_count += 1
        else: shutil.copy2(p, q)
        if os.geteuid()==0:
            st=p.stat();os.chown(q,st.st_uid,st.st_gid)
    if before != tree_signature(source): raise RuntimeError('File set changed during backup; recovery point refused')
    return sqlite_count

def seal_bytes(data, dest, recipient):
    run(['age', '-r', recipient, '-o', str(dest)], input=data, capture_output=True)
def seal_command(command, dest, recipient):
    env = dict(os.environ); env.pop('JOURNAL_STREAM', None)
    with tempfile.TemporaryFile() as errors:
        producer = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, env=env)
        try:
            encrypted = subprocess.run(['age', '-r', recipient, '-o', str(dest)], stdin=producer.stdout, capture_output=True)
            producer.stdout.close()
            code = producer.wait(timeout=300)
            if code or encrypted.returncode: raise RuntimeError('Encrypted database export failed; no snapshot published')
        finally:
            if producer.poll() is None: producer.kill(); producer.wait()

def clean_object(obj):
    obj = json.loads(json.dumps(obj)); obj.pop('status', None)
    m = obj['metadata']; obj['metadata'] = {'name':m['name'], 'namespace':m.get('namespace'), 'labels':m.get('labels',{})}
    spec = obj.get('spec', {})
    if obj['kind'] in ['Deployment','StatefulSet']:
        spec['replicas'] = 0
        t = spec['template']; t['metadata'] = {'labels':t['metadata'].get('labels',{})}
        ps = t['spec']; ps.pop('nodeName',None); ps.pop('affinity',None)
        ps['nodeSelector'] = {'homelab.dev/site':'home-recovery'}
    if obj['kind']=='CronJob': spec['suspend']=True
    if obj['kind']=='PersistentVolumeClaim':
        spec.pop('volumeName', None); spec.pop('selector',None); spec['storageClassName']='local-path'
    if obj['kind']=='Service':
        for k in ['clusterIP','clusterIPs','ipFamilies','ipFamilyPolicy','healthCheckNodePort']: spec.pop(k,None)
    return obj

def create_snapshot(root, recipient, remote=None, local_only=False):
    site=os.environ.get('DR_SOURCE_SITE','yeager')
    if site not in ['yeager','ackermann-dr']: raise ValueError('Unknown backup site')
    expected_uid=os.environ.get('DR_CLUSTER_UID')
    actual_uid=get('get','namespace','kube-system')['metadata']['uid']
    if not expected_uid or actual_uid!=expected_uid: raise ValueError('Backup cluster identity mismatch')
    if shutil.disk_usage(root).free < 8*1024**3: raise RuntimeError('Source disk reserve below 8 GiB; snapshot refused')
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    work=root/('.'+stamp+'.incomplete'); final=root/stamp
    work.mkdir(mode=0o700)
    manifest={'format':1,'snapshot':stamp,'source_site':site,'started_utc':now(),'applications':{},'automatic_promotion':False}
    try:
        pvs=get('get','pv')['items']
        paths={}
        for pv in pvs:
            s=pv['spec'];c=s.get('claimRef',{});path=s.get('local',s.get('hostPath',{})).get('path')
            if c.get('namespace') in APPS and path: paths[(c['namespace'],c['name'])]=Path(path)
        secret_objects=[];definitions=[]
        for app in APPS:
            sec=get('-n',app,'get','secret')['items']
            for obj in sec:
                n=obj['metadata']['name']
                if obj.get('type')=='kubernetes.io/service-account-token' or n.endswith(('-ca','-server','-replication')) or n.startswith('sh.helm.'): continue
                secret_objects.append({'apiVersion':'v1','kind':'Secret','metadata':{'name':n,'namespace':app},'type':obj.get('type','Opaque'),'data':obj.get('data',{})})
            objects=get('-n',app,'get','deployments,statefulsets,services,persistentvolumeclaims,configmaps,cronjobs')['items']
            for obj in objects:
                if app in DATABASES and obj['metadata']['name'].startswith(DATABASES[app]+'-'): continue
                if obj['metadata']['name'] in ['cloudflared','rac-outpost','velero-discord-notifier']: continue
                if obj['kind']=='Deployment' and obj['metadata']['name']=='postgres': continue
                definitions.append(clean_object(obj))
        seal_bytes(json.dumps({'apiVersion':'v1','kind':'List','items':secret_objects}).encode(),work/'bootstrap-secrets.json.age',recipient)
        seal_bytes(json.dumps({'apiVersion':'v1','kind':'List','items':definitions}).encode(),work/'resources.json.age',recipient)
        for app in APPS:
            info={'recovery_point_utc':now(),'files':[],'databases':[]}
            appdir=work/app;appdir.mkdir()
            source_files={claim:paths[(app,claim)] for claim in FILES.get(app,[])}
            # PG snapshot and file copy must fall inside the same stable file interval.
            before={claim:tree_signature(path) for claim,path in source_files.items()}
            if app in DATABASES:
                cluster=get('-n',app,'get','clusters.postgresql.cnpg.io',DATABASES[app])
                pod=cluster['status']['currentPrimary']; info['postgres_image']=cluster['spec']['imageName']
                query="SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname;"
                names=run(kube('-n',app,'exec',pod,'-c','postgres','--','psql','-U','postgres','-d','postgres','-Atc',query),capture_output=True).stdout.decode().splitlines()
                metadata_query="SELECT json_agg(json_build_object('name',datname,'owner',pg_get_userbyid(datdba),'encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype)) FROM pg_database WHERE NOT datistemplate;"
                info['database_metadata']=json.loads(run(kube('-n',app,'exec',pod,'-c','postgres','--','psql','-U','postgres','-d','postgres','-Atc',metadata_query),capture_output=True).stdout)
                seal_command(kube('-n',app,'exec',pod,'-c','postgres','--','pg_dumpall','-U','postgres','--globals-only'),appdir/'globals.sql.age',recipient)
                for name in names:
                    if not name or '/' in name or name in ['.','..']: raise ValueError('Unsafe database name')
                    seal_command(kube('-n',app,'exec',pod,'-c','postgres','--','pg_dump','-U','postgres','-d',name,'-Fc'),appdir/(name+'.dump.age'),recipient)
                    info['databases'].append(name)
            for claim,source in source_files.items():
                with tempfile.TemporaryDirectory(prefix='dr-plain-',dir=os.environ.get('DR_PLAIN_ROOT','/run/homelab-dr-plain')) as tmp:
                    temp=Path(tmp)/'files';count=copy_consistent_tree(source,temp)
                    archive=Path(tmp)/'files.tar.gz'
                    with tarfile.open(archive,'w:gz') as t:
                        t.add(temp,arcname='.',recursive=True)
                    with archive.open('rb') as f: run(['age','-r',recipient,'-o',str(appdir/(claim+'.tar.gz.age'))],stdin=f,capture_output=True)
                    info['files'].append({'claim':claim,'sqlite_snapshots':count})
            if any(before[claim]!=tree_signature(path) for claim,path in source_files.items()):
                raise RuntimeError('Application files changed across the database recovery point; set refused')
            info['completed_utc']=now(); manifest['applications'][app]=info
        manifest['completed_utc']=now()
        (work/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        entries=[]
        for p in sorted(work.rglob('*')):
            if p.is_file():
                with p.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
                entries.append(digest+'  '+str(p.relative_to(work)))
        (work/'SHA256SUMS').write_text('\n'.join(entries)+'\n')
        signing_key=Path(os.environ.get('DR_SIGNING_KEY','/etc/homelab-dr/source-signing.key'))
        run(['openssl','pkeyutl','-sign','-inkey',str(signing_key),'-rawin','-in',str(work/'SHA256SUMS'),'-out',str(work/'SHA256SUMS.sig')],capture_output=True)
        if final.exists(): raise RuntimeError('Snapshot identifier collision')
        work.rename(final)
        if not local_only:
            if not remote: raise ValueError('Offsite destination is required')
            dest=remote.rstrip('/')+'/portable/'+site+'/'+stamp
            run(['env','-u','JOURNAL_STREAM','rclone','--config',os.environ.get('BACKUP_RCLONE_CONFIG','/home/ubuntu/.config/rclone/rclone.conf'),'copy',str(final),dest,'--transfers','2','--checkers','2'],timeout=600)
            run(['bash','-c','source "$1"; verify_remote_snapshot "$2" "$3" --config "$4"','verify',str(Path(__file__).with_name('backup-verify.sh')),str(final),dest,os.environ.get('BACKUP_RCLONE_CONFIG','/home/ubuntu/.config/rclone/rclone.conf')],timeout=1900)
            for artifact in ['SHA256SUMS','SHA256SUMS.sig']:
                downloaded=run(['rclone','--config',os.environ.get('BACKUP_RCLONE_CONFIG','/home/ubuntu/.config/rclone/rclone.conf'),'cat',dest+'/'+artifact],capture_output=True,timeout=60).stdout
                if downloaded!=(final/artifact).read_bytes(): raise ValueError('Offsite signed manifest differs; retention refused')
            marker={'snapshot':stamp,'verified_utc':now(),'remote':dest}
            m=root/'.last-verified.tmp';m.write_text(json.dumps(marker)+'\n');m.replace(root/'.last-verified.json')
            budget=int(os.environ.get('DR_CACHE_BUDGET_GIB','20'))*1024**3
            for old in retention_plan(root,limit_bytes=budget):
                # A failed remote deletion leaves the local verified history.
                run(['rclone','--config',os.environ.get('BACKUP_RCLONE_CONFIG','/home/ubuntu/.config/rclone/rclone.conf'),'purge',remote.rstrip('/')+'/portable/'+site+'/'+old.name],timeout=120)
                shutil.rmtree(old)
        print(json.dumps({'snapshot':stamp,'applications':len(manifest['applications']),'verified_offsite':not local_only}))
        return final
    finally:
        if work.exists(): shutil.rmtree(work)

def main():
    global APPS
    parser=argparse.ArgumentParser();parser.add_argument('--local-only',action='store_true');parser.add_argument('--apps',default='priority');args=parser.parse_args()
    available=set(APPS)
    APPS=APPS if args.apps=='all' else (['gatus','vaultwarden','actual-budget','couch-db','infisical','authentik'] if args.apps=='priority' else args.apps.split(','))
    if not APPS or not set(APPS)<=available: raise ValueError('Unknown protected application')
    os.umask(0o077)
    Path(os.environ.get('DR_PLAIN_ROOT','/run/homelab-dr-plain')).mkdir(parents=True,exist_ok=True,mode=0o700)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    root=Path(os.environ.get('PORTABLE_BACKUP_ROOT','/var/lib/homelab-dr/portable'));root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (root/'.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        create_snapshot(root,os.environ['AGE_RECIPIENT'],os.environ.get('RCLONE_DESTINATION'),args.local_only)
if __name__=='__main__': main()
