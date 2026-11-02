"""Guard migration ordering and exact app-image parity on Renovate updates."""
import copy, pathlib, shutil, subprocess, unittest
import yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]

def validate(objects):
    byname={o['metadata']['name']:o for o in objects}
    job=byname['rakazo-migrate'];annotations=job['metadata']['annotations']
    assert annotations['argocd.argoproj.io/hook']=='Sync'
    assert set(annotations['argocd.argoproj.io/hook-delete-policy'].split(','))=={'BeforeHookCreation','HookSucceeded'}
    wave=lambda obj:int(obj['metadata'].get('annotations',{}).get('argocd.argoproj.io/sync-wave','0'))
    assert wave(byname['rakazo-postgres'])<wave(job)
    assert wave(byname['rakazo-config'])<wave(job)
    spec=job['spec'];pod=spec['template']['spec'];c=pod['containers'][0]
    assert pod['restartPolicy']=='Never' and spec['backoffLimit']<=1 and spec['activeDeadlineSeconds']<=900
    assert c['command']==['pnpm','db:migrate']
    assert {'secretRef':{'name':'rakazo-api-env'}} in c['envFrom']
    assert pod['hostNetwork'] and pod['nodeSelector']['kubernetes.io/hostname']=='ackermann'
    assert pod['automountServiceAccountToken'] is False
    for name in ['api','worker','web','supervisor']:
        app=byname['rakazo-'+name]
        assert wave(app)>wave(job),name+' bypasses migration gate'
        assert app['spec']['template']['spec']['containers'][0]['image']==c['image'],name+' image differs from migration image'

class RolloutGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        command=['kustomize','build'] if shutil.which('kustomize') else ['kubectl','kustomize']
        cls.objects=list(yaml.safe_load_all(subprocess.check_output(command+[str(ROOT/'rakazo')],text=True)))
    def test_manifest(self):validate(self.objects)
    def test_reject_drift(self):
        for mutation in ['missing','image','wave','phase']:
            objects=copy.deepcopy(self.objects);job=next(o for o in objects if o['metadata']['name']=='rakazo-migrate')
            if mutation=='missing':objects.remove(job)
            elif mutation=='image':job['spec']['template']['spec']['containers'][0]['image']='wrong-image'
            elif mutation=='wave':job['metadata']['annotations']['argocd.argoproj.io/sync-wave']='99'
            else:job['metadata']['annotations']['argocd.argoproj.io/hook']='PreSync'
            with self.subTest(mutation=mutation),self.assertRaises((AssertionError,KeyError)):validate(objects)
if __name__=='__main__':unittest.main()
