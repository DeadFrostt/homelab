const base = process.env.INTERNAL_API_URL;
const endpoints = process.argv.slice(2);
if (!base || !process.env.CRON_SECRET || !endpoints.length) process.exit(1);
// Recreate rollouts briefly remove the only web endpoint. Wait for readiness
// rather than exhausting the Job's retries during routine maintenance.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(base + '/api/health', {
      headers: { 'x-health-api-key': process.env.HEALTH_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!ready) { console.error('Web readiness deadline exceeded'); process.exit(1); }
for (const endpoint of endpoints) {
  const response = await fetch(base + endpoint, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(180000),
  });
  // Never log response bodies: some maintenance results contain mailbox data.
  console.log(JSON.stringify({ endpoint, status: response.status }));
  if (!response.ok) process.exit(1);
}
