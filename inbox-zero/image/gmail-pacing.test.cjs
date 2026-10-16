'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { requestCost, createPacer } = require('./gmail-pacing.cjs');
const message = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/example';

test('counts Gmail read and multipart costs without pacing other services', () => {
  assert.equal(requestCost(message), 20);
  assert.equal(requestCost('https://gmail.googleapis.com/gmail/v1/users/me/threads/example'), 40);
  assert.equal(requestCost('https://gmail.googleapis.com/gmail/v1/users/me/messages'), 5);
  assert.equal(requestCost('https://gmail.googleapis.com/gmail/v1/users/me/labels'), 1);
  assert.equal(requestCost('https://api.lithosai.cloud/v1/chat/completions'), 0);
  assert.equal(requestCost('http://redis-http:80'), 0);
  const body = Array.from({ length: 25 }, (_, i) => `--batch_boundary\nContent-Type: application/http\n\nGET /gmail/v1/users/me/messages/${i}?format=full\n\n`).join('');
  assert.equal(requestCost('https://www.googleapis.com/batch/gmail/v1', { method: 'POST', body }), 500);
  assert.throws(() => requestCost('https://www.googleapis.com/batch/gmail/v1', { method: 'POST', body: 'unexpected' }));
});

test('concurrent calls reserve one shared quota timeline', async () => {
  const delays = [];
  const pace = createPacer({ now: () => 1000, sleep: async delay => { delays.push(delay); } });
  await Promise.all([pace(message), pace(message), pace(message)]);
  assert.deepEqual(delays, [0, 800, 1600]);
  await pace('https://api.lithosai.cloud/v1/chat/completions');
  assert.equal(delays.length, 3);
});

test('batch reserves the aggregate cost before following requests', async () => {
  const delays = [];
  const pace = createPacer({ now: () => 0, sleep: async delay => { delays.push(delay); } });
  const body = 'GET /gmail/v1/users/me/messages/a\nGET /gmail/v1/users/me/threads/b\n';
  await pace('https://www.googleapis.com/batch/gmail/v1', { method: 'POST', body });
  await pace(message);
  assert.deepEqual(delays, [0, 2400]);
});

test('cancelled queued requests do not reach the transport', async () => {
  const pace = createPacer();
  await pace(message);
  const controller = new AbortController();
  const queued = pace(message, { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
});


test('cancelled backlog does not reserve future quota slots', async () => {
  const delays = [];
  let held = false;
  const pace = createPacer({ now: () => 0, sleep: (delay, signal) => {
    delays.push(delay);
    if (!delay || held) return Promise.resolve();
    held = true;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }});
  await pace(message);
  const a = new AbortController(), b = new AbortController();
  const waitingA = assert.rejects(pace(message, { signal: a.signal }), { name: 'AbortError' });
  const waitingB = assert.rejects(pace(message, { signal: b.signal }), { name: 'AbortError' });
  a.abort(); b.abort();
  await Promise.all([waitingA, waitingB]);
  await pace(message);
  assert.deepEqual(delays, [0, 800, 800]);
});

const { createGmailTransport, patchAdapterSource, ADAPTER_PLAIN, ADAPTER_OLD, ADAPTER_MANAGED } = require('./gmail-pacing.cjs');
const batchUrl = 'https://www.googleapis.com/batch/gmail/v1';
const quotaResponse = (seconds = 0) => new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), {
  status: 403, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) },
});
const batchResponse = (ids, fail = false) => new Response(ids.map(id => '--response_boundary\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ' + (fail ? '403 Forbidden' : '200 OK') + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(fail ? { error: { errors: [{ reason: 'rateLimitExceeded' }] } } : { id }) + '\r\n').join('') + '--response_boundary--\r\n', { headers: { 'content-type': 'multipart/mixed; boundary="response_boundary"' } });
function batchOptions(count) {
  return { method: 'POST', headers: { 'content-type': 'multipart/mixed; boundary=batch_boundary' }, body: Array.from({ length: count }, (_, i) => '--batch_boundary\nContent-Type: application/http\n\nGET /gmail/v1/users/me/messages/' + i + '?format=full\n\n').join('') + '--batch_boundary--' };
}

