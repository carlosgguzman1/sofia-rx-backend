'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 2000;
const STATUSES = ['new', 'progress', 'done'];

/**
 * Almacén de pendientes: en memoria + archivo JSON (escritura atómica).
 * Para varios locales o más volumen, reemplazar por una base de datos
 * manteniendo la misma interfaz: list, get, add, update, findByKey.
 */
function createStore({ file, retentionDays = 30, now = Date.now } = {}) {
  let items = [];

  function purge() {
    const cutoff = now() - retentionDays * 86400000;
    items = items.filter((it) => it.createdAt >= cutoff);
    if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('No se pudo guardar el archivo de datos:', err.message);
    }
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) items = parsed;
    } catch (err) {
      console.error('Archivo de datos ilegible, se empieza vacío:', err.message);
    }
    purge();
  }

  load();

  return {
    list() {
      return items.slice().sort((a, b) => b.createdAt - a.createdAt);
    },
    get(id) {
      return items.find((it) => it.id === id) || null;
    },
    findByKey(key) {
      return key ? items.find((it) => it.key === key) || null : null;
    },
    findByCall(callId, type) {
      if (!callId) return [];
      return items.filter((it) => it.callId === callId && (!type || it.type === type));
    },
    add(data) {
      const item = {
        id: crypto.randomBytes(6).toString('hex'),
        status: 'new',
        urgent: false,
        createdAt: now(),
        alertSentAt: null,
        transcript: [],
        ...data,
      };
      items.unshift(item);
      purge();
      save();
      return item;
    },
    update(id, patch) {
      const idx = items.findIndex((it) => it.id === id);
      if (idx < 0) return null;
      items[idx] = { ...items[idx], ...patch };
      save();
      return items[idx];
    },
  };
}

module.exports = { createStore, STATUSES };
