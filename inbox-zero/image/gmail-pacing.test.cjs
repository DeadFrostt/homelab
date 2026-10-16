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
  assert.deepEqual(delays, [0, 400, 800]);
  await pace('https://api.lithosai.cloud/v1/chat/completions');
  assert.equal(delays.length, 3);
});

test('batch reserves the aggregate cost before following requests', async () => {
  const delays = [];
  const pace = createPacer({ now: () => 0, sleep: async delay => { delays.push(delay); } });
  const body = 'GET /gmail/v1/users/me/messages/a\nGET /gmail/v1/users/me/threads/b\n';
  await pace('https://www.googleapis.com/batch/gmail/v1', { method: 'POST', body });
  await pace(message);
  assert.deepEqual(delays, [0, 1200]);
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
  assert.deepEqual(delays, [0, 400, 400]);
});