test('a shared cooldown delays every subsequent Gmail request', async () => {
  let clock = 0;
  const delays = [];
  const pace = createPacer({ now: () => clock, sleep: async delay => { delays.push(delay); clock += delay; } });
  await pace(message);
  pace.cooldown(65000);
  await pace(message);
  await pace(message);
  assert.deepEqual(delays, [0, 65000, 800]);
});

test('a cooldown arriving during a pacing sleep extends that sleep', async () => {
  let clock = 0;
  const delays = [];
  const pace = createPacer({ now: () => clock, sleep: async delay => {
    delays.push(delay);
    if (delay === 800) pace.cooldown(65000);
    clock += delay;
  } });
  await pace(message);
  await pace(message);
  assert.deepEqual(delays, [0, 800, 64200]);
});

test('large read batches become batches of two and retain all results in order', async () => {
  const sizes = [];
  const costs = [];
  const transport = createGmailTransport(async (url, options) => costs.push(requestCost(url, options)), { log: () => {} });
  const result = await transport(async (url, options) => {
    const ids = [...options.body.matchAll(/messages\/(\d+)\?/g)].map(match => match[1]);
    sizes.push(ids.length);
    return batchResponse(ids);
  }, batchUrl, batchOptions(25));
  assert.deepEqual(sizes, [...Array(12).fill(2), 1]);
  assert.deepEqual(costs, [...Array(12).fill(40), 20]);
  const ids = [...(await result.text()).matchAll(/"id":"(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i));
  assert.match(result.headers.get('content-type'), /boundary=inboxzero_gmail_guard/);
});

test('403 quota errors honor Retry-After and retry GET only after the shared cooldown', async () => {
  let clock = 0, calls = 0;
  const delays = [];
  const pace = createPacer({ now: () => clock, sleep: async delay => { delays.push(delay); clock += delay; } });
  const transport = createGmailTransport(pace, { log: () => {} });
  const result = await transport(async () => ++calls === 1 ? quotaResponse(90) : new Response('{}'), message);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [0, 90000]);
});

test('quota errors inside an HTTP 200 multipart response also trigger cooldown and retry', async () => {
  let calls = 0;
  const cooldowns = [];
  const pace = async () => {};
  pace.cooldown = delay => cooldowns.push(delay);
  const transport = createGmailTransport(pace, { log: () => {} });
  const response = await transport(async () => batchResponse(['0'], ++calls === 1), batchUrl, batchOptions(1));
  assert.equal(calls, 2);
  assert.deepEqual(cooldowns, [65000]);
  assert.match(await response.text(), /"id":"0"/);
});

test('non-quota 403s and mutating requests are not automatically replayed', async () => {
  const cooldowns = [];
  const pace = async () => {};
  pace.cooldown = delay => cooldowns.push(delay);
  const transport = createGmailTransport(pace, { log: () => {} });
  let calls = 0;
  await transport(async () => { calls++; return new Response('{"error":{"errors":[{"reason":"forbidden"}]}}', { status: 403 }); }, message);
  await transport(async () => { calls++; return quotaResponse(); }, message + '/modify', { method: 'POST' });
  assert.equal(calls, 2);
  assert.deepEqual(cooldowns, [65000]);
});

test('SDK adapter patch upgrades both pristine and previous images and is idempotent', () => {
  for (const source of [ADAPTER_PLAIN, ADAPTER_OLD]) {
    assert.equal(patchAdapterSource(source), ADAPTER_MANAGED);
    assert.equal(patchAdapterSource(patchAdapterSource(source)), ADAPTER_MANAGED);
  }
});

const { requestDetails, installRequestContext } = require('./gmail-pacing.cjs');

test('thread pages stay small while preserving filters and continuation tokens', () => {
  const result = requestDetails('/api/threads?type=inbox&limit=25&after=2026-10-01&nextPageToken=keep-me', 'GET');
  const parsed = new URL(result.url, 'http://inbox-zero');
  assert.equal(parsed.searchParams.get('limit'), '5');
  assert.equal(parsed.searchParams.get('nextPageToken'), 'keep-me');
  assert.equal(parsed.searchParams.get('after'), '2026-10-01');
  assert.equal(requestDetails('/api/threads?limit=5', 'GET').url, '/api/threads?limit=5');
  assert.equal(requestDetails('/api/threads?limit=25', 'POST').url, '/api/threads?limit=25');
});

test('cheap and foreground calls overtake a queued background read', async () => {
  let clock = 0, priority = 2, release;
  const context = () => ({ priority });
  const order = [];
  let held = false;
  const pace = createPacer({ context, now: () => clock, sleep: async delay => {
    if (delay && !held) {
      held = true;
      await new Promise(resolve => { release = resolve; });
    }
    clock += delay;
  } });
  await pace(message);
  const background = pace(message).then(() => order.push('background'));
  priority = 1;
  const foreground = pace(message).then(() => order.push('foreground'));
  const cheap = pace('https://gmail.googleapis.com/gmail/v1/users/me/labels').then(() => order.push('labels'));
  release();
  await Promise.all([background, foreground, cheap]);
  assert.deepEqual(order, ['labels', 'foreground', 'background']);
});

test('a disconnected browser cancels queued Gmail work even without an SDK signal', async () => {
  const controller = new AbortController();
  const pace = createPacer();
  await pace(message);
  const transport = createGmailTransport(pace, { context: () => ({ signal: controller.signal }), log: () => {} });
  let fetches = 0;
  const pending = transport(async () => { fetches++; return new Response('{}'); }, message);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetches, 0);
});

