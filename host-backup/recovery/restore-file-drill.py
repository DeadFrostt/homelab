#!/usr/bin/env python3
"""Restore signed file sets into empty home claims with application writers stopped."""
import json,sys
from recovery import guard,verify,CACHE,run,extract_files
def kube(*args,**kw):return run(['k3s','kubectl',*args],**kw)
def main(snapshot):
    guard();manifest=verify(CACHE/snapshot);report=[]
    for app,info in manifest['applications'].items():
        if app=='gatus' or not info['files']:continue
        claims=[x['claim'] for x in info['files']]
        helper={'apiVersion':'v1','kind':'Pod','metadata':{'name':'restore-helper','namespace':app,'labels':{'homelab.dev/restore-helper':'true'}},'spec':{'restartPolicy':'Never','automountServiceAccountToken':False,'nodeSelector':{'homelab.dev/site':'home-recovery'},'containers':[{'name':'helper','image':'alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6','command':['sleep','600'],'resources':{'requests':{'cpu':'10m','memory':'16Mi'},'limits':{'cpu':'100m','memory':'64Mi'}},'securityContext':{'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'v'+str(i),'mountPath':'/data/'+str(i)} for i,_ in enumerate(claims)]}],'volumes':[{'name':'v'+str(i),'persistentVolumeClaim':{'claimName':claim}} for i,claim in enumerate(claims)]}}
        kube('apply','-f','-',input=json.dumps(helper).encode(),capture_output=True)
        try:
            kube('-n',app,'wait','--for=condition=Ready','pod/restore-helper','--timeout=90s',capture_output=True)
            pvs=json.loads(kube('get','pv','-o','json',capture_output=True).stdout)['items']
            for claim in claims:
                pv=next(p for p in pvs if p['spec'].get('claimRef',{}).get('namespace')==app and p['spec'].get('claimRef',{}).get('name')==claim)
                path=pv['spec'].get('local',pv['spec'].get('hostPath',{}))['path']
                extract_files(snapshot,app,claim,path);report.append({'app':app,'claim':claim,'restored':True})
        finally:kube('-n',app,'delete','pod','restore-helper','--wait=true',capture_output=True)
    print(json.dumps({'snapshot':snapshot,'claims':report}))
if __name__=='__main__':main(sys.argv[1])
