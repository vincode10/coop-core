// lint-syntax.js — fail fast on any module that doesn't parse (`node --check`).
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const files = fs.readdirSync(__dirname + '/..').filter(f => f.endsWith('.js'));
for (const f of files) execFileSync(process.execPath, ['--check', __dirname + '/../' + f]);
console.log(`✓ syntax ok — ${files.length} modules parse cleanly`);
