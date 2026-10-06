#!/usr/bin/env python3
"""Create/read/delete a synthetic notes database only in the isolated home cluster."""
import base64,json,subprocess,urllib.request,urllib.parse
from recovery import guard
def kube(*args):return json.loads(subprocess.check_output(['k3s','kubectl',*args,'-o','json']))
def main():
    guard();app='couch-db'
    deployment=kube('-n',app,'get','deployment','obsidian-livesync')
    container=deployment['spec']['template']['spec']['containers'][0];env={}
    for item in container.get('env',[]):
        if 'value' in item:env[item['name']]=item['value']
        elif 'secretKeyRef' in item.get('valueFrom',{}):
            ref=item['valueFrom']['secretKeyRef'];secret=kube('-n',app,'get','secret',ref['name'])
            env[item['name']]=base64.b64decode(secret['data'][ref['key']]).decode()
    for item in container.get('envFrom',[]):
        if 'secretRef' in item:
            secret=kube('-n',app,'get','secret',item['secretRef']['name'])
            env.update({key:base64.b64decode(value).decode() for key,value in secret['data'].items()})
    user,password=env['COUCHDB_USER'],env['COUCHDB_PASSWORD']
    service=kube('-n',app,'get','service','obsidian-livesync')
    base='http://'+service['spec']['clusterIP']+':'+str(service['spec']['ports'][0]['port'])
    auth='Basic '+base64.b64encode((user+':'+password).encode()).decode()
    def request(method,path,body=None):
        req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else (b'' if method=='PUT' else None),method=method,headers={'Authorization':auth,'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
    existing=[name for name in request('GET','/_all_dbs') if not name.startswith('_')]
    existing_rows=0
    for name in existing:
        listing=request('GET','/'+urllib.parse.quote(name,safe='')+'/_all_docs?limit=1')
        existing_rows+=listing['total_rows']
    # Fail on a collision rather than deleting any pre-existing database.
    created=request('PUT','/dr_recovery_probe');assert created['ok']
    try:
        written=request('PUT','/dr_recovery_probe/check',{'purpose':'isolated-recovery-write-check'})
        assert written['ok']
        document=request('GET','/dr_recovery_probe/check')
        assert document['purpose']=='isolated-recovery-write-check'
    finally:assert request('DELETE','/dr_recovery_probe')['ok']
    print(json.dumps({'application':app,'existing_databases_read':len(existing),'existing_documents':existing_rows,'authenticated_write':True,'read_back':True,'synthetic_database_removed':True}))
if __name__=='__main__':main()
