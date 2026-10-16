'use strict';

// Single-process pacing for this single-mailbox pilot. The worker forwards
// mailbox work to the web process. Keep below Gmail's 6,000 units/minute.
const SLOT = Symbol.for('inboxzero.gmailPacing');
const RATE = 50; // 3,000 units/minute, reserving headroom for other activity.

function requestCost(input, options = {}) {
  let url;
  try { url = new URL(typeof input === 'object' && input.url ? input.url : input); }
  catch { return 0; }
  if (!['gmail.googleapis.com', 'www.googleapis.com'].includes(url.hostname)) return 0;
  const method = String(options.method || input?.method || 'GET').toUpperCase();
  const path = url.pathname;
  if (path === '/batch/gmail/v1') {
    const body = options.body;
    // The installed app constructs Gmail batch requests as strings.
    if (typeof body !== 'string') throw new Error('Gmail batch pacing requires a string body');
    const requests = [...body.matchAll(/^(GET|POST|PUT|PATCH|DELETE) (\/gmail\/v1\/[^\s]+)/gm)];
    if (!requests.length) throw new Error('Gmail batch pacing could not determine request cost');
    return requests.reduce((sum, match) => sum + requestCost('https://gmail.googleapis.com' + match[2], { method: match[1] }), 0);
  }
  if (!path.startsWith('/gmail/v1/')) return 0;
  if (/\/(send|watch|import)$/.test(path)) return 100;
  if (/\/(batchDelete|batchModify|stop)$/.test(path)) return 50;
  if (/\/(trash|untrash)$/.test(path)) return 20;
  if (/\/profile$/.test(path)) return 1;
  if (/\/history$/.test(path)) return 2;
  if (/\/labels(?:\/[^/]+)?$/.test(path)) return method === 'GET' ? 1 : 5;
  if (/\/attachments\//.test(path)) return 20;
  if (/\/threads\/[^/]+$/.test(path)) return method === 'GET' ? 40 : 20;
  if (/\/threads$/.test(path)) return 10;
  if (/\/messages\/[^/]+$/.test(path)) return method === 'GET' ? 20 : 10;
  if (/\/messages$/.test(path)) return 5;
  // Conservative fallback for Gmail operations outside the sync paths.
  return 100;
}

function createPacer({ now = Date.now, sleep = abortableSleep, unitsPerSecond = RATE } = {}) {
  let availableAt = 0;
  let draining = false;
  const queue = [];
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const entry = queue[0];
        if (entry.cancelled) { queue.shift(); continue; }
        try {
          await sleep(Math.max(0, availableAt - now()), entry.signal);
          entry.signal?.throwIfAborted();
          availableAt = Math.max(now(), availableAt) + Math.ceil(entry.cost * 1000 / unitsPerSecond);
          entry.signal?.removeEventListener('abort', entry.abort);
          queue.shift();
          entry.resolve();
        } catch (error) {
          entry.signal?.removeEventListener('abort', entry.abort);
          queue.shift();
          entry.reject(error);
        }
      }
    } finally { draining = false; }
  }
  return async function pace(input, options = {}) {
    const cost = requestCost(input, options);
    if (!cost) return;
    const signal = options.signal || input?.signal;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { cost, signal, resolve, reject, cancelled: false };
      entry.abort = () => { entry.cancelled = true; reject(signal.reason); };
      signal?.addEventListener('abort', entry.abort, { once: true });
      queue.push(entry);
      void drain();
    });
  };
}

function abortableSleep(delay, signal) {
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    function abort() { clearTimeout(timer); reject(signal.reason); }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function install() {
  if (globalThis[SLOT]) return;
  const pace = createPacer();
  globalThis[SLOT] = pace;
  // Direct fetch is used by the Gmail multipart batch implementation.
  // The bundled Gaxios transport is patched separately to share this pacer.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, options) {
    await pace(input, options);
    return originalFetch.call(this, input, options);
  };

}

module.exports = { requestCost, createPacer, install };
if (process.env.INBOXZERO_GMAIL_PACING === 'true') install();
