'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, toE164 } = require('../scripts/generar-asistente');
const template = require('../vapi-assistant.json');

const ok = { farmacia: 'Farmacia Ñandú', horario: 'L-V 8 a 6', url: 'https://sofia.up.railway.app/', secret: 'a'.repeat(24), voz: 'voz123', recetario: '787-555-0100' };

test('genera un asistente sin marcadores pendientes y con todos los valores', () => {
  const a = build(ok, template);
  const txt = JSON.stringify(a);
  assert.doesNotMatch(txt, /REEMPLAZAR|\[NOMBRE DE LA FARMACIA\]|\[HORARIO\]/);
  assert.equal(a.name, 'Sofía RX — Farmacia Ñandú');
  assert.equal(a.voice.voiceId, 'voz123');
  assert.equal(a.server.url, 'https://sofia.up.railway.app/webhook/vapi');
  assert.equal(a.server.secret, ok.secret);
  const fns = a.model.tools.filter((t) => t.type === 'function');
  assert.ok(fns.every((t) => t.server.url === 'https://sofia.up.railway.app/webhook/vapi' && t.server.secret === ok.secret));
  assert.equal(a.model.tools.find((t) => t.type === 'transferCall').destinations[0].number, '+17875550100');
  assert.match(a.model.messages[0].content, /Farmacia Ñandú/);
  assert.match(a.firstMessage, /Farmacia Ñandú/);
});

test('no modifica la plantilla original', () => {
  build(ok, template);
  assert.match(JSON.stringify(template), /REEMPLAZAR/);
});

test('valida entradas', () => {
  assert.throws(() => build({ ...ok, url: 'http://inseguro.com' }, template), /https/);
  assert.throws(() => build({ ...ok, recetario: '123' }, template), /10 dígitos/);
  assert.throws(() => build({ ...ok, secret: 'corta' }, template), /16/);
  assert.throws(() => build({ farmacia: 'x' }, template), /Faltan/);
});

test('teléfonos a formato E.164', () => {
  assert.equal(toE164('(787) 555-0100'), '+17875550100');
  assert.equal(toE164('+1 787 555 0100'), '+17875550100');
  assert.equal(toE164('555'), null);
});
