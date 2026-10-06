#!/usr/bin/env python3
"""Synthetic password/MFA login through restored Authentik handlers in the home pod.

Runs Django's request client through the existing flow, without a public route.
A browser TLS/SSO redirect test remains separate. No real user's password is used.
"""
import json,subprocess
from recovery import guard
PROBE = r"""
import json,secrets,uuid
from django.test import Client
from django.urls import reverse
from authentik.core.models import User
from authentik.flows.models import Flow
from authentik.stages.authenticator_totp.models import TOTPDevice
from authentik.stages.authenticator.oath import TOTP
username='dr-probe-'+uuid.uuid4().hex
password=secrets.token_urlsafe(40)
user=User.objects.create(username=username,name='Isolated recovery login check',is_active=True)
try:
 user.set_password(password);user.save()
 device=TOTPDevice.objects.create(user=user,name="DR synthetic TOTP",confirmed=True)
 flow=Flow.objects.get(slug='default-authentication-flow')
 url=reverse('authentik_api:flow-executor',kwargs={'flow_slug':flow.slug})
 client=Client(HTTP_HOST='sso.pleasedontdmca.me')
 response=client.get(url,secure=True);assert response.status_code==200
 challenges=[]
 for attempt in range(8):
  challenge=response.json();component=challenge.get('component');challenges.append(component)
  if component=='ak-stage-identification':body={'uid_field':username}
  elif component=='ak-stage-password':body={'password':password}
  elif component=='ak-stage-identification-password':body={'uid_field':username,'password':password}
  elif component=='ak-stage-authenticator-validate':body={'code':str(TOTP(device.bin_key,device.step,device.t0,device.digits,device.drift).token()).zfill(device.digits)}
  elif component=='xak-flow-redirect':break
  else:raise ValueError('Unsupported challenge '+str(component))
  if component in ('ak-stage-password','ak-stage-authenticator-validate'):
   bad={'password':secrets.token_urlsafe(40)} if component=='ak-stage-password' else {'code':'invalid-dr-code'}
   rejected=client.post(url,bad,content_type='application/json',secure=True)
   assert rejected.status_code==200 and rejected.json().get('component')==component
   assert rejected.json().get('response_errors'),'Invalid credential was not refused'
  response=client.post(url,body,content_type='application/json',secure=True)
  assert response.status_code in (200,302,303)
  if response.status_code!=200:response=client.get(url,secure=True)
 response=client.get('/api/v3/core/users/me/',secure=True);assert response.status_code==200
 assert response.json()['user']['username']==username
 print('DR_RESULT '+json.dumps({'application':'authentik','synthetic_password_login':True,'synthetic_totp_validated':True,'wrong_password_and_otp_refused':True,'authenticated_identity':True,'restored_flow_challenges':challenges}))
finally:user.delete()
"""
def main():
    guard()
    result=subprocess.run(['k3s','kubectl','-n','authentik','exec','-i','deployment/authentik-server','--','env','AUTHENTIK_LOG_LEVEL=error','ak','shell'],input=PROBE,text=True,capture_output=True,timeout=120)
    if result.returncode:raise ValueError('Auth recovery login check failed; inspect private pod logs')
    lines=[line.removeprefix('DR_RESULT ') for line in result.stdout.splitlines() if line.startswith('DR_RESULT ')]
    if len(lines)!=1:raise ValueError('Auth recovery check did not produce exactly one result')
    report=json.loads(lines[0]);report['synthetic_user_and_device_removed']=True
    print(json.dumps(report))
if __name__=='__main__':main()