test('HTTP request context preserves pagination and aborts after a premature response close', async () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const { Server } = require('node:http');
  const { EventEmitter } = require('node:events');
  const storage = new AsyncLocalStorage();
  const restore = installRequestContext(storage);
  try {
    const server = new Server();
    const request = Object.assign(new EventEmitter(), { url: '/api/threads?limit=25&nextPageToken=next', method: 'GET' });
    const response = Object.assign(new EventEmitter(), { writableEnded: false });
    let signal;
    server.on('request', () => {
      assert.equal(request.url, '/api/threads?limit=5&nextPageToken=next');
      assert.equal(storage.getStore().priority, 1);
      signal = storage.getStore().signal;
    });
    server.emit('request', request, response);
    assert.equal(signal.aborted, false);
    response.emit('close');
    assert.equal(signal.aborted, true);
  } finally { restore(); }
});

const { decorateMailboxSource, patchRuntimeSource, MAILBOX_FACTORY, MAILBOX_GUARDED, LIVE_SCOPE } = require('./gmail-pacing.cjs');
function fakeMailboxSource() {
  const calls = [];
  const source = {
    describe: async () => ({ status: 'ok', value: { maxPageSize: 50, maxHydrationBatch: 20 } }),
    discoverScopes: async () => ({ status: 'ok', value: { scopes: [{ id: 'primary', kind: 'account', folderId: null }], nextPage: null } }),
    beginBootstrap: async input => {
      const position = { streamId: input.scope.id, generation: 'generation', checkpoint: 'history-start' };
      return { status: 'ok', value: { bootstrapId: 'mailbox', catchUpFrom: position, enumerationToken: JSON.stringify({ scopeId: input.scope.id, catchUpFrom: position }) } };
    },
    enumerate: async input => { calls.push(input); return { status: 'ok', value: { changes: ['archive-page'], nextPage: 'archive-continuation' } }; },
    readChanges: async input => { calls.push(input); return { status: 'page', page: { from: input.position, changes: ['new-message'] } }; },
  };
  return { source, calls };
}

