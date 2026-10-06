#!/usr/bin/env python3
"""A capped mirror must stop after one candidate and preserve its existing cache."""
import importlib.util,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('recovery',pathlib.Path(__file__).parent/'recovery/recovery.py');recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
class CapHandling(unittest.TestCase):
 def test_no_cascade_or_cache_removal(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);config=root/'config';config.mkdir();cache=root/'cache';cache.mkdir();old=cache/'20261005T000000Z';old.mkdir();marker=old/'.verified.json';marker.write_text('last-good')
   calls=[]
   def run(args,**kw):
    if 'lsjson' in args:return subprocess.CompletedProcess(args,0,stdout=json.dumps([{'Name':'20261006T100000Z'},{'Name':'20261006T090000Z'}]).encode())
    if 'copy' in args:
     calls.append(args);self.assertEqual(args[args.index('--retries')+1],'1');self.assertTrue(kw['capture_output'])
     raise subprocess.CalledProcessError(1,args,stderr=b'403 download_cap_exceeded')
    self.fail('Unexpected operation')
   with patch.object(recovery,'CONFIG',config),patch.object(recovery,'CACHE',cache),patch.object(recovery,'guard',return_value={'remote':'b2:bucket/prefix','priority':['gatus'],'protected':['gatus']}),patch.object(recovery,'run',side_effect=run):
    with self.assertRaisesRegex(ValueError,'download cap reached'):recovery.mirror()
   self.assertEqual(len(calls),1);self.assertEqual(marker.read_text(),'last-good')
if __name__=='__main__':unittest.main()
