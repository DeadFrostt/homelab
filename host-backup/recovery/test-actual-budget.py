#!/usr/bin/env python3
"""Check restored sessions and sync storage only in the guarded recovery cluster.

Does not establish an OIDC login or decrypt an end-to-end encrypted budget.
Creates only a synthetic sync file, then tombstones it through the normal API.
"""
import io,json,pathlib,sqlite3,subprocess,time,urllib.request,uuid,zipfile
from recovery import guard

def kube(*args):return json.loads(subprocess.check_output(['k3s','kubectl',*args,'-o','json']))
def main():
    guard();app='actual-budget'
    pvs=kube('get','pv')['items']
    pv=next(p for p in pvs if p['spec'].get('claimRef',{}).get('namespace')==app and p['spec']['claimRef']['name']=='actual-budget-data')
    root=pathlib.Path(pv['spec'].get('hostPath',pv['spec'].get('local',{}))['path']).resolve()
    assert root.is_relative_to('/var/lib/rancher/k3s/storage')
    with sqlite3.connect('file:'+str(root/'server-files/account.sqlite')+'?mode=ro',uri=True) as db:
        row=db.execute('SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.enabled=1 AND (s.expires_at=-1 OR s.expires_at>?) ORDER BY s.expires_at DESC LIMIT 1',(time.time(),)).fetchone()
    if not row:raise ValueError('No valid restored session; end-user login required')
    service=kube('-n',app,'get','service','actual-budget');base='http://'+service['spec']['clusterIP']+':'+str(service['spec']['ports'][0]['port'])
    def request(method,path,body=None,headers=None):
        req=urllib.request.Request(base+path,data=body,method=method,headers={'X-ACTUAL-TOKEN':row[0],**(headers or {})})
        with urllib.request.urlopen(req,timeout=20) as response:return response.read()
    def js(method,path,body=None):
        result=json.loads(request(method,path,json.dumps(body).encode() if body is not None else None,{'Content-Type':'application/json'}));assert result['status']=='ok';return result
    js('GET','/account/validate');files=js('GET','/sync/list-user-files')['data'];existing=[f for f in files if not f['deleted']]
    for f in existing:
        assert str(uuid.UUID(f['fileId']))==f['fileId'],'Invalid restored file ID'
        data=request('GET','/sync/download-user-file',headers={'X-ACTUAL-FILE-ID':f['fileId']})
        assert data==(root/'user-files'/('file-'+f['fileId']+'.blob')).read_bytes(),'Restored sync file differs from downloaded bytes'
    file_id=str(uuid.uuid4());assert all(f['fileId']!=file_id for f in files)
    def payload(value):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE dr_probe (value INTEGER)');db.execute('INSERT INTO dr_probe VALUES (?)',(value,));data=db.serialize()
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('db.sqlite',data);archive.writestr('metadata.json',json.dumps({'id':file_id,'name':'DR synthetic sync check'}))
        return buf.getvalue()
    created=False;group=None
    try:
        for version in (1,2):
            data=payload(version);headers={'Content-Type':'application/encrypted-file','X-ACTUAL-NAME':'DR%20synthetic%20sync%20check','X-ACTUAL-FILE-ID':file_id,'X-ACTUAL-FORMAT':'2'}
            if group:headers['X-ACTUAL-GROUP-ID']=group
            result=json.loads(request('POST','/sync/upload-user-file',data,headers));assert result['status']=='ok';created=True;group=result['groupId']
            assert request('GET','/sync/download-user-file',headers={'X-ACTUAL-FILE-ID':file_id})==data
    finally:
        if created:
            js('POST','/sync/delete-user-file',{'fileId':file_id})
            remaining=[f for f in js('GET','/sync/list-user-files')['data'] if f['fileId']==file_id]
            assert not remaining or remaining[0]['deleted']==1
    print(json.dumps({'application':app,'restored_session_validated':True,'existing_sync_files_read':len(existing),'synthetic_sync_create_update_read':True,'synthetic_sync_tombstoned':True,'oidc_login_tested':False,'budget_decryption_tested':False}))
if __name__=='__main__':main()
