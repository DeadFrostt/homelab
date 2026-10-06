#!/usr/bin/env python3
"""Private backup freshness endpoint; does not claim public failover readiness."""
import datetime as dt,json,shutil
from http.server import BaseHTTPRequestHandler,HTTPServer
from recovery import CACHE,CONFIG
def status():
    config=json.loads((CONFIG/'recovery.json').read_text());now=dt.datetime.now(dt.timezone.utc);ages={};last_check=None
    for marker in CACHE.glob('*/.verified.json'):
        verified=json.loads(marker.read_text());manifest=json.loads(marker.with_name('manifest.json').read_text())
        checked=dt.datetime.fromisoformat(verified['verified_utc']);last_check=max(last_check or checked,checked)
        for app,info in manifest['applications'].items():
            age=max(0,(now-dt.datetime.fromisoformat(info['recovery_point_utc'])).total_seconds())
            ages[app]=min(ages.get(app,float('inf')),age)
    check_age=(now-last_check).total_seconds() if last_check else None
    free=shutil.disk_usage(CACHE).free
    ready=all(ages.get(app,float('inf'))<=3900 for app in config['priority']) and check_age is not None and check_age<=1800 and free>=8*1024**3
    return {'backup_ready':ready,'promotion_ready':False,'automatic_promotion':False,'age_seconds':{a:round(v) for a,v in ages.items()},'mirror_check_age_seconds':round(check_age) if check_age is not None else None,'free_bytes':free}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path!='/health':self.send_error(404);return
        try:body=status();code=200 if body['backup_ready'] else 503
        except Exception:body={'backup_ready':False,'promotion_ready':False};code=503
        payload=json.dumps(body).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    def log_message(self,*args):pass
if __name__=='__main__':HTTPServer(('0.0.0.0',9387),Handler).serve_forever()
