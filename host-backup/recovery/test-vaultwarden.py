#!/usr/bin/env python3
"""Disposable restored-data password/encrypted-cipher check; primary is guarded out."""
import base64,hashlib,hmac,json,os,pathlib,secrets,shutil,signal,sqlite3,subprocess,tarfile,tempfile,time,urllib.parse,urllib.request,uuid
from cryptography.hazmat.primitives import hashes,padding
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand
from recovery import guard
NS='dr-vault-tests'
def run(*args,**kw):return subprocess.run(['k3s','kubectl',*args],check=True,capture_output=True,**kw)
def kube(*args):return json.loads(run(*args,'-o','json').stdout)
def apply(value):run('apply','-f','-',input=json.dumps(value).encode())
def main():
    guard();os.umask(0o077)
    def interrupted(*args):raise KeyboardInterrupt('Drill interrupted')
    signal.signal(signal.SIGTERM,interrupted)
    namespaces=kube('get','ns')['items'];assert not any(n['metadata']['name']==NS for n in namespaces),'Existing drill namespace refuses overwrite'
    pv=next(p for p in kube('get','pv')['items'] if p['spec'].get('claimRef',{}).get('namespace')=='vaultwarden' and p['spec']['claimRef']['name']=='vaultwarden-data')
    root=pathlib.Path(pv['spec'].get('hostPath',pv['spec'].get('local',{}))['path']).resolve();assert root.is_relative_to('/var/lib/rancher/k3s/storage')
    image=kube('-n','vaultwarden','get','deploy','vaultwarden')['spec']['template']['spec']['containers'][0]['image'];assert '@sha256:' in image
    pathlib.Path('/run/homelab-dr').mkdir(mode=0o700,exist_ok=True)
    with tempfile.TemporaryDirectory(dir='/run/homelab-dr') as tmp:
        fixture=pathlib.Path(tmp)/'fixture';fixture.mkdir(mode=0o700)
        with sqlite3.connect('file:'+str(root/'db.sqlite3')+'?mode=ro',uri=True) as source,sqlite3.connect(fixture/'db.sqlite3') as target:
            source.backup(target,pages=256);assert target.execute('pragma integrity_check').fetchone()[0]=='ok'
            counts={t:target.execute('select count(*) from '+t).fetchone()[0] for t in ('users','ciphers')}
        for source in root.glob('rsa_key*'):
            assert source.is_file() and not source.is_symlink();shutil.copy2(source,fixture/source.name)
        archive=pathlib.Path(tmp)/'fixture.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:tar.add(fixture,arcname='.')
        apply({'apiVersion':'v1','kind':'Namespace','metadata':{'name':NS,'labels':{'homelab.dev/site':'home-recovery'}}})
        try:
            apply({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'deny-egress','namespace':NS},'spec':{'podSelector':{},'policyTypes':['Egress'],'egress':[]}})
            apply({'apiVersion':'v1','kind':'Pod','metadata':{'name':'vaultwarden','namespace':NS},'spec':{'automountServiceAccountToken':False,'restartPolicy':'Never','activeDeadlineSeconds':600,'nodeSelector':{'homelab.dev/site':'home-recovery'},'volumes':[{'name':'data','emptyDir':{'sizeLimit':'256Mi'}}],'initContainers':[{'name':'restore','image':'alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6','command':['sh','-c','while [ ! -f /data/.ready ]; do sleep 1; done'],'volumeMounts':[{'name':'data','mountPath':'/data'}],'resources':{'requests':{'cpu':'10m','memory':'16Mi'},'limits':{'cpu':'100m','memory':'64Mi'}}}],'containers':[{'name':'vaultwarden','image':image,'env':[{'name':k,'value':v} for k,v in {'ROCKET_PORT':'8080','DOMAIN':'http://localhost:8080','SIGNUPS_ALLOWED':'true','SIGNUPS_DOMAINS_WHITELIST':'dr.invalid','SIGNUPS_VERIFY':'false','INVITATIONS_ALLOWED':'false','SSO_ENABLED':'false','WEB_VAULT_ENABLED':'false','PUSH_ENABLED':'false'}.items()],'volumeMounts':[{'name':'data','mountPath':'/data'}],'resources':{'requests':{'cpu':'50m','memory':'64Mi'},'limits':{'cpu':'500m','memory':'256Mi'}},'securityContext':{'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}}}]}})
            for attempt in range(60):
                p=kube('-n',NS,'get','pod','vaultwarden')
                if any('running' in c.get('state',{}) for c in p['status'].get('initContainerStatuses',[])):break
                time.sleep(1)
            else:raise ValueError('Drill init container did not start')
            run('-n',NS,'exec','-i','vaultwarden','-c','restore','--','sh','-c','tar -xz -C /data && touch /data/.ready',input=archive.read_bytes())
            base=None
            for attempt in range(60):
                p=kube('-n',NS,'get','pod','vaultwarden')
                if p['status'].get('phase')=='Failed':raise ValueError('Drill Vaultwarden container failed')
                ip=p['status'].get('podIP')
                if ip:
                    base='http://'+ip+':8080'
                    try:
                        with urllib.request.urlopen(base+'/alive',timeout=2) as r:
                            if r.status==200:break
                    except (OSError,urllib.error.URLError):pass
                time.sleep(1)
            else:raise ValueError('Drill Vaultwarden did not become healthy')
            b64=lambda b:base64.b64encode(b).decode()
            def encrypt(data,key):
                iv=os.urandom(16);padder=padding.PKCS7(128).padder();plain=padder.update(data)+padder.finalize();enc=Cipher(algorithms.AES(key[:32]),modes.CBC(iv)).encryptor();ct=enc.update(plain)+enc.finalize();tag=hmac.new(key[32:],iv+ct,hashlib.sha256).digest();return '2.'+'|'.join(map(b64,(iv,ct,tag)))
            def decrypt(text,key):
                assert text.startswith('2.');iv,ct,tag=map(base64.b64decode,text[2:].split('|'));assert hmac.compare_digest(tag,hmac.new(key[32:],iv+ct,hashlib.sha256).digest());dec=Cipher(algorithms.AES(key[:32]),modes.CBC(iv)).decryptor();padded=dec.update(ct)+dec.finalize();unpad=padding.PKCS7(128).unpadder();return unpad.update(padded)+unpad.finalize()
            email='dr-'+uuid.uuid4().hex+'@dr.invalid';password=secrets.token_urlsafe(40).encode();master=hashlib.pbkdf2_hmac('sha256',password,email.encode(),600000);password_hash=b64(hashlib.pbkdf2_hmac('sha256',master,password,1));stretch=b''.join(HKDFExpand(algorithm=hashes.SHA256(),length=32,info=info).derive(master) for info in (b'enc',b'mac'));user_key=os.urandom(64);wrapped=encrypt(user_key,stretch);token=None
            def request(method,path,body=None,form=False):
                headers={'Content-Type':'application/x-www-form-urlencoded' if form else 'application/json','Device-Type':'14'}
                if token:headers['Authorization']='Bearer '+token
                data=urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode() if body is not None else None
                req=urllib.request.Request(base+path,data=data,method=method,headers=headers)
                with urllib.request.urlopen(req,timeout=20) as r:payload=r.read();return json.loads(payload) if payload else None
            request('POST','/identity/accounts/register',{'email':email,'name':'DR synthetic vault','masterPasswordHash':password_hash,'key':wrapped,'kdf':0,'kdfIterations':600000})
            login=request('POST','/identity/connect/token',{'grant_type':'password','username':email,'password':password_hash,'scope':'api offline_access','client_id':'web','deviceType':'14','deviceIdentifier':str(uuid.uuid4()),'deviceName':'DR synthetic client'},form=True);token=login['access_token'];assert decrypt(login['Key'],stretch)==user_key
            try:
                name=encrypt(b'DR synthetic entry',user_key);secret=secrets.token_bytes(32)
                cipher=request('POST','/api/ciphers',{'type':1,'organizationId':None,'folderId':None,'name':name,'notes':encrypt(b'Isolated recovery check',user_key),'favorite':False,'reprompt':0,'login':{'username':encrypt(b'dr-probe',user_key),'password':encrypt(secret,user_key),'uris':[]}})
                cid=cipher['id'];download=request('GET','/api/ciphers/'+cid);assert decrypt(download['login']['password'],user_key)==secret
                sync=request('GET','/api/sync');assert len(sync['ciphers'])==1 and sync['ciphers'][0]['id']==cid
                assert decrypt(sync['ciphers'][0]['name'],user_key)==b'DR synthetic entry'
                attachment_plain=secrets.token_bytes(2048);attachment_key=os.urandom(64)
                iv,ct,tag=map(base64.b64decode,encrypt(attachment_plain,attachment_key)[2:].split('|'))
                attachment_bytes=bytes([2])+iv+tag+ct
                attachment=request('POST','/api/ciphers/'+cid+'/attachment/v2',{'key':encrypt(attachment_key,user_key),'fileName':encrypt(b'dr-synthetic.bin',user_key),'fileSize':str(len(attachment_bytes))})
                boundary='dr-'+uuid.uuid4().hex
                multipart=('--'+boundary+'\r\nContent-Disposition: form-data; name="data"; filename="dr-synthetic.bin"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()+attachment_bytes+('\r\n--'+boundary+'--\r\n').encode()
                req=urllib.request.Request(base+'/api'+attachment['url'],data=multipart,method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':'multipart/form-data; boundary='+boundary,'Device-Type':'14'})
                with urllib.request.urlopen(req,timeout=20) as response:assert response.status==200
                metadata=request('GET','/api'+attachment['url']);url=urllib.parse.urlsplit(metadata['url'])
                assert url.hostname=='localhost','Unexpected attachment destination'
                with urllib.request.urlopen(base+url.path+'?'+url.query,timeout=20) as response:downloaded=response.read()
                assert downloaded==attachment_bytes and downloaded[0]==2
                restored_text='2.'+'|'.join(map(b64,(downloaded[1:17],downloaded[49:],downloaded[17:49])))
                assert decrypt(restored_text,decrypt(metadata['key'],user_key))==attachment_plain
                print(json.dumps({'application':'vaultwarden','restored_original_users':counts['users'],'restored_original_ciphers':counts['ciphers'],'synthetic_password_login':True,'wrapped_key_decryption':True,'encrypted_cipher_write_read_decrypt':True,'authenticated_sync':True,'encrypted_attachment_upload_download_decrypt':True,'owner_vault_decryption_tested':False}))
            finally:request('POST','/api/accounts/delete',{'masterPasswordHash':password_hash})
        finally:run('delete','namespace',NS,'--wait=true','--timeout=120s')
if __name__=='__main__':main()
