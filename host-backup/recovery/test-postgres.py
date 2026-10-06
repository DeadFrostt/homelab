#!/usr/bin/env python3
"""Restore portable dumps on AMD64 into disposable, network-isolated databases."""
import json, subprocess, sys, time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from recovery import guard, verify, CACHE, CONFIG, run

def kube(*args,**kw): return run(['k3s','kubectl',*args],**kw)

def main(snapshot):
    guard(); manifest=verify(CACHE/snapshot)
    ns='dr-database-tests'; results=[]
    kube('apply','-f','-',input=json.dumps({'apiVersion':'v1','kind':'Namespace','metadata':{'name':ns}}).encode(),capture_output=True)
    policy={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'deny-all','namespace':ns},'spec':{'podSelector':{},'policyTypes':['Ingress','Egress']}}
    kube('apply','-f','-',input=json.dumps(policy).encode(),capture_output=True)
    try:
        for app,info in manifest['applications'].items():
            if not info.get('databases'): continue
            name='restore-'+app
            pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':ns},'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'nodeSelector':{'homelab.dev/site':'home-recovery'},'securityContext':{'runAsUser':26,'runAsGroup':26,'fsGroup':26},'containers':[{'name':'postgres','image':info['postgres_image'],'command':['bash','-c','initdb -D /scratch/pg -U postgres --auth=trust >/dev/null && exec postgres -D /scratch/pg -k /scratch -c listen_addresses=127.0.0.1'],'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'1','memory':'1Gi'}},'securityContext':{'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'data','mountPath':'/scratch'}]}],'volumes':[{'name':'data','emptyDir':{'sizeLimit':'1Gi'}}]}}
            kube('apply','-f','-',input=json.dumps(pod).encode(),capture_output=True)
            kube('-n',ns,'wait','--for=condition=Ready','pod/'+name,'--timeout=180s',capture_output=True)
            def pg(*args,**kw): return kube('-n',ns,'exec','-i',name,'--',*args,**kw)
            for attempt in range(60):
                try: pg('pg_isready','-h','/scratch',capture_output=True);break
                except subprocess.CalledProcessError: time.sleep(1)
            globals_sql=run(['age','-d','-i',str(CONFIG/'identity.txt'),str(CACHE/snapshot/app/'globals.sql.age')],capture_output=True).stdout.decode()
            # The disposable bootstrap superuser already exists. Preserve all
            # other roles and their original database ownership/passwords.
            globals_sql='\n'.join(line for line in globals_sql.splitlines() if not line.startswith(('CREATE ROLE postgres;','ALTER ROLE postgres ')))
            pg('psql','-h','/scratch','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',input=globals_sql.encode(),capture_output=True)
            for db in info['databases']:
                if db!='postgres': pg('createdb','-h','/scratch','-U','postgres',db,capture_output=True)
                encrypted=CACHE/snapshot/app/(db+'.dump.age')
                # Stream plaintext directly between age and pg_restore.
                producer=subprocess.Popen(['age','-d','-i',str(CONFIG/'identity.txt'),str(encrypted)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    restored=subprocess.run(['k3s','kubectl','-n',ns,'exec','-i',name,'--','pg_restore','-h','/scratch','-U','postgres','-d',db,'--exit-on-error'],stdin=producer.stdout,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    producer.stdout.close(); producer.wait(timeout=120)
                    if producer.returncode or restored.returncode: raise RuntimeError('Database restore failed for '+app+'/'+db)
                finally:
                    if producer.poll() is None: producer.kill();producer.wait()
                tables=pg('psql','-h','/scratch','-U','postgres','-d',db,'-Atc',"SELECT count(*) FROM pg_class WHERE relkind='r' AND relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema'));",capture_output=True).stdout.decode().strip()
                results.append({'app':app,'database':db,'tables':int(tables),'restored':True})
            kube('-n',ns,'delete','pod',name,'--wait=true',capture_output=True)
        report={'snapshot':snapshot,'architecture':'amd64','databases':results,'completed_utc':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
        Path('/var/lib/homelab-dr/postgres-drill.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    finally:
        kube('delete','namespace',ns,'--wait=false',capture_output=True)

if __name__=='__main__': main(sys.argv[1])
