// Prueba el dashboard como se usará en Vercel: sitio estático en OTRO origen que el backend.
// Uso: NODE_PATH=/opt/npm-tools/node_modules node test/vercel.e2e.js
'use strict';
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');

const VAPI = 'v', TOKEN = 'tok-vercel';
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sofia-vercel-'));
  const store = createStore({ file: path.join(tmp, 'p.json') });

  // 1) Sitio estático (simula Vercel) en un puerto
  const site = path.join(tmp, 'site');
  const staticSrv = http.createServer((req, res) => {
    const f = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(site, f);
    if (!file.startsWith(site) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.html') ? 'text/html' : 'application/json';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => staticSrv.listen(0, '127.0.0.1', r));
  const siteOrigin = `http://127.0.0.1:${staticSrv.address().port}`;

  // 2) Backend en otro puerto con CORS solo para el sitio
  const config = { vapiSecret: VAPI, dashboardToken: TOKEN, pharmacyName: 'Farmacia Vercel', dashboardUrl: '', corsOrigins: [siteOrigin], alertTarget: 'WhatsApp' };
  const api = createApp({ config, store, notifier: { enabled: false } });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;

  // 3) Generar el paquete con el script real
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'preparar-vercel.js'), apiOrigin, site], { stdio: 'pipe' });
  for (const f of ['index.html', 'config.js', 'vercel.json']) assert.ok(fs.existsSync(path.join(site, f)), f);
  assert.match(fs.readFileSync(path.join(site, 'config.js'), 'utf8'), new RegExp(apiOrigin.replace(/\./g, '\\.')));
  JSON.parse(fs.readFileSync(path.join(site, 'vercel.json'), 'utf8'));
  assert.throws(() => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'preparar-vercel.js'), 'no-es-url', site], { stdio: 'pipe' }));

  await fetch(apiOrigin + '/webhook/vapi', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': VAPI },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'v1', customer: { number: '+17875550101' } }, toolCallList: [{ id: 't', name: 'guardar_refill', arguments: { nombre_paciente: 'Rosa Delgado', medicamento: 'Atorvastatina 20 mg', numero_receta: '482112' } }] } }),
  });

  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());

  let failed = 0;
  const step = async (n, fn) => { try { await fn(); console.log('ok   ', n); } catch (e) { failed++; console.log('FALLA', n, '\n     ', e.message.split('\n')[0]); } };

  await page.goto(siteOrigin + '/');
  await step('el sitio estático muestra el login', async () => { assert.equal(await page.locator('#login').isVisible(), true); });
  await step('login entre dominios (CORS) y lista el pendiente real', async () => {
    await page.fill('#tok', TOKEN);
    await page.click('#login button[type=submit]');
    await page.waitForSelector('#list .row', { timeout: 8000 });
    assert.match(await page.locator('#list').textContent(), /Rosa Delgado/);
    assert.match(await page.locator('#pharmacy').textContent(), /Farmacia Vercel/);
  });
  await step('Tomar pendiente entre dominios se guarda en el backend (PATCH + CORS)', async () => {
    await page.click('#list .row');
    await page.click('[data-act="progress"]');
    await page.waitForFunction(() => document.querySelector('#detail [data-act="done"]'));
    assert.equal(store.list()[0].status, 'progress');
  });
  await step('clave incorrecta en otro dominio se rechaza', async () => {
    const p2 = await (await browser.newContext()).newPage();
    await p2.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await p2.goto(siteOrigin + '/');
    await p2.fill('#tok', 'mala');
    await p2.click('#login button[type=submit]');
    await p2.waitForFunction(() => document.getElementById('loginErr').textContent.includes('incorrecta'));
  });
  await step('sin errores de consola', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  staticSrv.close(); api.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} fallas` : '\ntodo bien');
  process.exit(failed ? 1 : 0);
})();
