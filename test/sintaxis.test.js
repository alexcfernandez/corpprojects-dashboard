// test/sintaxis.test.js — Todos los archivos del servidor y del navegador se pueden cargar (sin errores de sintaxis).
// Un error así no lo cazan los demás tests si nadie requiere ese archivo, y Railway no arranca (healthcheck falla).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const js = d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => path.join(d, f));
test('node --check en src/, public/ y public/modules/', () => {
  const malos = [];
  for (const f of [...js('src'), ...js('public'), ...(fs.existsSync(path.join(root, 'public/modules')) ? js('public/modules') : [])]) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) malos.push(`${f}: ${(r.stderr || '').split('\n').find(l => /Error/.test(l)) || 'error'}`);
  }
  assert.deepEqual(malos, []);
});
