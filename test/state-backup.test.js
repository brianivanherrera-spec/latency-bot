'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backupState } = require('../src/state-backup');

test('copia el estado chico, saltea análisis y grandes, guarda los últimos N', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  fs.writeFileSync(path.join(dir, 'paper-b.json'), '{"pnl":300}');
  fs.writeFileSync(path.join(dir, 'paper-b15-attempts-btc15m.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'shadow-ticks.jsonl'), 'x');
  fs.writeFileSync(path.join(dir, 'paper-b.json.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'grande.json'), Buffer.alloc(2 * 1024 * 1024));
  let r;
  for (let i = 0; i < 4; i++) r = backupState({ dataDir: dir, keep: 2, maxMb: 1, now: Date.UTC(2026, 10, 25, 20, i), env: {} });
  assert.deepStrictEqual(r.copied.sort(), ['paper-b.json', 'paper-b15-attempts-btc15m.jsonl']);
  assert.deepStrictEqual(r.skippedBig, ['grande.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dest, 'paper-b.json'), 'utf8')).pnl, 300);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backup')).length, 2);
  assert.deepStrictEqual(backupState({ dataDir: dir, env: { STATE_BACKUP: 'off' } }), { skipped: 'off' });
});
