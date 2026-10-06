#!/usr/bin/env python3
"""Build new home CNPG clusters and restore portable logical backups once."""
import base64,json,subprocess,sys
from pathlib import Path
from recovery import guard,verify,CACHE,CONFIG,run
from prepare import apply
def kube(*args,**kw):return run(['k3s','kubectl',*args],**kw)
def main(snapshot):
    guard();manifest=verify(CACHE/snapshot)
    for app,info in manifest['applications'].items():
        if not info['databases']:continue
        cluster=app+'-pg'
        # Never overwrite an existing database; resume requires human inspection.
        found=kube('-n',app,'get','clusters.postgresql.cnpg.io','-o','json',capture_output=True)
        if json.loads(found.stdout)['items']:raise ValueError('Database cluster already exists in '+app)
        secret=json.loads(kube('-n',app,'get','secret',cluster+'-app','-o','json',capture_output=True).stdout)
        owner=base64.b64decode(secret['data']['username']).decode()
        database=owner if owner in info['databases'] else 'app'
        policy={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'recovery-api','namespace':app},'spec':{'podSelector':{'matchLabels':{'cnpg.io/cluster':cluster}},'policyTypes':['Egress'],'egress':[{'to':[{'ipBlock':{'cidr':'10.67.46.10/32'}}],'ports':[{'protocol':'TCP','port':6443}]},{'to':[{'ipBlock':{'cidr':'10.53.0.1/32'}}],'ports':[{'protocol':'TCP','port':443}]}]}}
        obj={'apiVersion':'postgresql.cnpg.io/v1','kind':'Cluster','metadata':{'name':cluster,'namespace':app,'labels':{'homelab.dev/site':'home-recovery'}},'spec':{'instances':1,'imageName':info['postgres_image'],'bootstrap':{'initdb':{'database':database,'owner':owner,'secret':{'name':cluster+'-app'}}},'storage':{'size':'5Gi','storageClass':'local-path'},'resources':{'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'500m','memory':'768Mi'}},'affinity':{'nodeSelector':{'homelab.dev/site':'home-recovery'}},'enableSuperuserAccess':False}}
        apply([policy,obj])
        kube('-n',app,'wait','--for=condition=Ready','cluster/'+cluster,'--timeout=180s',capture_output=True)
        obj=json.loads(kube('-n',app,'get','cluster',cluster,'-o','json',capture_output=True).stdout);pod=obj['status']['currentPrimary']
        def pg(*args,**kw):return kube('-n',app,'exec','-i',pod,'-c','postgres','--',*args,**kw)
        existing=set(pg('psql','-U','postgres','-d','postgres','-Atc','SELECT rolname FROM pg_roles;',capture_output=True).stdout.decode().splitlines())
        globals_sql=run(['age','-d','-i',str(CONFIG/'identity.txt'),str(CACHE/snapshot/app/'globals.sql.age')],capture_output=True).stdout.decode()
        sql=[]
        for line in globals_sql.splitlines():
            if line.startswith('CREATE ROLE ') and line[len('CREATE ROLE '):].rstrip(';').strip('"') in existing:continue
            if line.startswith(('ALTER ROLE postgres ','ALTER ROLE streaming_replica ')):continue
            sql.append(line)
        pg('psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',input='\n'.join(sql).encode(),capture_output=True)
        for db in info['databases']:
            metadata=next((m for m in info.get('database_metadata',[]) if m['name']==db),None)
            if db not in ['postgres',database]:
                options=['createdb','-U','postgres']
                if metadata:options+=['-O',metadata['owner'],'--encoding',metadata['encoding'],'--lc-collate',metadata['collate'],'--lc-ctype',metadata['ctype'],'--template','template0']
                pg(*options,db,capture_output=True)
            producer=subprocess.Popen(['age','-d','-i',str(CONFIG/'identity.txt'),str(CACHE/snapshot/app/(db+'.dump.age'))],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                restored=subprocess.run(['k3s','kubectl','-n',app,'exec','-i',pod,'-c','postgres','--','pg_restore','-U','postgres','-d',db,'--exit-on-error'],stdin=producer.stdout,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                producer.stdout.close();producer.wait(timeout=180)
                if producer.returncode or restored.returncode:raise RuntimeError('Restore failed for '+app+'/'+db)
            finally:
                if producer.poll() is None:producer.kill();producer.wait()
            if metadata:
                quote=lambda value:'"'+value.replace('"','""')+'"'
                pg('psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c','ALTER DATABASE '+quote(db)+' OWNER TO '+quote(metadata['owner'])+';',capture_output=True)
        marker=Path('/var/lib/homelab-dr')/('restored-'+app+'.json');marker.write_text(json.dumps({'snapshot':snapshot,'cluster':cluster,'databases':info['databases']})+'\n')
        print(json.dumps({'restored':app,'databases':info['databases']}),flush=True)
if __name__=='__main__':main(sys.argv[1])