test('live history starts before the archive is complete and uses an independent checkpoint', async () => {
  const { source, calls } = fakeMailboxSource();
  const guarded = decorateMailboxSource(source, { name: 'google' });
  const discovered = await guarded.discoverScopes({});
  assert.deepEqual(discovered.value.scopes.map(s => [s.id, s.priority]), [[LIVE_SCOPE, 'high'], ['primary', 'low']]);
  const boot = await guarded.beginBootstrap({ scope: discovered.value.scopes[0] });
  const live = await guarded.enumerate({ bootstrapId: boot.value.bootstrapId, page: boot.value.enumerationToken, pageSize: 50 });
  assert.equal(live.value.nextPage, null);
  assert.equal(live.value.catchUpFrom.streamId, LIVE_SCOPE);
  assert.equal(live.value.catchUpFrom.checkpoint, 'history-start');
  assert.deepEqual(live.value.changes, []);
  assert.equal(calls.length, 0, 'live initialization must not fetch the archive');
  const updates = await guarded.readChanges({ position: live.value.catchUpFrom, pageSize: 50 });
  assert.deepEqual(updates.page.changes, ['new-message']);
  assert.equal(calls[0].pageSize, 10);
  const archive = await guarded.enumerate({ page: '{"scopeId":"primary","pageToken":"keep-token"}', pageSize: 50 });
  assert.equal(calls[1].pageSize, 10);
  assert.equal(JSON.parse(calls[1].page).pageToken, 'keep-token');
  assert.equal(archive.value.nextPage, 'archive-continuation');
});

test('live history does not initialize with a missing checkpoint or hide authentication failure', async () => {
  const { source } = fakeMailboxSource();
  source.beginBootstrap = async () => ({ status: 'ok', value: { catchUpFrom: { checkpoint: null } } });
  const guarded = decorateMailboxSource(source, { name: 'google' });
  assert.equal((await guarded.beginBootstrap({ scope: { id: LIVE_SCOPE } })).status, 'paused');
  assert.equal((await guarded.enumerate({ page: JSON.stringify({ scopeId: LIVE_SCOPE }), pageSize: 50 })).status, 'paused');
  source.beginBootstrap = async () => ({ status: 'blocked_auth' });
  assert.equal((await guarded.beginBootstrap({ scope: { id: LIVE_SCOPE } })).status, 'blocked_auth');
});

test('Microsoft provider sync is preserved', () => {
  const { source } = fakeMailboxSource();
  assert.equal(decorateMailboxSource(source, { name: 'microsoft' }), source);
});

test('the pinned source factory is decorated exactly once and remains idempotent', () => {
  const vm = require('node:vm');
  const factory = MAILBOX_FACTORY + 'I={accountId:l,provider:s.name};return I}];';
  const patched = patchRuntimeSource(factory);
  assert.ok(patched.includes(MAILBOX_GUARDED));
  assert.equal(patchRuntimeSource(patched), patched);
  const sandbox = {};
  let wrapped = 0;
  sandbox[Symbol.for('inboxzero.gmailPacing')] = { mailboxProvider: provider => provider, mailboxSource: source => { wrapped++; return { ...source, guarded: true }; } };
  const exported = vm.runInNewContext(patched, sandbox);
  const value = exported[2]({ accountId: 'account', provider: { name: 'google' } });
  assert.equal(value.accountId, 'account');
  assert.equal(value.guarded, true);
  assert.equal(wrapped, 1);
});

test('mailbox protocol POST requests receive foreground priority', () => {
  for (const endpoint of ['scopes', 'bootstrap', 'changes', 'changes/batch', 'hydration', 'search']) {
    assert.equal(requestDetails('/api/mail/v1/accounts/account/' + endpoint, 'POST').priority, 1);
  }
  assert.equal(requestDetails('/api/cron/automation-jobs', 'GET').priority, 2);
});

test('automation cannot starve behind an uninterrupted foreground backfill', async () => {
  let clock = 0, priority = 2, release;
  const order = [];
  let held = false;
  const pace = createPacer({ context: () => ({ priority }), now: () => clock, sleep: async delay => {
    if (delay && !held) { held = true; await new Promise(resolve => { release = resolve; }); }
    clock += delay;
  } });
  await pace(message);
  const background = pace(message).then(() => order.push('automation'));
  priority = 1;
  const foreground = Array.from({ length: 12 }, (_, i) => pace(message).then(() => order.push('foreground-' + i)));
  release();
  await Promise.all([background, ...foreground]);
  assert.equal(order.indexOf('automation'), 4);
});


test('archive enumeration yields to bulk operations and automatic processing', () => {
  assert.equal(requestDetails('/api/mail/v1/accounts/account/enumeration', 'POST').priority, 3);
  assert.equal(requestDetails('/api/threads?limit=25', 'GET').priority, 1);
});

