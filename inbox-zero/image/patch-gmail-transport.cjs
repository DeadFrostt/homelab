'use strict';
const fs = require('node:fs');
const { patchRuntimeSource, ADAPTER_MANAGED, MAILBOX_GUARDED } = require('./gmail-pacing.cjs');
const path = '/app/apps/web/.next/server/chunks';
let count = 0;
let mailboxCount = 0;
for (const file of fs.readdirSync(path)) {
  if (!file.endsWith('.js')) continue;
  const target = path + '/' + file;
  const source = fs.readFileSync(target, 'utf8');
  const patched = patchRuntimeSource(source);
  if (patched.includes(ADAPTER_MANAGED)) count++;
  if (patched.includes(MAILBOX_GUARDED)) mailboxCount++;
  if (patched !== source) fs.writeFileSync(target, patched);
}
if (!count || !mailboxCount) throw new Error('No matching Gmail transport/mailbox source; refusing unprotected image');
console.log('Patched bundled Gaxios transport files:', count);
