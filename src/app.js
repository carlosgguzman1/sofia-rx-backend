'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleWebhook } = require('./vapi');
const { STATUSES } = require('./store');

const MAX_BODY = 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

function loadConfig(env = process.env) {
  return {
    vapiSecret: env.VAPI_SECRET || '',
    dashboardToken: env.DASHBOARD_TOKEN || '',
    pharmacyName: env.PHARMACY_NAME || 'Farmacia',
    dashboardUrl: env.DASHBOARD_URL || '',
    corsOrigins: (env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
    alertTarget: 'WhatsApp del técnico de turno',
  };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function toPublic(it) {
  const { key, callId, ...rest } = it; // eslint-disable-line no-unused-vars
  return rest;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ config, store, notifier }) {
  const notify = async (item) => {
    if (!notifier || !notifier.enabled) return false;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    });
    try {
      return await Promise.race([
        notifier.send(item, { pharmacyName: config.pharmacyName, dashboardUrl: config.dashboardUrl }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    }
  }

  function authDashboard(req, res) {
    if (!config.dashboardToken) {
      send(res, 503, { error: 'DASHBOARD_TOKEN no configurado' });
      return false;
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !safeEqual(m[1], config.dashboardToken)) {
      send(res, 401, { error: 'No autorizado' });
      return false;
    }
    return true;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    /* Salud (healthcheck de Railway) */
    if (method === 'GET' && p === '/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'sofia-rx',
        whatsappAlerts: Boolean(notifier && notifier.enabled),
        configured: Boolean(config.vapiSecret && config.dashboardToken),
      });
    }

    /* Webhook de Vapi */
    if (method === 'POST' && (p === '/webhook/vapi' || p === '/webhook')) {
      if (!config.vapiSecret) return send(res, 503, { error: 'VAPI_SECRET no configurado' });
      if (!safeEqual(req.headers['x-vapi-secret'] || '', config.vapiSecret)) return send(res, 401, { error: 'No autorizado' });
      const body = await readJson(req);
      try {
        return send(res, 200, await handleWebhook(body, { store, notify }));
      } catch (err) {
        console.error('Error en webhook:', err);
        return send(res, 200, {});
      }
    }

    /* API del dashboard */
    if (p.startsWith('/api/')) {
      applyCors(req, res);
      if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (!authDashboard(req, res)) return undefined;
      res.setHeader('Cache-Control', 'no-store');

      if (method === 'GET' && p === '/api/pendientes') {
        return send(res, 200, {
          items: store.list().map(toPublic),
          pharmacyName: config.pharmacyName,
          alertTarget: config.alertTarget,
          serverTime: Date.now(),
        });
      }
      const m = /^\/api\/pendientes\/([A-Za-z0-9_-]{1,64})$/.exec(p);
      if (method === 'PATCH' && m) {
        const body = await readJson(req);
        if (!STATUSES.includes(body.status)) return send(res, 400, { error: 'Estado inválido' });
        const item = store.update(m[1], { status: body.status });
        if (!item) return send(res, 404, { error: 'No encontrado' });
        return send(res, 200, toPublic(item));
      }
      return send(res, 404, { error: 'No encontrado' });
    }

    /* Dashboard estático */
    if (method === 'GET' && p === '/config.js') {
      let js = 'window.SOFIA_CONFIG = { apiBase: "" };';
      try {
        js = fs.readFileSync(path.join(PUBLIC_DIR, 'config.js'), 'utf8');
      } catch (_) { /* usa el valor por defecto */ }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(js);
    }
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      let html;
      try {
        html = fs.readFileSync(INDEX_FILE, 'utf8');
      } catch (_) {
        return send(res, 404, { error: 'Dashboard no encontrado' });
      }
      return send(res, 200, html, {
        'Cache-Control': 'no-cache',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src *; frame-ancestors 'none'",
      });
    }

    return send(res, 404, { error: 'No encontrado' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      send(res, err.status || 500, { error: err.status ? err.message : 'Error interno' });
      if (!err.status) console.error(err);
    });
  });
}

module.exports = { createApp, loadConfig };
