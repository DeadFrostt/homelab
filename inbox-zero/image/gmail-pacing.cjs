'use strict';

// Single-process pacing shared by linked mailboxes. The worker forwards
// mailbox work to the web process. Keep below Gmail's 6,000 units/minute.
const SLOT = Symbol.for('inboxzero.gmailPacing');
const RATE = 75; // 4,500 actual units/minute, shared across linked mailboxes.

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
  const format = (url.searchParams.get('format') || 'full').toLowerCase();
  const bodyFormat = !['metadata', 'minimal'].includes(format);
  if (/\/(send|watch)$/.test(path)) return 100;
  if (/\/(import|insert)$/.test(path)) return 25;
  if (/\/(batchDelete|batchModify|stop)$/.test(path)) return 50;
  if (/\/trash$/.test(path)) return 20;
  if (/\/untrash$/.test(path)) return path.includes('/threads/') ? 10 : 5;
  if (/\/modify$/.test(path)) return path.includes('/threads/') ? 10 : 5;
  if (/\/profile$/.test(path)) return 1;
  if (/\/history$/.test(path)) return 2;
  if (/\/labels(?:\/[^/]+)?$/.test(path)) return method === 'GET' ? 1 : 5;
  if (/\/attachments\//.test(path)) return 20;
  if (/\/threads\/[^/]+$/.test(path)) return method === 'GET' ? (bodyFormat ? 120 : 40) : 20;
  if (/\/threads$/.test(path)) return 10;
  if (/\/messages\/[^/]+$/.test(path)) return method === 'GET' ? (bodyFormat ? 60 : 20) : 10;
  if (/\/messages$/.test(path)) return method === 'GET' ? 5 : 25;
  if (/\/drafts\/[^/]+$/.test(path)) return method === 'GET' ? (bodyFormat ? 60 : 20) : method === 'PUT' ? 15 : 10;
  if (/\/drafts$/.test(path)) return method === 'GET' ? 5 : 10;
  // Conservative fallback for Gmail operations outside the sync paths.
  return 100;
}

