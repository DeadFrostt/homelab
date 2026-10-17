import { createDecipheriv, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

export function pollAction(current, last) {
  if (!/^\d+$/.test(current)) throw new Error('Invalid Gmail history position');
  if (!last) return 'initialize';
  if (!/^\d+$/.test(last)) throw new Error('Invalid stored history position');
  return BigInt(current) > BigInt(last) ? 'notify' : 'unchanged';
}

export function decryptToken(value, env) {
  if (!value) return null;
  const versioned = value.startsWith('v1:');
  const hex = versioned ? value.slice(3) : value;
  if (!versioned && (!/^[0-9a-f]+$/i.test(hex) || hex.length < 64)) return value;
  try {
    const bytes = Buffer.from(hex, 'hex');
    const cipher = createDecipheriv('aes-256-gcm', scryptSync(env.EMAIL_ENCRYPT_SECRET, env.EMAIL_ENCRYPT_SALT, 32), bytes.subarray(0, 16));
    cipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([cipher.update(bytes.subarray(32)), cipher.final()]).toString();
  } catch (error) {
    if (versioned) throw error;
    return value;
  }
}

class PollError extends Error {
  constructor(stage, status) { super(stage); this.stage = stage; this.status = status; }
}

export async function pollAccount({ account, current, initialize, notify, checkOnly = false }) {
  const action = pollAction(current, account.lastSyncedHistoryId);
  if (checkOnly) return { action, notified: false };
  if (action === 'initialize') {
    // Starting automation must not unexpectedly replay the entire existing inbox.
    await initialize(account.id, current);
  }
  if (action === 'notify') await notify(account, current);
  return { action, notified: action === 'notify' };
}

export async function waitForAppReady({ env, fetchImpl, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + 240000;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(new URL('/api/health', env.INTERNAL_API_URL || 'http://inbox-zero:3000'), {
        headers: { 'x-health-api-key': env.HEALTH_API_KEY }, signal: AbortSignal.timeout(5000),
      });
      if (response.ok && (await response.json()).database?.status === 'healthy') return;
    } catch {}
    await sleep(3000);
  }
  throw new PollError('app-not-ready');
}

export async function runPoller({ env = process.env, fetchImpl = fetch, checkOnly = false } = {}) {
  if (!env.GOOGLE_PUBSUB_VERIFICATION_TOKEN?.trim()) throw new PollError('missing-webhook-verification-token');
  await waitForAppReady({ env, fetchImpl });
  const { Client } = require(require.resolve('pg', { paths: ['/app/apps/web'] }));
  const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  await db.connect();
  try {
    const { rows } = await db.query(`SELECT ea.id, ea.email, ea."lastSyncedHistoryId", a.access_token, a.refresh_token, a.expires_at
      FROM "EmailAccount" ea JOIN "Account" a ON a.id = ea."accountId"
      WHERE a.provider = 'google' AND a."disconnectedAt" IS NULL`);
    const results = [];
    for (const account of rows) {
      let token = decryptToken(account.access_token, env);
      async function refresh() {
        const response = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token', refresh_token: decryptToken(account.refresh_token, env) || '' }),
        });
        if (!response.ok) throw new PollError('oauth-refresh', response.status);
        const body = await response.json();
        if (!body.access_token) throw new PollError('oauth-refresh-missing-token');
        token = body.access_token;
      }
      if (!token || (account.expires_at && new Date(account.expires_at).getTime() <= Date.now() + 30000)) await refresh();
      const profile = () => fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
      });
      let response = await profile();
      if (response.status === 401) { await refresh(); response = await profile(); }
      if (!response.ok) throw new PollError('gmail-profile', response.status);
      const { historyId } = await response.json();
      const result = await pollAccount({ account, current: String(historyId), checkOnly,
        initialize: async (id, current) => db.query('UPDATE "EmailAccount" SET "lastSyncedHistoryId" = $1 WHERE id = $2 AND ("lastSyncedHistoryId" IS NULL OR "lastSyncedHistoryId" = \'\')', [current, id]),
        notify: async (target, current) => {
          const endpoint = new URL('/api/google/webhook', env.INTERNAL_API_URL || 'http://inbox-zero:3000');
          endpoint.searchParams.set('token', env.GOOGLE_PUBSUB_VERIFICATION_TOKEN);
          const response = await fetchImpl(endpoint, { method: 'POST', signal: AbortSignal.timeout(20000),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: target.email, historyId: current })).toString('base64'),
              messageId: 'poll-' + target.id + '-' + current, publishTime: new Date().toISOString() }, subscription: 'selfhosted-gmail-poll-fallback' }),
          });
          if (!response.ok) throw new PollError('internal-notification', response.status);
          const body = await response.json();
          if (body.ok !== true) throw new PollError('internal-notification-rejected');
        },
      });
      results.push(result);
    }
    console.log(JSON.stringify({ event: 'gmail-poll-complete', mode: checkOnly ? 'read-only' : 'active', accounts: results.length,
      initialized: checkOnly ? 0 : results.filter(r => r.action === 'initialize').length, baselineNeeded: results.filter(r => r.action === 'initialize').length, notified: results.filter(r => r.notified).length }));
    return results;
  } finally { await db.end(); }
}

// A CronJob still starts once per minute. Skip missed ticks after slow work so
// short polling never overlaps account processing or bursts after a delay.
export async function runPollingWindow({ poll, intervalMs = 15000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60000) {
    throw new Error('Polling interval must be between 5 and 60 seconds');
  }
  const start = now();
  const deadline = start + 60000;
  let next = start;
  while (next < deadline) {
    await sleep(Math.max(0, next - now()));
    if (now() >= deadline) break;
    await poll();
    next += intervalMs;
    if (next < now()) next = start + Math.ceil((now() - start) / intervalMs) * intervalMs;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const interval = process.argv.find(arg => arg.startsWith('--interval-seconds='));
  const poll = () => runPoller({ checkOnly: process.argv.includes('--check') });
  const run = interval ? runPollingWindow({ poll, intervalMs: Number(interval.split('=')[1]) * 1000 }) : poll();
  run.catch(error => {
    console.error(JSON.stringify({ event: 'gmail-poll-failed', stage: error.stage || 'runtime', status: error.status, code: error.code || error.name }));
    process.exitCode = 1;
  });
}
