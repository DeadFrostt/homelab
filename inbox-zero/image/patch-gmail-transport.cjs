'use strict';
const fs = require('node:fs');
const { patchAdapterSource, ADAPTER_MANAGED } = require('./gmail-pacing.cjs');
const path = '/app/apps/web/.next/server/chunks';
let count = 0;
for (const file of fs.readdirSync(path)) {
  if (!file.endsWith('.js')) continue;
  const target = path + '/' + file;
  const source = fs.readFileSync(target, 'utf8');
  const patched = patchAdapterSource(source);
  if (patched.includes(ADAPTER_MANAGED)) count++;
  if (patched !== source) fs.writeFileSync(target, patched);
}
if (!count) throw new Error('No matching bundled Gmail transport; refusing unpaced image');
console.log('Patched bundled Gaxios transport files:', count);