function createPacer({ now = Date.now, sleep = abortableSleep, unitsPerSecond = RATE, context = () => null } = {}) {
  let availableAt = 0;
  let blockedUntil = 0;
  let draining = false;
  let foregroundStreak = 0;
  let realtimeStreak = 0;
  let effectiveRate = unitsPerSecond;
  let reducedAt = -Infinity;
  let recoveryAt = 0;
  const queue = [];
  let grantedUnits = 0, grantedRequests = 0, maxWaitMs = 0;
  let byPriority = {};
  function remove(entry) {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    entry.signal?.removeEventListener('abort', entry.abort);
  }
  function next() {
    for (const entry of [...queue]) if (entry.cancelled) remove(entry);
    const best = queue.reduce((candidate, entry) => !candidate || entry.priority < candidate.priority ? entry : candidate, null);
    // Priority must not indefinitely postpone an archive page behind automation.
    // Age applies to every class, including cheap reads, so all queued work progresses.
    const oldest = queue[0];
    if (best?.priority === -1 && realtimeStreak < 4) return best;
    if (oldest && now() - oldest.enqueuedAt >= 10000) return oldest;
    // Preserve cheap UI calls, but reserve background progress during a full import.
    if (best?.priority === 1 && foregroundStreak >= 4) return queue.find(entry => entry.priority === 2) || queue.find(entry => entry.priority === 3) || best;
    return best;
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const waiting = next();
        if (!waiting) break;
        try {
          let deadline;
          do {
            deadline = Math.max(availableAt, blockedUntil);
            await sleep(Math.max(0, deadline - now()), waiting.signal);
          } while (blockedUntil > deadline);
          waiting.signal?.throwIfAborted();
          // New foreground/cheap calls may arrive while the quota slot sleeps.
          const entry = next();
          if (!entry) continue;
          entry.signal?.throwIfAborted();
          if (effectiveRate < unitsPerSecond && now() >= recoveryAt) {
            effectiveRate = Math.min(unitsPerSecond, effectiveRate * 1.25);
            recoveryAt = now() + 120000;
          }
          availableAt = Math.max(now(), availableAt, blockedUntil) + Math.ceil(entry.cost * 1000 / effectiveRate);
          grantedUnits += entry.cost;
          grantedRequests++;
          const bucket = byPriority[entry.priority] ||= { units: 0, requests: 0 };
          bucket.units += entry.cost; bucket.requests++;
          maxWaitMs = Math.max(maxWaitMs, now() - entry.enqueuedAt);
          remove(entry);
          if (entry.priority === -1) realtimeStreak++; else realtimeStreak = 0;
          if (entry.priority >= 2) foregroundStreak = 0;
          else if (entry.priority === 1) foregroundStreak++;
          entry.resolve();
        } catch (error) {
          remove(waiting);
          waiting.reject(error);
        }
      }
    } finally { draining = false; }
  }
  const pace = async function (input, options = {}) {
    const cost = requestCost(input, options);
    if (!cost) return;
    const signal = options.signal || input?.signal;
    signal?.throwIfAborted();
    const priority = context()?.priority === -1 ? -1 : cost <= 5 ? 0 : context()?.priority ?? 2;
    return new Promise((resolve, reject) => {
      const entry = { cost, priority, signal, resolve, reject, enqueuedAt: now(), cancelled: false };
      entry.abort = () => { entry.cancelled = true; reject(signal.reason); };
      signal?.addEventListener('abort', entry.abort, { once: true });
      queue.push(entry);
      void drain();
    });
  };
  pace.cooldown = milliseconds => {
    blockedUntil = Math.max(blockedUntil, now() + milliseconds);
  };
  pace.stats = () => {
    const result = { grantedUnits, grantedRequests, maxWaitMs, queuedRequests: queue.length, unitsPerSecond: effectiveRate, byPriority };
    grantedUnits = 0; grantedRequests = 0; maxWaitMs = 0; byPriority = {};
    return result;
  };
  pace.congestion = () => {
    // A burst of failed subrequests must reduce the rate only once per window.
    if (now() - reducedAt >= 60000) {
      effectiveRate = Math.max(unitsPerSecond / 8, effectiveRate / 2);
      reducedAt = now();
    }
    recoveryAt = now() + 120000;
    return effectiveRate;
  };
  return pace;
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

