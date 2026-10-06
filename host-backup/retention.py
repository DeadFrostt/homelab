"""Bounded recovery history, preserving the newest point for every application."""
import datetime as dt, json, re
from pathlib import Path

def retention_plan(root, limit_bytes=20*1024**3):
    snapshots=[]
    for directory in Path(root).iterdir():
        if not directory.is_dir() or not re.fullmatch(r'20[0-9]{6}T[0-9]{6}Z',directory.name): continue
        if not (directory/'SHA256SUMS.sig').is_file(): continue
        try: manifest=json.loads((directory/'manifest.json').read_text())
        except (ValueError,FileNotFoundError): continue
        snapshots.append((directory,manifest,set(manifest['applications']),sum(x.stat().st_size for x in directory.rglob('*') if x.is_file())))
    snapshots.sort(key=lambda x:x[0].name,reverse=True)
    keep=set();protected=set();covered=set();days=set();weeks=set()
    for index,(directory,manifest,apps,size) in enumerate(snapshots):
        if apps-covered: protected.add(directory);covered|=apps
        timestamp=dt.datetime.strptime(directory.name,'%Y%m%dT%H%M%SZ')
        day=timestamp.date();week=timestamp.isocalendar()[:2]
        # Keep a full daily/weekly point preferentially; subset backups must not
        # crowd out the applications protected only by the daily job.
        full=len(apps)>=9
        if index<48: keep.add(directory)
        if full and day not in days and len(days)<14: keep.add(directory);days.add(day)
        if full and week not in weeks and len(weeks)<8: keep.add(directory);weeks.add(week)
    keep|=protected
    total=sum(size for directory,_,_,size in snapshots if directory in keep)
    for directory,_,_,size in reversed(snapshots):
        if total<=limit_bytes: break
        if directory in keep and directory not in protected: keep.remove(directory);total-=size
    if total>limit_bytes: raise ValueError('Protected recovery sets exceed cache budget; refusing pruning')
    return [directory for directory,_,_,_ in snapshots if directory not in keep]
