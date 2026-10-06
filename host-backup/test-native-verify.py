#!/usr/bin/env python3
"""Real rclone native-hash regressions, without remote payload downloads."""
import hashlib,importlib.util,json,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('portable',pathlib.Path(__file__).with_name('portable-backup.py'));portable=importlib.util.module_from_spec(spec);spec.loader.exec_module(portable)
class NativeVerification(unittest.TestCase):
 def test_content_and_failures(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);source=root/'source';remote=root/'remote';source.mkdir();remote.mkdir();config=str(root/'rclone.conf');pathlib.Path(config).touch()
   data=b'abcdefgh';(source/'data.age').write_bytes(data);(remote/'data.age').write_bytes(data)
   sums=hashlib.sha256(data).hexdigest()+'  data.age\n';(source/'SHA256SUMS').write_text(sums);(remote/'SHA256SUMS').write_text(sums)
   verify=lambda:portable.verify_uploaded_snapshot(source,str(remote),config)
   verify()
   (remote/'data.age').write_bytes(b'abcdEfgh')
   with self.assertRaises(ValueError):verify()
   (remote/'data.age').unlink()
   with self.assertRaises(ValueError):verify()
   (remote/'data.age').write_bytes(data)
   original=portable.run
   def no_hash(args,**kwargs):
    result=original(args,**kwargs)
    if 'lsjson' in args:
     self.assertNotIn('--download',args);items=json.loads(result.stdout)
     for item in items:item.pop('Hashes',None)
     result.stdout=json.dumps(items).encode()
    return result
   with patch.object(portable,'run',side_effect=no_hash):
    with self.assertRaises(ValueError):verify()
   (source/'data.age').write_bytes(b'abcdefgH')
   with self.assertRaises(subprocess.CalledProcessError):verify()
if __name__=='__main__':unittest.main()
