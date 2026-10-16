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

test('large read batches become batches of ten and retain all results in order', async () => {
  const sizes = [];
  const costs = [];
  const transport = createGmailTransport(async (url, options) => costs.push(requestCost(url, options)), { log: () => {} });
  const result = await transport(async (url, options) => {
    const ids = [...options.body.matchAll(/messages\/(\d+)\?/g)].map(match => match[1]);
    sizes.push(ids.length);
    return batchResponse(ids);
  }, batchUrl, batchOptions(25));
  assert.deepEqual(sizes, [10, 10, 5]);
  assert.deepEqual(costs, [200, 200, 100]);
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
