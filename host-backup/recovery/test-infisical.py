#!/usr/bin/env python3
"""Private restored-secret login/decryption check; credentials arrive on stdin."""
import base64,json,subprocess,sys,urllib.request,urllib.parse
from recovery import guard
def kube(*args):return json.loads(subprocess.check_output(['k3s','kubectl',*args,'-o','json']))
def main():
    guard()
    bootstrap=json.load(sys.stdin)['data']
    credentials={key:base64.b64decode(bootstrap[key]).decode() for key in ['clientId','clientSecret']}
    service=kube('-n','infisical','get','service','infisical')
    base='http://'+service['spec']['clusterIP']+':'+str(service['spec']['ports'][0]['port'])
    request=urllib.request.Request(base+'/api/v1/auth/universal-auth/login',data=json.dumps(credentials).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=20) as response:token=json.load(response)['accessToken']
    expected=base64.b64decode(kube('-n','vaultwarden','get','secret','vaultwarden-env')['data']['SMTP_PASSWORD']).decode()
    query=urllib.parse.urlencode({'projectId':'da3c1cc5-d234-4a20-8d69-bad0236654ba','environment':'prod','secretPath':'/'})
    request=urllib.request.Request(base+'/api/v4/secrets/SMTP_PASSWORD?'+query,headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(request,timeout=20) as response:actual=json.load(response)['secret']['secretValue']
    if actual!=expected:raise ValueError('Restored secret differs from the encrypted bootstrap copy')
    print(json.dumps({'application':'infisical','machine_login':True,'secret_decryption':True,'matches_recovered_application_secret':True}))
if __name__=='__main__':main()
