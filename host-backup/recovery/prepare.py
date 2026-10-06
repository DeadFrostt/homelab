#!/usr/bin/env python3
"""Prepare stopped application definitions and isolated namespaces for a drill."""
import base64,json,sys
from pathlib import Path
from recovery import guard,verify,run,CACHE,CONFIG

def kube(*args,**kw): return run(['k3s','kubectl',*args],**kw)
def apply(objects):
    kube('apply','-f','-',input=json.dumps({'apiVersion':'v1','kind':'List','items':objects}).encode(),capture_output=True)
def unseal(path): return json.loads(run(['age','-d','-i',str(CONFIG/'identity.txt'),str(path)],capture_output=True).stdout)

def main(snapshot):
    guard();manifest=verify(CACHE/snapshot);apps=set(manifest['applications'])-{'gatus'}
    namespaces=[];policies=[]
    for app in sorted(apps):
        namespaces.append({'apiVersion':'v1','kind':'Namespace','metadata':{'name':app,'labels':{'homelab.dev/site':'home-recovery'}}})
        policies.append({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'isolated-drill','namespace':app},'spec':{'podSelector':{},'policyTypes':['Ingress','Egress'],'ingress':[{'from':[{'namespaceSelector':{'matchLabels':{'homelab.dev/site':'home-recovery'}}}]}],'egress':[{'to':[{'namespaceSelector':{'matchLabels':{'homelab.dev/site':'home-recovery'}}}]},{'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}}}],'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]}]}})
    apply(namespaces);apply(policies)
    secrets=[x for x in unseal(CACHE/snapshot/'bootstrap-secrets.json.age')['items'] if x['metadata']['namespace'] in apps and not x['metadata']['name'].endswith('-superuser')]
    apply(secrets)
    objects=[]
    for obj in unseal(CACHE/snapshot/'resources.json.age')['items']:
        if obj['metadata']['namespace'] not in apps or obj['kind']=='CronJob':continue
        if obj['metadata']['name'].startswith(obj['metadata']['namespace']+'-pg-'):continue
        if obj['kind']=='Service':
            obj['spec']['type']='ClusterIP';obj['spec'].pop('externalTrafficPolicy',None)
            for p in obj['spec']['ports']:p.pop('nodePort',None)
        if obj['kind']=='StatefulSet':
            for claim in obj['spec'].get('volumeClaimTemplates',[]):
                claim.pop('status',None);claim['metadata']={'name':claim['metadata']['name']};claim['spec']['storageClassName']='local-path';claim['spec'].pop('volumeName',None)
        objects.append(obj)
    apply(objects)
    # Ordinary controllers remain stopped; no tunnel or worker activation.
    print(json.dumps({'prepared':sorted(apps),'replicas':0,'external_egress':False}))

if __name__=='__main__':main(sys.argv[1])
