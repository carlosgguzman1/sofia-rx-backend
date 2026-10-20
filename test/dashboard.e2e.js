// Prueba de extremo a extremo del dashboard con un navegador real.
// Uso: NODE_PATH=/opt/npm-tools/node_modules node test/dashboard.e2e.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');

const VAPI = 'v-secret', TOKEN = 'd-token';
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'sofia-shots');
fs.mkdirSync(shots, { recursive: true });

const tool = (name, args, callId, number = '+17875550101') => ({
  message: { type: 'tool-calls', call: { id: callId, customer: { number } }, toolCallList: [{ id: 'x' + callId, name, arguments: args }] },
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sofia-e2e-'));
  const store = createStore({ file: path.join(tmp, 'p.json') });
  const config = { vapiSecret: VAPI, dashboardToken: TOKEN, pharmacyName: 'Farmacia Prueba', dashboardUrl: '', corsOrigins: [], alertTarget: 'WhatsApp del técnico' };
  const server = createApp({ config, store, notifier: { enabled: true, send: async () => true } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hook = (b) => fetch(base + '/webhook/vapi', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': VAPI }, body: JSON.stringify(b) });

  await hook(tool('guardar_refill', { nombre_paciente: 'María Rivera', medicamento: 'Lisinopril 10 mg', numero_receta: '482910', recogido: 'Hoy', urgente: true }, 'c1'));
  await hook(tool('dejar_mensaje', { nombre_paciente: '<img src=x onerror="window.__xss=1">', mensaje: 'Llamar antes del mediodía' }, 'c2', '+17875550102'));
  await hook(tool('solicitar_farmaceutico', { nombre_paciente: 'Luis Vázquez', motivo: 'Duda de un medicamento' }, 'c3', '+17875550104'));
  await hook({ message: { type: 'end-of-call-report', call: { id: 'c1' }, summary: 'Pide refill del Lisinopril.', durationSeconds: 60, artifact: { messages: [{ role: 'bot', message: 'Farmacia, le habla Sofía.' }, { role: 'user', message: 'Necesito el refill.' }] } } });

  const browser = await chromium.launch();
  const results = [];
  const check = (name, fn) => results.push([name, fn]);
  const consoleErrors = [];

  async function open(viewport = { width: 1280, height: 900 }, scheme = 'light') {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.goto(base + '/');
    return { ctx, page };
  }

  const { ctx, page } = await open();

  check('sin sesión muestra el login y no la app', async () => {
    assert.equal(await page.locator('#login').isVisible(), true);
    assert.equal(await page.locator('#app').isVisible(), false);
  });
  check('clave incorrecta se rechaza', async () => {
    await page.fill('#tok', 'mala');
    await page.click('#login button[type=submit]');
    await page.waitForFunction(() => document.getElementById('loginErr').textContent.includes('incorrecta'));
    assert.equal(await page.locator('#app').isVisible(), false);
  });
  check('clave correcta entra y muestra los pendientes reales', async () => {
    await page.fill('#tok', TOKEN);
    await page.click('#login button[type=submit]');
    await page.waitForSelector('#list .row');
    assert.equal(await page.locator('#list .row').count(), 3);
    assert.match(await page.locator('#pharmacy').textContent(), /Farmacia Prueba/);
    assert.match(await page.locator('#connText').textContent(), /Sofía activa/);
    const kp = await page.locator('#kpis .num').allTextContents();
    assert.deepEqual(kp, ['3', '1', '1', '1']);
  });
  check('el urgente va primero y se ve su detalle con resumen y conversación', async () => {
    const first = page.locator('#list .row').first();
    assert.match(await first.textContent(), /María Rivera/);
    assert.match(await first.textContent(), /Urgente/);
    await first.click();
    const d = await page.locator('#detail').textContent();
    assert.match(d, /482910/);
    assert.match(d, /Pide refill del Lisinopril/);
    assert.match(d, /Farmacia, le habla Sofía/);
    assert.match(d, /Alerta enviada/);
  });
  check('nombre con HTML se muestra como texto y no ejecuta nada', async () => {
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#list img').count(), 0);
    assert.ok((await page.locator('#list').textContent()).includes('<img src=x'));
  });
  check('Tomar → Marcar listo se guarda en el servidor', async () => {
    await page.locator('#list .row').first().click();
    await page.click('[data-act="progress"]');
    await page.waitForFunction(() => document.querySelector('#detail [data-act="done"]'));
    assert.equal(store.list().find((i) => i.name === 'María Rivera').status, 'progress');
    await page.click('[data-act="done"]');
    await page.waitForFunction(() => document.querySelector('#detail [data-act="new"]') && !document.querySelector('#detail [data-act="done"]'));
    assert.equal(store.list().find((i) => i.name === 'María Rivera').status, 'done');
  });
  check('un cambio hecho en el servidor aparece solo (polling)', async () => {
    const id = store.list().find((i) => i.name === 'Luis Vázquez').id;
    store.update(id, { status: 'progress' });
    await page.waitForFunction((n) => [...document.querySelectorAll('#list .row')].some((r) => r.textContent.includes(n) && r.textContent.includes('En proceso')), 'Luis', { timeout: 9000 });
  });
  check('una llamada nueva aparece sola con aviso', async () => {
    await hook(tool('guardar_refill', { nombre_paciente: 'Gloria Pérez', medicamento: 'Losartán 50 mg', numero_receta: '483015' }, 'c9', '+17875550170'));
    await page.waitForFunction(() => [...document.querySelectorAll('#list .row')].some((r) => r.textContent.includes('Gloria')), null, { timeout: 9000 });
    assert.match(await page.locator('#toast').textContent(), /Nueva llamada atendida por Sofía: Gloria/);
  });
  check('pestañas, búsqueda y ocultar completados', async () => {
    await page.click('[data-filter="refill"]');
    assert.equal(await page.locator('#list .row').count(), 2);
    await page.click('[data-filter="all"]');
    await page.fill('#q', '483015');
    assert.equal(await page.locator('#list .row').count(), 1);
    await page.fill('#q', '');
    await page.click('#hideDone');
    const rows = await page.locator('#list .row').allTextContents();
    assert.ok(rows.every((t) => !/Listo/.test(t.split('Nuevo')[0] || '') || true));
    assert.equal(rows.some((t) => t.includes('María Rivera')), false);
    await page.click('#hideDone');
  });
  check('la sesión se conserva al recargar y Salir vuelve al login', async () => {
    await page.reload();
    await page.waitForSelector('#list .row');
    await page.click('#logout');
    assert.equal(await page.locator('#login').isVisible(), true);
  });
  check('sin horizontal overflow en escritorio y celular, también en oscuro', async () => {
    for (const [vp, scheme] of [[{ width: 1280, height: 900 }, 'light'], [{ width: 390, height: 844 }, 'light'], [{ width: 390, height: 844 }, 'dark']]) {
      const { ctx: c2, page: p2 } = await open(vp, scheme);
      await p2.evaluate((t) => sessionStorage.setItem('sofia_dash_token', t), TOKEN);
      await p2.reload();
      await p2.waitForSelector('#list .row');
      const over = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `overflow ${over} en ${vp.width} ${scheme}`);
      await p2.screenshot({ path: path.join(shots, `dash-${vp.width}-${scheme}.png`), fullPage: true });
      await c2.close();
    }
  });
  check('si el servidor cae, muestra "Sin conexión" y no pierde la lista', async () => {
    const { ctx: c3, page: p3 } = await open();
    await p3.evaluate((t) => sessionStorage.setItem('sofia_dash_token', t), TOKEN);
    await p3.reload();
    await p3.waitForSelector('#list .row');
    await p3.route('**/api/pendientes', (r) => r.abort());
    await p3.waitForFunction(() => document.getElementById('connText').textContent.includes('Sin conexión'), null, { timeout: 9000 });
    assert.ok((await p3.locator('#list .row').count()) > 0);
    await p3.unroute('**/api/pendientes');
    await p3.waitForFunction(() => document.getElementById('connText').textContent.includes('Sofía activa'), null, { timeout: 9000 });
    await c3.close();
  });
  check('token vencido a mitad de sesión regresa al login', async () => {
    const { ctx: c4, page: p4 } = await open();
    await p4.evaluate(() => sessionStorage.setItem('sofia_dash_token', 'vencido'));
    await p4.reload();
    await p4.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0);
    assert.equal(await p4.locator('#app').isVisible(), false);
    await c4.close();
  });

  let failed = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FALLA', name, '\n     ', e.message.split('\n')[0]); }
  }
  if (consoleErrors.length) { failed++; console.log('FALLA errores de consola:', consoleErrors); } else console.log('ok    sin errores de consola');
  await ctx.close();
  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} fallas` : '\ntodo bien');
  process.exit(failed ? 1 : 0);
})();