// Gaxios bundles node-fetch, so wrapping global fetch alone misses SDK errors.
// Replace the existing pre-request hook with a complete shared transport wrapper.
const ADAPTER_BODY = 'let t=e.fetchImplementation||this.defaults.fetchImplementation||await A.#A(),r={...e};delete r.data;let s=await t(e.url,r),n=await this.getResponseData(e,s);';
const ADAPTER_PLAIN = 'async _defaultAdapter(e){' + ADAPTER_BODY;
const ADAPTER_OLD = 'async _defaultAdapter(e){await globalThis[Symbol.for("inboxzero.gmailPacing")]?.(e.url,e);' + ADAPTER_BODY;
const ADAPTER_MANAGED = ADAPTER_PLAIN.replace('await t(e.url,r)', 'await globalThis[Symbol.for("inboxzero.gmailPacing")].transport(t,e.url,r)');
function patchAdapterSource(source) {
  return source.replaceAll(ADAPTER_OLD, ADAPTER_MANAGED).replaceAll(ADAPTER_PLAIN, ADAPTER_MANAGED);
}
const MAILBOX_FACTORY = '["createEmailProviderMailboxSource",0,function(e){let{provider:s,accountId:l}=e,m="microsoft"===s.name?20:50,';
const MAILBOX_GUARDED_OLD = '["createEmailProviderMailboxSource",0,function inboxzeroMailboxSource(e){if(!e.__inboxzeroSyncGuard)return globalThis[Symbol.for("inboxzero.gmailPacing")].mailboxSource(inboxzeroMailboxSource({...e,__inboxzeroSyncGuard:true}),e.provider);let{provider:s,accountId:l}=e,m="microsoft"===s.name?20:50,';
const MAILBOX_GUARDED = '["createEmailProviderMailboxSource",0,function inboxzeroMailboxSource(e){if(!e.__inboxzeroSyncGuard)return globalThis[Symbol.for("inboxzero.gmailPacing")].mailboxSource(inboxzeroMailboxSource({...e,provider:globalThis[Symbol.for("inboxzero.gmailPacing")].mailboxProvider(e.provider,e.accountId),__inboxzeroSyncGuard:true}),e.provider);let{provider:s,accountId:l}=e,m="microsoft"===s.name?20:50,';
const OPERATION_FACTORY = '"createEmailProviderOperationExecutor",0,function(e){let{provider:t,accountId:a}=e;return{';
const OPERATION_GUARDED = '"createEmailProviderOperationExecutor",0,function inboxzeroOperationExecutor(e){if(!e.__inboxzeroOperationsGuard)return globalThis[Symbol.for("inboxzero.gmailPacing")].operationExecutor(inboxzeroOperationExecutor({...e,__inboxzeroOperationsGuard:true}),e.provider);let{provider:t,accountId:a}=e;return{';
function patchRuntimeSource(source) {
  return patchAdapterSource(source).replaceAll(MAILBOX_GUARDED_OLD, MAILBOX_GUARDED).replaceAll(MAILBOX_FACTORY, MAILBOX_GUARDED).replaceAll(OPERATION_FACTORY, OPERATION_GUARDED);
}
const LIVE_SCOPE = 'primary-live';
// Read history cheaply in large pages, but hydrate at most ten messages per call.
// New arrivals take priority over pending label updates. Cursors retain a replay
// baseline so process restarts/eviction replay changes rather than discard them.
function createHistoryPager({ now = Date.now, ttlMs = 900000, maxStates = 128, maxPendingIds = 100000 } = {}) {
  const states = new Map();
  function save(accountId, state) {
    for (const [key, item] of states) if (item.expires <= now()) states.delete(key);
    const size = state.upserts.length + state.deleted.length;
    if (size > maxPendingIds) throw new Error('Gmail history pending window is too large');
    let total = [...states.values()].reduce((n, item) => n + item.size, 0);
    while (states.size && (states.size >= maxStates || total + size > maxPendingIds)) {
      const key = states.keys().next().value;
      total -= states.get(key).size; states.delete(key);
    }
    const key = require('node:crypto').randomUUID();
    states.set(accountId + ':' + key, { ...state, size, expires: now() + ttlMs });
    return key;
  }
  return async function read(provider, accountId, input) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch {}
    if (cursor?.version !== 1 || cursor.provider !== 'google' || cursor.phase !== 'delta' ||
        !/^\d+$/.test(cursor.historyId) || !Number.isFinite(Date.parse(cursor.after))) {
      return provider.getMailboxSyncPage(input);
    }
    const cached = cursor.inboxzeroPending && states.get(accountId + ':' + cursor.inboxzeroPending);
    const pending = cached?.expires > now() ? cached : null;
    const replayFrom = /^\d+$/.test(cursor.inboxzeroReplayFrom) ? cursor.inboxzeroReplayFrom : cursor.historyId;
    const recovering = Boolean(cursor.inboxzeroPending && !pending);
    const start = recovering ? replayFrom : cursor.historyId;
    // Legacy continuation pages may contain thousands of label changes ahead
    // of new mail. Re-list that window, then prioritize its arrival IDs.
    let pageToken = cursor.inboxzeroHistory === 1 && !recovering ? cursor.pageToken : undefined;
    let tail = start;
    const inboxArrivals = new Set(), arrived = new Set(), changed = new Set(), deleted = new Set();
    for (let pages = 0; pages < 20; pages++) {
      let data;
      try { ({ data } = await provider.client.users.history.list({ userId: 'me', startHistoryId: start,
        historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'], maxResults: 500,
        ...(pageToken ? { pageToken } : {}) })); }
      catch (error) {
        if (Number(error.response?.status || error.status || error.code) === 404) error.inboxzeroHistoryExpired = true;
        throw error;
      }
      for (const record of data.history || []) {
        for (const item of record.messagesAdded || []) if (item.message?.id) {
          arrived.add(item.message.id);
          if (item.message.labelIds?.includes('INBOX') && !item.message.labelIds.includes('DRAFT')) inboxArrivals.add(item.message.id);
        }
        for (const item of [...record.messagesAdded || [], ...record.labelsAdded || [], ...record.labelsRemoved || []]) {
          if (item.message?.id) changed.add(item.message.id);
        }
        for (const message of record.messages || []) if (message.id) changed.add(message.id);
        for (const item of record.messagesDeleted || []) if (item.message?.id) deleted.add(item.message.id);
      }
      pageToken = data.nextPageToken;
      tail = pageToken ? start : data.historyId || start;
      if (!pageToken) break;
    }
    const deletions = [...new Set([...(pending?.deleted || []), ...deleted])];
    const deletedSet = new Set(deletions);
    const upserts = [...new Set([...inboxArrivals].reverse().concat([...arrived].reverse(), pending?.upserts || [], [...changed]))].filter(id => !deletedSet.has(id));
    const count = Math.min(Math.max(input.limit || 10, 1), 10);
    const ids = upserts.slice(0, count);
    const removed = deletions.slice(0, count);
    const fetched = ids.length ? await provider.getMessagesBatch(ids) : [];
    const messages = new Map();
    for (const message of fetched) {
      if (!ids.includes(message.id) || messages.has(message.id)) throw new Error('Unexpected Gmail history message ID');
      messages.set(message.id, message);
    }
    // Batch helpers can omit failures. Only a confirmed 404 is a deletion.
    for (const id of ids) if (!messages.has(id)) {
      try {
        const message = await provider.getMessage(id);
        if (message.id !== id) throw new Error('Unexpected Gmail history message ID');
        messages.set(id, message);
      } catch (error) {
        if (Number(error.response?.status || error.status || error.code) !== 404) throw error;
        removed.push(id);
      }
    }
    const inWindow = [];
    for (const message of messages.values()) {
      if (Number(message.internalDate) >= Date.parse(cursor.after)) inWindow.push(message);
      else removed.push(message.id);
    }
    const remaining = { upserts: upserts.slice(count), deleted: deletions.slice(count) };
    const hasPending = remaining.upserts.length + remaining.deleted.length > 0;
    const next = { version: 1, provider: 'google', phase: 'delta', historyId: tail, after: cursor.after,
      ...(pageToken ? { pageToken } : {}), inboxzeroHistory: 1,
      ...(hasPending ? { inboxzeroPending: save(accountId, remaining), inboxzeroReplayFrom: replayFrom } : {}) };
    return { cursor: Buffer.from(JSON.stringify(next)).toString('base64url'),
      changedThreadIds: [...new Set(inWindow.map(message => message.threadId).filter(Boolean))],
      deletedMessageIds: [...new Set(removed)], upsertedMessages: inWindow,
      hasMore: Boolean(pageToken || hasPending), reset: false };
  };
}
function decorateMailboxProvider(provider, accountId, historyPager) {
  if (provider.name !== 'google') return provider;
  if (!provider.client?.users?.history?.list || typeof provider.getMessagesBatch !== 'function') {
    throw new Error('Gmail provider is incompatible with bounded history catch-up');
  }
  return new Proxy(provider, { get(target, key) {
    if (key === 'getMailboxSyncPage') return async input => {
      try { return await historyPager(target, accountId, input); }
      catch (error) {
        if (!error.inboxzeroHistoryExpired) throw error;
        return target.getMailboxSyncPage(input);
      }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function historyPosition(position) {
  if (!position?.checkpoint) return position;
  try {
    const cursor = JSON.parse(Buffer.from(position.checkpoint, 'base64url').toString('utf8'));
    if (cursor.version !== 1 || cursor.provider !== 'google' || cursor.phase !== 'snapshot' ||
        !/^\d+$/.test(cursor.historyId) || !Number.isFinite(Date.parse(cursor.after))) return position;
    const { pageToken, ...baseline } = cursor;
    return { ...position, checkpoint: Buffer.from(JSON.stringify({ ...baseline, phase: 'delta' })).toString('base64url') };
  } catch { return position; }
}
function restoreReadFrom(result, position) {
  return result?.status === 'page' ? { ...result, page: { ...result.page, from: position } } : result;
}
function stripUnknownAttachmentFlags(values) {
  return values?.map(change => {
    if (change.kind !== 'message_patch' || change.fields?.hasAttachments !== false) return change;
    const { hasAttachments, ...fields } = change.fields;
    return { ...change, fields };
  });
}
function decorateOperationExecutor(executor, provider, { runMetadata } = {}) {
  if (provider.name !== 'google' || !runMetadata) return executor;
  const wrap = method => async input => {
    if (input.operation?.intent?.kind !== 'metadata') return executor[method](input);
    const result = await runMetadata(() => executor[method](input));
    return Array.isArray(result.observations)
      ? { ...result, observations: stripUnknownAttachmentFlags(result.observations) } : result;
  };
  return { ...executor, execute: wrap('execute'), inspect: wrap('inspect') };
}
function decorateMailboxSource(source, provider, { runMetadata } = {}) {
  if (provider.name !== 'google') return source;
  const page = input => ({ ...input, pageSize: Math.min(input.pageSize || 10, 10) });
  const metadata = operation => runMetadata ? runMetadata(operation) : operation();
  // Metadata already supplies list fields. Missing bodies stay missing until the
  // UI requests content; never store a snippet as a complete message body.
  const listResult = result => {
    if (!runMetadata) return result;
    // Metadata omits MIME parts. An unknown attachment flag must not erase
    // attachment evidence obtained from a previously hydrated full body.
    if (result.status === 'ok') return { ...result, value: { ...result.value, changes: stripUnknownAttachmentFlags(result.value.changes), requiredHydration: [], bodies: [] } };
    if (result.status === 'page') return { ...result, page: { ...result.page, changes: stripUnknownAttachmentFlags(result.page.changes), requiredHydration: [] } };
    return result;
  };
  return {
    ...source,
    async describe(input) {
      const result = await source.describe(input);
      return result.status !== 'ok' ? result : { ...result, value: { ...result.value, maxPageSize: 10, maxHydrationBatch: 10 } };
    },
    async discoverScopes(input) {
      const result = await source.discoverScopes(input);
      if (result.status !== 'ok') return result;
      return { ...result, value: { ...result.value, scopes: [
        { id: LIVE_SCOPE, kind: 'account', folderId: null, priority: 'high' },
        ...result.value.scopes.filter(scope => scope.id !== LIVE_SCOPE).map(scope => ({ ...scope, priority: 'low' })),
      ] } };
    },
    async beginBootstrap(input) {
      const result = await source.beginBootstrap(input);
      if (input.scope.id === LIVE_SCOPE && result.status === 'ok' && !result.value.catchUpFrom?.checkpoint) {
        return { status: 'paused', reason: 'unavailable', retryAfterMs: 5000 };
      }
      if (result.status !== 'ok' || !result.value.catchUpFrom) return result;
      const catchUpFrom = historyPosition(result.value.catchUpFrom);
      let enumerationToken = result.value.enumerationToken;
      try { enumerationToken = JSON.stringify({ ...JSON.parse(enumerationToken), catchUpFrom }); } catch {}
      return { ...result, value: { ...result.value, catchUpFrom, enumerationToken } };
    },
    async enumerate(input) {
      let token;
      try { token = JSON.parse(input.page); } catch { return listResult(await metadata(() => source.enumerate(page(input)))); }
      if (token.scopeId === LIVE_SCOPE) {
        if (!token.catchUpFrom?.checkpoint) return { status: 'paused', reason: 'unavailable', retryAfterMs: 5000 };
        return { status: 'ok', value: { bootstrapId: input.bootstrapId, scopeId: LIVE_SCOPE,
          changes: [], requiredHydration: [], bodies: [], nextPage: null, catchUpFrom: token.catchUpFrom } };
      }
      return listResult(await metadata(() => source.enumerate(page(input))));
    },
    async readChanges(input) {
      return restoreReadFrom(listResult(await metadata(() => source.readChanges(page({ ...input, position: historyPosition(input.position) })))), input.position);
    },
    ...(source.readChangesBatch ? { async readChangesBatch(input) {
      const results = await metadata(() => source.readChangesBatch(page({ ...input, reads: input.reads.map(read => ({ ...read, position: historyPosition(read.position) })) })));
      return results.map((result, i) => restoreReadFrom(listResult(result), input.reads[i].position));
    } } : {}),
    ...(source.readConversationMembership ? { async readConversationMembership(input) {
      const result = await metadata(() => source.readConversationMembership(input));
      if (!runMetadata || result.status !== 'ok' || result.value.status !== 'page') return result;
      return { ...result, value: { ...result.value, page: { ...result.value.page,
        changes: stripUnknownAttachmentFlags(result.value.page.changes) } } };
    } } : {}),
    ...(source.search ? { search: input => source.search(page(input)) } : {}),
  };
}
function patchBundledTransport() {
  const fs = require('node:fs');
  const directory = '/app/apps/web/.next/server/chunks';
  let matched = 0;
  let mailboxMatched = 0;
  let operationMatched = 0;
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.js')) continue;
    const target = directory + '/' + file;
    const source = fs.readFileSync(target, 'utf8');
    const patched = patchRuntimeSource(source);
    if (patched.includes(ADAPTER_MANAGED)) matched++;
    if (patched.includes(MAILBOX_GUARDED)) mailboxMatched++;
    if (patched.includes(OPERATION_GUARDED)) operationMatched++;
    if (patched !== source) {
      const temporary = target + '.gmail-guard-' + process.pid;
      fs.writeFileSync(temporary, patched);
      fs.renameSync(temporary, target);
    }
  }
  if (!matched || !mailboxMatched || !operationMatched) throw new Error('No compatible Gmail adapter/mailbox source/operation executor; refusing to start without sync protection');
}

function boundaryFrom(headers) {
  return /boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(headers.get('content-type') || '')?.slice(1).find(Boolean);
}
function isQuotaError(status, data) {
  return status === 429 || (status === 403 &&
    (data?.error?.errors || []).some(error => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(error.reason)));
}
function multipartParts(text, boundary) {
  return text.split('--' + boundary).slice(1, -1);
}
function partRateLimited(part) {
  const status = Number(/HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(part)?.[1]);
  if (status !== 403 && status !== 429) return false;
  try { return isQuotaError(status, JSON.parse(part.slice(part.indexOf('{')).trim())); }
  catch { return status === 429; }
}

function metadataRead(input, options = {}) {
  const rewrite = value => {
    const url = new URL(value);
    if (!['gmail.googleapis.com', 'www.googleapis.com'].includes(url.hostname) ||
        !/^\/gmail\/v1\/users\/[^/]+\/(?:messages|threads)\/[^/]+$/.test(url.pathname)) return value;
    url.searchParams.set('format', 'metadata');
    return url.toString();
  };
  const method = String(options.method || input?.method || 'GET').toUpperCase();
  const url = new URL(input?.url || input);
  if (method === 'GET') {
    const rewritten = rewrite(url.toString());
    return { input: typeof Request !== 'undefined' && input instanceof Request ? new Request(rewritten, input) : rewritten, options };
  }
  if (url.pathname === '/batch/gmail/v1' && typeof options.body === 'string') {
    const body = options.body.replace(/^GET (\/gmail\/v1\/[^\s]+)/gm, (_, path) => {
      const rewritten = new URL(rewrite('https://gmail.googleapis.com' + path));
      return 'GET ' + rewritten.pathname + rewritten.search;
    });
    return { input, options: { ...options, body } };
  }
  return { input, options };
}

function createGmailTransport(pace, { cooldownMs = 65000, log = console.info, context = () => null } = {}) {
  function quotaCooldown(response) {
    const retryAfter = response.headers.get('retry-after');
    const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
    const delay = Math.max(cooldownMs, retryMs);
    pace.cooldown(delay);
    const unitsPerSecond = pace.congestion?.();
    log('[gmail-guard] ' + JSON.stringify({ event: 'quota-cooldown', seconds: Math.ceil(delay / 1000), unitsPerSecond }));
  }
  async function limited(response) {
    const type = response.headers.get('content-type') || '';
    if (/multipart\/mixed/i.test(type)) {
      const boundary = boundaryFrom(response.headers);
      return boundary ? multipartParts(await response.clone().text(), boundary).some(partRateLimited) : false;
    }
    if (![403, 429].includes(response.status)) return false;
    let data;
    try { data = await response.clone().json(); } catch {}
    return isQuotaError(response.status, data);
  }
  async function send(fetchImplementation, input, options, retrySafe) {
    for (let attempt = 0; ; attempt++) {
      await pace(input, options);
      const response = await fetchImplementation(input, options);
      if (!await limited(response)) return response;
      quotaCooldown(response);
      if (!retrySafe || attempt >= 1) return response;
      // Retrying waits on the same cooldown as all other mailbox requests.
      await response.body?.cancel?.().catch(() => {});
    }
  }
  return async function transport(fetchImplementation, input, options = {}) {
    if (!requestCost(input, options)) return fetchImplementation(input, options);
    if (context()?.metadataOnly) ({ input, options } = metadataRead(input, options));
    const requestSignal = context()?.signal;
    if (requestSignal) {
      const signals = [options.signal || input?.signal, requestSignal].filter(Boolean);
      options = { ...options, signal: AbortSignal.any(signals) };
    }
    options.signal?.throwIfAborted();
    const url = new URL(input?.url || input);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (url.pathname !== '/batch/gmail/v1') return send(fetchImplementation, input, options, method === 'GET');
    const headers = new Headers(options.headers || input?.headers);
    const boundary = boundaryFrom(headers);
    const parts = boundary ? multipartParts(options.body, boundary) : [];
    // Only split/retry the app's read-only batch format. Never replay writes.
    if (!parts.length || parts.some(part => !/\nGET \/gmail\/v1\//.test(part))) return send(fetchImplementation, input, options, false);
    const responses = [];
    for (let offset = 0; offset < parts.length; offset += 2) {
      const chunk = parts.slice(offset, offset + 2);
      const body = chunk.map(part => '--' + boundary + part).join('') + '--' + boundary + '--';
      const response = await send(fetchImplementation, input, { ...options, body }, true);
      if (!response.ok) return response;
      const responseBoundary = boundaryFrom(response.headers);
      if (!responseBoundary) return response;
      responses.push(...multipartParts(await response.text(), responseBoundary));
    }
    const mergedBoundary = 'inboxzero_gmail_guard';
    log('[gmail-guard] ' + JSON.stringify({ event: 'read-batch-complete', requests: parts.length, batches: Math.ceil(parts.length / 2) }));
    return new Response(responses.map(part => '--' + mergedBoundary + part).join('') + '--' + mergedBoundary + '--\r\n', {
      status: 200, headers: { 'content-type': 'multipart/mixed; boundary=' + mergedBoundary },
    });
  };
}

function requestDetails(url, method) {
  const parsed = new URL(url, 'http://inbox-zero');
  if (method === 'GET' && parsed.pathname === '/api/threads') {
    const limit = Number(parsed.searchParams.get('limit'));
    if (!limit || limit > 5) parsed.searchParams.set('limit', '5');
  }
  // Sender cleanup uses this exact inbox/fromEmail scan only to collect IDs.
  // Keep every continuation token, and leave general thread previews untouched.
  const cleanupScan = method === 'GET' && parsed.pathname === '/api/threads/basic' &&
    Boolean(parsed.searchParams.get('fromEmail')?.trim()) && parsed.searchParams.get('labelId') === 'INBOX';
  if (cleanupScan) {
    const limit = Number(parsed.searchParams.get('limit'));
    if (!Number.isFinite(limit) || limit <= 0 || limit > 10) parsed.searchParams.set('limit', '10');
  }
  return {
    url: parsed.pathname + parsed.search,
    ...(cleanupScan ? { metadataOnly: true } : {}),
    priority: /^\/api\/mail\/v1\/accounts\/[^/]+\/changes(?:\/batch)?$/.test(parsed.pathname) ? -1 : /^\/api\/mail\/v1\/accounts\/[^/]+\/enumeration$/.test(parsed.pathname) ? 3 : (method === 'GET' && !parsed.pathname.startsWith('/api/cron/')) || /^\/api\/mail\/v1\/accounts\/[^/]+\/(?:scopes|bootstrap|enumeration|changes(?:\/batch)?|hydration|search|assistant-state)$/.test(parsed.pathname) ? 1 : 2,
  };
}
function installRequestContext(storage) {
  const { Server } = require('node:http');
  const originalEmit = Server.prototype.emit;
  function emit(event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args);
    const [request, response] = args;
    const details = requestDetails(request.url, request.method);
    request.url = details.url;
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Browser request disconnected', 'AbortError'));
    const close = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort);
    response.once('close', close);
    response.once('finish', () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', close);
    });
    return storage.run({ priority: details.priority, signal: controller.signal, metadataOnly: details.metadataOnly }, () => originalEmit.call(this, event, ...args));
  }
  Server.prototype.emit = emit;
  return () => { if (Server.prototype.emit === emit) Server.prototype.emit = originalEmit; };
}

function install() {
  if (globalThis[SLOT]) return;
  const { AsyncLocalStorage } = require('node:async_hooks');
  const storage = new AsyncLocalStorage();
  const context = () => storage.getStore();
  installRequestContext(storage);
  const pace = createPacer({ context });
  setInterval(() => console.info('[gmail-guard] ' + JSON.stringify({ event: 'pacing-window', ...pace.stats() })), 60000).unref();
  pace.transport = createGmailTransport(pace, { context });
  pace.mailboxSource = (source, provider) => decorateMailboxSource(source, provider, {
    runMetadata: operation => storage.run({ ...context(), metadataOnly: true }, operation),
  });
  pace.operationExecutor = (executor, provider) => decorateOperationExecutor(executor, provider, {
    runMetadata: operation => storage.run({ ...context(), metadataOnly: true }, operation),
  });
  const historyPager = createHistoryPager();
  pace.mailboxProvider = (provider, accountId) => decorateMailboxProvider(provider, accountId, historyPager);
  globalThis[SLOT] = pace;
  patchBundledTransport();
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, options) => pace.transport(originalFetch, input, options);
}

module.exports = { OPERATION_FACTORY, OPERATION_GUARDED, decorateOperationExecutor, metadataRead, RATE, requestCost, createPacer, createGmailTransport, patchAdapterSource, ADAPTER_PLAIN, ADAPTER_OLD, ADAPTER_MANAGED, requestDetails, installRequestContext, decorateMailboxSource, patchRuntimeSource, MAILBOX_FACTORY, MAILBOX_GUARDED, LIVE_SCOPE, historyPosition, createHistoryPager, decorateMailboxProvider, MAILBOX_GUARDED_OLD, install };
if (process.env.INBOXZERO_GMAIL_PACING === 'true') install();
