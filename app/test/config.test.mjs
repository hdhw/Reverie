import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.REVERIE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-test-'));
const { load, save, validate, hashPassword, verifyPassword, generateAdminName } = await import('../lib/config.mjs');
const { explain } = await import('../lib/supervisor.mjs');

test('admin name has the Reverie User#NNNNN shape', () => {
  for (let i = 0; i < 50; i++) assert.match(generateAdminName(), /^Reverie User#\d{5}$/);
});

test('generated name and secrets persist across loads', () => {
  const a = load();
  const b = load();
  assert.equal(a.adminName, b.adminName);
  assert.equal(a.secrets.jwt, b.secrets.jwt);
  a.adminName = 'Custom';
  save(a);
  assert.equal(load().adminName, 'Custom');
});

test('passwords verify only with the right input', () => {
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', null));
});

test('validate catches bad ports and clashes', () => {
  const cfg = load();
  assert.deepEqual(validate(cfg), []);
  assert.ok(validate({ ...cfg, gamePort: 70000 }).length);
  assert.ok(validate({ ...cfg, panelPort: cfg.gamePort }).length);
  assert.ok(validate({ ...cfg, publicUrl: 'play.example.com' }).length);
});

test('known errors get plain-language explanations', () => {
  assert.match(explain('System.IO.IOException: Failed to bind to address http://0.0.0.0:5480'), /port/);
  assert.match(explain('FATAL: password authentication failed for user "reverie"'), /password/);
  assert.equal(explain('all good'), null);
});
