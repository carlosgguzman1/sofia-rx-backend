'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const { createTwilioNotifier, buildAlertText } = require('../src/notifier');

const VAPI = 'vapi-secret-test';
const TOKEN = 'dash-token-test';
let server, base, store, alerts, tmp, notifier;

function makeConfig(over = {}) {
  return { vapiSecret: VAPI, dashboardToken: TOKEN, pharmacyName: 'Farmacia Prueba', dashboardUrl: 'https://x.test', corsOrigins: ['https://sofia.vercel.app'], alertTarget: 'WhatsApp', ...over };
}
async function start(config = makeConfig(), notifierOverride) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sofia-'));
  store = createStore({ file: path.join(tmp, 'p.json') });
  alerts = [];
  notifier = notifierOverride || { enabled: true, send: async (item) => { alerts.push(item); return true; } };
  server = createApp({ config, store, notifier });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
const hook = (body, secret = VAPI) =>
  fetch(base + '/webhook/vapi', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-vapi-secret': secret } : {}) }, body: JSON.stringify(body) });
const toolMsg = (name, args, { callId = 'call-1', id = 't1', number = '+17875550101', stringArgs = false } = {}) => ({
  message: { type: 'tool-calls', call: { id: callId, customer: { number } }, toolCallList: [{ id, name, arguments: stringArgs ? JSON.stringify(args) : args }] },
});
const api = (p, opts = {}, token = TOKEN) =>
  fetch(base + p, { ...opts, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', ...(opts.headers || {}) } });

before(() => start());
after(() => stop());
beforeEach(() => { alerts.length = 0; });

test('health responde y no exige clave', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.equal(j.configured, true);
});

test('webhook rechaza sin clave o con clave incorrecta', async () => {
  assert.equal((await hook(toolMsg('guardar_refill', {}), null)).status, 401);
  assert.equal((await hook(toolMsg('guardar_refill', {}), 'otra')).status, 401);
});

test('guardar_refill crea pendiente, formatea teléfono, devuelve toolCallId y alerta una vez', async () => {
  const r = await hook(toolMsg('guardar_refill', { nombre_paciente: 'María Rivera', medicamento: 'Lisinopril 10 mg', numero_receta: '482910', recogido: 'Hoy en la tarde', urgente: true }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.results[0].toolCallId, 't1');
  assert.match(j.results[0].result, /Refill registrado para María Rivera/);
  assert.equal(typeof j.results[0].result, 'string');
  const list = (await (await api('/api/pendientes')).json()).items;
  assert.equal(list.length, 1);
  const it = list[0];
  assert.equal(it.type, 'refill');
  assert.equal(it.status, 'new');
  assert.equal(it.urgent, true);
  assert.equal(it.phone, '787-555-0101');
  assert.equal(it.rx, '482910');
  assert.ok(it.alertSentAt, 'marca la alerta como enviada');
  assert.equal(it.key, undefined, 'no expone campos internos');
  assert.equal(it.callId, undefined);
  assert.equal(alerts.length, 1);
});

test('argumentos como string JSON funcionan y un reintento no duplica ni vuelve a alertar', async () => {
  const args = { nombre_paciente: 'José Colón', medicamento: 'Metformina 500 mg', numero_receta: '482877' };
  await hook(toolMsg('guardar_refill', args, { callId: 'c2', stringArgs: true }));
  await hook(toolMsg('guardar_refill', { ...args, recogido: 'Mañana' }, { callId: 'c2', stringArgs: true }));
  const items = (await (await api('/api/pendientes')).json()).items.filter((i) => i.name === 'José Colón');
  assert.equal(items.length, 1);
  assert.equal(items[0].pickup, 'Mañana');
  assert.equal(alerts.length, 1);
});

test('faltan datos: no crea pendiente y le dice a Sofía qué pedir', async () => {
  const before = store.list().length;
  const j = await (await hook(toolMsg('guardar_refill', { nombre_paciente: 'Ana' }, { callId: 'c3' }))).json();
  assert.match(j.results[0].result, /Falta: medicamento/);
  assert.equal(store.list().length, before);
  assert.equal(alerts.length, 0);
});

test('verificar_receta no confirma estado y crea mensaje para el equipo', async () => {
  const j = await (await hook(toolMsg('verificar_receta', { nombre_paciente: 'Carmen Ortiz', numero_receta: '555', pregunta: 'si el plan la aprobó' }, { callId: 'c4' }))).json();
  assert.match(j.results[0].result, /No diga si la receta está aprobada/);
  const it = store.list().find((i) => i.name === 'Carmen Ortiz');
  assert.equal(it.type, 'message');
  assert.match(it.msg, /Verificar receta 555: si el plan la aprobó/);
});

test('verificar_receta no exige número de receta: basta lo que el paciente quiere saber', async () => {
  let j = await (await hook(toolMsg('verificar_receta', { nombre_paciente: 'X' }, { callId: 'c5' }))).json();
  assert.match(j.results[0].result, /qué quiere saber/);
  j = await (await hook(toolMsg('verificar_receta', { nombre_paciente: 'Sin Número', pregunta: 'si ya llegó mi receta nueva' }, { callId: 'c5b' }))).json();
  assert.match(j.results[0].result, /Solicitud anotada/);
  assert.match(store.list().find((i) => i.name === 'Sin Número').msg, /Verificar receta: si ya llegó mi receta nueva/);
});

test('guardar_refill funciona sin número de receta', async () => {
  const j = await (await hook(toolMsg('guardar_refill', { nombre_paciente: 'Sin Receta', medicamento: 'Metformina 500 mg', recogido: 'Mañana' }, { callId: 'c5c' }))).json();
  assert.match(j.results[0].result, /Refill registrado/);
  const it = store.list().find((i) => i.name === 'Sin Receta');
  assert.equal(it.rx, '');
  assert.equal(it.med, 'Metformina 500 mg');
});

test('solicitar_farmaceutico crea transferida y end-of-call agrega resumen, conversación y duración', async () => {
  await hook(toolMsg('solicitar_farmaceutico', { nombre_paciente: 'Luis Vázquez', motivo: 'Duda de un medicamento nuevo' }, { callId: 'c6', number: '+17875550104' }));
  const eoc = {
    message: {
      type: 'end-of-call-report',
      call: { id: 'c6', customer: { number: '+17875550104' } },
      durationSeconds: 161,
      summary: 'El paciente tenía una duda y pidió hablar con el farmacéutico.',
      artifact: { messages: [
        { role: 'system', message: 'prompt oculto' },
        { role: 'bot', message: 'Farmacia, le habla Sofía.' },
        { role: 'user', message: 'Quiero hablar con el farmacéutico.' },
        { role: 'tool', message: '{}' },
      ] },
    },
  };
  assert.equal((await hook(eoc)).status, 200);
  const it = store.list().find((i) => i.callId === 'c6');
  assert.equal(it.type, 'transfer');
  assert.equal(it.duration, '2:41');
  assert.match(it.summary, /duda/);
  assert.deepEqual(it.transcript, [['S', 'Farmacia, le habla Sofía.'], ['P', 'Quiero hablar con el farmacéutico.']]);
});

test('dejar_mensaje usa el teléfono dado si es válido, si no el de quien llama', async () => {
  await hook(toolMsg('dejar_mensaje', { nombre_paciente: 'Pedro', mensaje: 'Llamar antes del mediodía', telefono: '787 555 0199' }, { callId: 'c7' }));
  await hook(toolMsg('dejar_mensaje', { nombre_paciente: 'Pedra', mensaje: 'Otra cosa', telefono: '12' }, { callId: 'c8', number: '+17875550188' }));
  const list = store.list();
  assert.equal(list.find((i) => i.name === 'Pedro').phone, '787-555-0199');
  assert.equal(list.find((i) => i.name === 'Pedra').phone, '787-555-0188');
});

test('herramienta desconocida y formato legacy function-call', async () => {
  const j = await (await hook(toolMsg('borrar_todo', {}, { callId: 'c9' }))).json();
  assert.match(j.results[0].result, /desconocida/);
  const legacy = await (await hook({ message: { type: 'function-call', call: { id: 'c10' }, functionCall: { name: 'dejar_mensaje', parameters: { nombre_paciente: 'Leg', mensaje: 'hola' } } } })).json();
  assert.match(legacy.result, /Mensaje anotado/);
});

test('texto largo y HTML se guardan acotados (el dashboard los escapa al mostrar)', async () => {
  await hook(toolMsg('dejar_mensaje', { nombre_paciente: '<img src=x onerror=alert(1)>', mensaje: 'a'.repeat(5000) }, { callId: 'c11' }));
  const it = store.list().find((i) => i.callId === 'c11');
  assert.ok(it.msg.length <= 400);
});

test('API del dashboard exige token', async () => {
  assert.equal((await api('/api/pendientes', {}, null)).status, 401);
  assert.equal((await api('/api/pendientes', {}, 'mal')).status, 401);
  assert.equal((await api('/api/pendientes')).status, 200);
});

test('PATCH cambia estado, valida estado e id', async () => {
  const id = store.list()[0].id;
  let r = await api('/api/pendientes/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'progress' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'progress');
  assert.equal(store.get(id).status, 'progress');
  r = await api('/api/pendientes/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'borrado' }) });
  assert.equal(r.status, 400);
  r = await api('/api/pendientes/noexiste', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(r.status, 404);
  r = await api('/api/pendientes/' + id, { method: 'PATCH', body: '{no json' });
  assert.equal(r.status, 400);
});

test('CORS solo para el origen configurado', async () => {
  let r = await fetch(base + '/api/pendientes', { method: 'OPTIONS', headers: { origin: 'https://sofia.vercel.app' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://sofia.vercel.app');
  r = await fetch(base + '/api/pendientes', { method: 'OPTIONS', headers: { origin: 'https://malo.test' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('el dashboard se sirve en / con CSP', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await r.text(), /Sofía RX/);
});

test('cuerpo gigante se rechaza', async () => {
  const r = await hook({ message: { type: 'x', pad: 'a'.repeat(1100 * 1024) } }).catch(() => ({ status: 'cerrada' }));
  assert.ok(r.status === 413 || r.status === 'cerrada');
});

test('si la alerta falla, el pendiente se guarda igual y Sofía recibe respuesta', async () => {
  await stop();
  await start(makeConfig(), { enabled: true, send: async () => { throw new Error('twilio caído'); } });
  const j = await (await hook(toolMsg('dejar_mensaje', { nombre_paciente: 'Z', mensaje: 'm' }, { callId: 'f1' }))).json();
  assert.match(j.results[0].result, /Mensaje anotado/);
  const it = store.list()[0];
  assert.equal(it.alertSentAt, null);
});

test('sin claves configuradas el servidor falla cerrado (503)', async () => {
  await stop();
  await start(makeConfig({ vapiSecret: '', dashboardToken: '' }));
  assert.equal((await hook(toolMsg('guardar_refill', {}), 'cualquiera')).status, 503);
  assert.equal((await api('/api/pendientes', {}, 'cualquiera')).status, 503);
});

test('los datos persisten en archivo y se purgan los vencidos', async () => {
  const file = path.join(tmp, 'persist.json');
  let t = Date.now();
  const s1 = createStore({ file, retentionDays: 30, now: () => t });
  const a = s1.add({ type: 'message', name: 'Viejo', msg: 'x', phone: '', callId: null, key: null });
  t += 40 * 86400000;
  const b = s1.add({ type: 'message', name: 'Nuevo', msg: 'y', phone: '', callId: null, key: null });
  const s2 = createStore({ file, retentionDays: 30, now: () => t });
  assert.equal(s2.get(a.id), null);
  assert.equal(s2.get(b.id).name, 'Nuevo');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('archivo de datos corrupto no tumba el servidor', () => {
  const file = path.join(tmp, 'corrupto.json');
  fs.writeFileSync(file, '{{{{');
  const s = createStore({ file });
  assert.equal(s.list().length, 0);
});

test('notificador Twilio arma la petición REST y respeta destinatarios', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201 }; };
  const n = createTwilioNotifier({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_WHATSAPP_NUMBER: '+19395550000', ALERT_WHATSAPP_TO: '+17875550001, +17875550002' }, fakeFetch);
  assert.equal(n.enabled, true);
  const ok = await n.send({ type: 'refill', name: 'María', phone: '787-555-0101', urgent: true }, { pharmacyName: 'Farmacia X', dashboardUrl: 'https://d.test' });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /Accounts\/ACtest\/Messages\.json$/);
  assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('ACtest:tok').toString('base64'));
  const form = new URLSearchParams(calls[0].opts.body);
  assert.equal(form.get('From'), 'whatsapp:+19395550000');
  assert.equal(form.get('To'), 'whatsapp:+17875550001');
  assert.match(form.get('Body'), /URGENTE/);
  assert.doesNotMatch(form.get('Body'), /Lisinopril/);
  assert.equal(createTwilioNotifier({}).enabled, false);
  assert.equal(await createTwilioNotifier({}).send({}, {}), false);
  assert.match(buildAlertText({ type: 'transfer', name: 'Luis', urgent: false }, { pharmacyName: 'F', dashboardUrl: '' }), /Pasada al farmacéutico: Luis/);
});

test('con plantilla aprobada (TWILIO_CONTENT_SID) envía ContentSid y variables, sin texto libre', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push(new URLSearchParams(opts.body)); return { ok: true, status: 201 }; };
  const n = createTwilioNotifier({ TWILIO_ACCOUNT_SID: 'ACt', TWILIO_AUTH_TOKEN: 't', TWILIO_WHATSAPP_NUMBER: '+19395550000', ALERT_WHATSAPP_TO: '+17875550001', TWILIO_CONTENT_SID: 'HX123' }, fakeFetch);
  await n.send({ type: 'message', name: 'Pedro', phone: '787-555-0106', urgent: true }, { pharmacyName: 'F', dashboardUrl: 'https://d.test' });
  assert.equal(calls[0].get('ContentSid'), 'HX123');
  assert.equal(calls[0].get('Body'), null);
  assert.deepEqual(JSON.parse(calls[0].get('ContentVariables')), { 1: 'URGENTE · Mensaje', 2: 'Pedro', 3: '787-555-0106', 4: 'https://d.test' });
});
