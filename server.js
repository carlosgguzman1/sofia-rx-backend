'use strict';
// Sin dependencias. En local: node --env-file=.env server.js  (Node 20.6+)
const { createApp, loadConfig } = require('./src/app');
const { createStore } = require('./src/store');
const { createTwilioNotifier } = require('./src/notifier');

// Compatibilidad con los nombres de variables de la versión anterior (Railway ya las tiene)
const E = process.env;
E.TWILIO_WHATSAPP_NUMBER = E.TWILIO_WHATSAPP_NUMBER || E.TWILIO_WHATSAPP_FROM || '';
E.ALERT_WHATSAPP_TO = E.ALERT_WHATSAPP_TO || [...new Set([E.TECNICO_PHONE, E.FARMACEUTICO_PHONE].filter(Boolean))].join(',');

const config = loadConfig(process.env);
const store = createStore({
  file: process.env.DATA_FILE || './data/pendientes.json',
  retentionDays: Number(process.env.RETENTION_DAYS) || 30,
});
const notifier = createTwilioNotifier(process.env);

if (!config.vapiSecret) console.warn('Falta VAPI_SECRET: el webhook de Vapi responderá 503.');
if (!config.dashboardToken) console.warn('Falta DASHBOARD_TOKEN: la API del dashboard responderá 503.');
if (!notifier.enabled) console.warn('Alertas de WhatsApp desactivadas (faltan variables de Twilio o ALERT_WHATSAPP_TO).');

const PORT = process.env.PORT || 3000;
createApp({ config, store, notifier }).listen(PORT, () => console.log(`Sofía RX — ${config.pharmacyName} — puerto ${PORT}`));
