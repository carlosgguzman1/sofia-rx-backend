'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const a = require('../vapi-assistant.json');
const { TOOLS } = require('../src/vapi');

test('las herramientas del asistente de Vapi coinciden con las del backend', () => {
  const fns = a.model.tools.filter((t) => t.type === 'function');
  assert.deepEqual(fns.map((t) => t.function.name).sort(), Object.keys(TOOLS).sort());
  for (const t of fns) {
    const def = TOOLS[t.function.name];
    for (const [k] of def.required) {
      assert.ok(t.function.parameters.required.includes(k), `${t.function.name} debe exigir ${k}`);
    }
    for (const r of t.function.parameters.required) assert.ok(t.function.parameters.properties[r], `${r} definido`);
  }
  assert.ok(a.model.tools.some((t) => t.type === 'transferCall'));
  assert.ok(a.serverMessages.includes('end-of-call-report'));
});
