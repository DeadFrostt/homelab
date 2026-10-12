#!/usr/bin/env python3
"""Regression checks: pre-download pruning and no redundant subset backfill."""
import importlib.util,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('recovery',pathlib.Path(__file__).parent/'recovery/recovery.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class MirrorRetention(unittest.TestCase):
 def test_skip_older_subsets_and_prune_first(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);cache=root/'cache';cache.mkdir();config=root/'config';config.mkdir()
   old=cache/'20261005T000000Z';old.mkdir();(old/'sentinel').touch()
   stamps=['20261006T120000Z','20261006T113000Z','20261006T110000Z']
   copies=[];hints=[];plans=[]
   def plan(*args,**kwargs):
    self.assertTrue(kwargs['verified_only']);plans.append(True)
    return [old] if old.exists() else []
   def run(args,**kwargs):
    if 'lsjson' in args:return subprocess.CompletedProcess(args,0,stdout=json.dumps([{'Name':s} for s in stamps]).encode())
    if 'cat' in args:
     stamp=args[-1].split('/')[-2];hints.append(stamp)
     apps=['gatus'] if stamp==stamps[1] else ['gatus','vaultwarden']
     return subprocess.CompletedProcess(args,0,stdout=json.dumps({'applications':dict.fromkeys(apps,{})}).encode())
    if 'copy' in args:
     self.assertFalse(old.exists(),'History must be pruned before first download')
     stamp=args[args.index('copy')+1].split('/')[-1];copies.append(stamp)
     return subprocess.CompletedProcess(args,0)
    self.fail('Unexpected operation')
   def verify(path,*args,**kwargs):
    return {'applications':{'gatus':{}} if path.name==stamps[0] else {'gatus':{},'vaultwarden':{}}}
   with patch.object(r,'CONFIG',config),patch.object(r,'CACHE',cache),patch.object(r,'guard',return_value={'remote':'b2:bucket/prefix','priority':['gatus'],'protected':['gatus','vaultwarden']}),patch.object(r,'retention_plan',side_effect=plan),patch.object(r,'verify',side_effect=verify),patch.object(r,'run',side_effect=run):r.mirror()
   self.assertEqual(copies,[stamps[0],stamps[2]])
   self.assertEqual(hints,[stamps[1],stamps[2]])
   self.assertEqual(len(plans),2)
   self.assertTrue((cache/stamps[0]/'.verified.json').exists())

if __name__=='__main__':unittest.main()
