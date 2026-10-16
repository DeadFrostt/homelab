import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollAction, pollAccount } from './poll-gmail.mjs';

test('history comparisons retain precision and never notify for unchanged or older positions', () => {
  assert.equal(pollAction('99999999999999999999', '99999999999999999998'), 'notify');
  assert.equal(pollAction('123', '123'), 'unchanged');
  assert.equal(pollAction('122', '123'), 'unchanged');
  assert.throws(() => pollAction('unexpected', '123'));
});
test('first activation establishes a baseline without replaying old emails', async () => {
  const writes = [];
  let notifications = 0;
  const result = await pollAccount({ account: { id: 'account', lastSyncedHistoryId: null }, current: '123',
    initialize: async (...args) => writes.push(args), notify: async () => notifications++ });
  assert.deepEqual(writes, [['account', '123']]);
  assert.equal(notifications, 0);
  assert.equal(result.action, 'initialize');
});
test('new history triggers the existing notification pipeline without advancing its processing cursor', async () => {
  let initialized = false;
  const notifications = [];
  await pollAccount({ account: { id: 'account', lastSyncedHistoryId: '123' }, current: '124',
    initialize: async () => { initialized = true; }, notify: async (account, history) => notifications.push([account.id, history]) });
  assert.equal(initialized, false);
  assert.deepEqual(notifications, [['account', '124']]);
});
test('a failed notification remains retryable and cannot advance the cursor', async () => {
  let initialized = false;
  await assert.rejects(pollAccount({ account: { id: 'account', lastSyncedHistoryId: '123' }, current: '124',
    initialize: async () => { initialized = true; }, notify: async () => { throw Error('unavailable'); } }), /unavailable/);
  assert.equal(initialized, false);
});

test('read-only checks never initialize a cursor or invoke mailbox automation', async () => {
  for (const last of [null, '123']) {
    const result = await pollAccount({ account: { id: 'account', lastSyncedHistoryId: last }, current: '124', checkOnly: true,
      initialize: async () => assert.fail('must not write'), notify: async () => assert.fail('must not invoke webhook') });
    assert.equal(result.notified, false);
  }
});

test('polling waits through an app restart and requires database-backed readiness', async () => {
  const { waitForAppReady } = await import('./poll-gmail.mjs');
  let clock = 0, calls = 0;
  await waitForAppReady({ env: { HEALTH_API_KEY: 'test-only-key' }, now: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers['x-health-api-key'], 'test-only-key');
      calls++;
      return new Response(JSON.stringify({ database: { status: calls === 3 ? 'healthy' : 'unhealthy' } }), { status: calls === 1 ? 503 : 200 });
    } });
  assert.equal(calls, 3);
  assert.equal(clock, 6000);
});
