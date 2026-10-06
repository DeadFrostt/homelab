#!/usr/bin/env python3
import datetime as dt, importlib.util, json, os, sqlite3, tempfile, unittest
from pathlib import Path
from retention import retention_plan
from importlib.machinery import SourceFileLoader
backup=SourceFileLoader('portable',str(Path(__file__).with_name('portable-backup.py'))).load_module()

class PortableTests(unittest.TestCase):
    def test_sqlite_and_attachments(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();out=root/'out'
            with sqlite3.connect(source/'db.sqlite3') as db:
                db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE sample(value TEXT)');db.execute("INSERT INTO sample VALUES('recovery-test')");db.commit()
                (source/'attachments').mkdir();(source/'attachments'/'a').write_bytes(b'attachment')
                self.assertEqual(backup.copy_consistent_tree(source,out),1)
            with sqlite3.connect(out/'db.sqlite3') as restored:
                self.assertEqual(restored.execute('SELECT value FROM sample').fetchall(),[('recovery-test',)])
            self.assertEqual((out/'attachments'/'a').read_bytes(),b'attachment')
            self.assertEqual(out.stat().st_mode&0o777,source.stat().st_mode&0o777)
    def test_escaping_link_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();(source/'escape').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError): backup.copy_consistent_tree(source,root/'out')
    def test_retention_preserves_latest_full_and_priority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);start=dt.datetime(2026,1,1)
            for index in range(100):
                p=root/(start+dt.timedelta(hours=index)).strftime('%Y%m%dT%H%M%SZ');p.mkdir()
                apps=list('abcdefghi') if index==0 else list('abcdef')
                (p/'manifest.json').write_text(json.dumps({'applications':dict.fromkeys(apps,{})}))
                (p/'SHA256SUMS.sig').write_bytes(b'signed')
            doomed=retention_plan(root,limit_bytes=1024)
            self.assertNotIn(root/start.strftime('%Y%m%dT%H%M%SZ'),doomed)
            self.assertNotIn(root/(start+dt.timedelta(hours=99)).strftime('%Y%m%dT%H%M%SZ'),doomed)
            self.assertGreater(len(doomed),50)
    def test_directory_link_is_not_silently_omitted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();(source/'linked-directory').symlink_to('/etc',target_is_directory=True)
            with self.assertRaises(ValueError): backup.copy_consistent_tree(source,root/'out')
    def test_oversized_protected_sets_refuse_pruning(self):
        with tempfile.TemporaryDirectory() as temporary:
            p=Path(temporary)/'20260101T000000Z';p.mkdir()
            (p/'manifest.json').write_text(json.dumps({'applications':{'vaultwarden':{}}}))
            (p/'SHA256SUMS.sig').write_bytes(b'x')
            with self.assertRaises(ValueError): retention_plan(p.parent,limit_bytes=1)

if __name__=='__main__': unittest.main()
