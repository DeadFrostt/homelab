'use strict';
const fs = require('node:fs');
const path = '/app/apps/web/.next/server/chunks';
// Exact deployed Gaxios 7.3.0 adapter signature. Fail on incompatible images.
const before = 'async _defaultAdapter(e){let t=e.fetchImplementation';
const after = 'async _defaultAdapter(e){await globalThis[Symbol.for("inboxzero.gmailPacing")]?.(e.url,e);let t=e.fetchImplementation';
let count = 0;
for (const file of fs.readdirSync(path)) {
  if (!file.endsWith('.js')) continue;
  const target = path + '/' + file;
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(before)) continue;
  fs.writeFileSync(target, source.replaceAll(before, after));
  count++;
}
if (!count) throw new Error('No matching bundled Gmail transport; refusing unpaced image');
console.log('Patched bundled Gaxios transport files:', count);
