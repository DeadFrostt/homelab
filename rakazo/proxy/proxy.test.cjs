const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowed, target } = require('./proxy.cjs');
test('tailnet and public destinations work, including known MagicDNS', async () => {
  assert.equal(await target('yeager', 3015), '100.105.150.16');
  assert.equal(await target('yeager.angelfish-ruler.ts.net', 22), '100.105.150.16');
  assert.equal(allowed('100.112.158.118', 443), true);
  assert.equal(allowed('1.1.1.1', 443), true);
});
test('proxy cannot bypass Docker restrictions or expose the cluster API', async () => {
  for (const ip of ['127.0.0.1','10.43.0.1','172.17.0.1','192.168.4.34','169.254.169.254','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1']) {
    assert.equal(allowed(ip, 443), false, ip);
    await assert.rejects(target(ip,443));
  }
  assert.equal(allowed('100.105.150.16',6443),false);
  await assert.rejects(target('yeager',6443));
});