test('quota feedback slows future traffic once per window and recovers gradually', async () => {
  let clock = 0;
  const delays = [];
  const pace = createPacer({ now: () => clock, sleep: async delay => { delays.push(delay); clock += delay; } });
  assert.equal(pace.congestion(), 12.5);
  assert.equal(pace.congestion(), 12.5);
  await pace(message);
  await pace(message);
  assert.deepEqual(delays, [0, 1600]);
  clock = 65000;
  assert.equal(pace.congestion(), 6.25);
  await pace(message);
  await pace(message);
  assert.equal(delays.at(-1), 3200);
  clock = 200000;
  await pace(message);
  await pace(message);
  assert.equal(delays.at(-1), 2560);
});


test('aged archive reads cannot starve behind ongoing higher-priority automation', async () => {
  let clock = 0, priority = 2, release;
  let held = false;
  const order = [];
  const pace = createPacer({ context: () => ({ priority }), now: () => clock, sleep: async delay => {
    if (delay && !held) { held = true; await new Promise(resolve => { release = resolve; }); }
    clock += delay;
  } });
  await pace(message);
  priority = 3;
  const archive = pace(message).then(() => order.push('archive'));
  priority = 2;
  const automation = Array.from({ length: 30 }, (_, i) => pace(message).then(() => order.push('automation-' + i)));
  release();
  await Promise.all([archive, ...automation]);
  assert.ok(order.indexOf('archive') < 15, 'archive must advance before the automation queue drains');
  assert.equal(pace.stats().grantedRequests, 32);
});


const { historyPosition } = require('./gmail-pacing.cjs');
const snapshotCursor = () => Buffer.from(JSON.stringify({version:1,provider:'google',phase:'snapshot',historyId:'9007199254740993123',after:'1970-01-01T00:00:00.000Z',pageToken:'archive-page'})).toString('base64url');
test('bootstrap records a genuine history baseline rather than a second archive scan', async () => {
  const {source}=fakeMailboxSource();
  source.beginBootstrap=async input=>{const catchUpFrom={streamId:input.scope.id,generation:'g',checkpoint:snapshotCursor()};return {status:'ok',value:{catchUpFrom,enumerationToken:JSON.stringify({scopeId:input.scope.id,catchUpFrom})}}};
  const guarded=decorateMailboxSource(source,{name:'google'});
  for(const id of [LIVE_SCOPE,'primary']) {
    const result=await guarded.beginBootstrap({scope:{id}});
    const cursor=JSON.parse(Buffer.from(result.value.catchUpFrom.checkpoint,'base64url'));
    assert.equal(cursor.phase,'delta');assert.equal(cursor.pageToken,undefined);
    assert.equal(cursor.historyId,'9007199254740993123');
    assert.deepEqual(JSON.parse(result.value.enumerationToken).catchUpFrom,result.value.catchUpFrom);
  }
});
test('existing snapshot checkpoints migrate without resetting the client commit position', async () => {
  const position={streamId:LIVE_SCOPE,generation:'g',checkpoint:snapshotCursor()};
  const {source}=fakeMailboxSource();
  let observed;
  source.readChanges=async input=>{observed=input.position;return {status:'page',page:{from:input.position,to:input.position,changes:[]}}};
  source.readChangesBatch=async input=>Promise.all(input.reads.map(read=>source.readChanges(read)));
  const guarded=decorateMailboxSource(source,{name:'google'});
  const result=await guarded.readChanges({position});
  assert.equal(JSON.parse(Buffer.from(observed.checkpoint,'base64url')).phase,'delta');
  assert.deepEqual(result.page.from,position);
  assert.notEqual(result.page.to.checkpoint,position.checkpoint);
  const batch=await guarded.readChangesBatch({reads:[{position}]});
  assert.deepEqual(batch[0].page.from,position);
  assert.equal(JSON.parse(Buffer.from(batch[0].page.to.checkpoint,'base64url')).phase,'delta');
  assert.deepEqual(historyPosition(observed),observed);
});
