const base = process.env.INTERNAL_API_URL;
const endpoints = process.argv.slice(2);
if (!base || !process.env.CRON_SECRET || !endpoints.length) process.exit(1);
for (const endpoint of endpoints) {
  const response = await fetch(base + endpoint, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(180000),
  });
  // Never log response bodies: some maintenance results contain mailbox data.
  console.log(JSON.stringify({ endpoint, status: response.status }));
  if (!response.ok) process.exit(1);
}
