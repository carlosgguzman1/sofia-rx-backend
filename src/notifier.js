'use strict';

const TYPE_LABEL = { refill: 'Refill', message: 'Mensaje', transfer: 'Pasada al farmacéutico' };

/** Texto de la alerta. Sin datos clínicos: el detalle se ve en el dashboard. */
function buildAlertText(item, { pharmacyName, dashboardUrl }) {
  const lines = [
    `${item.urgent ? '🚨 URGENTE — ' : ''}Sofía RX · ${pharmacyName}`,
    `${TYPE_LABEL[item.type] || 'Pendiente'}: ${item.name || 'Paciente'}`,
  ];
  if (item.phone) lines.push(`Tel: ${item.phone}`);
  lines.push(dashboardUrl ? `Detalle: ${dashboardUrl}` : 'Abra el dashboard para ver el detalle.');
  return lines.join('\n');
}

/** Variables de la plantilla de WhatsApp. */
function templateVars(item, { pharmacyName, dashboardUrl }) {
  return {
    1: `${item.urgent ? 'URGENTE · ' : ''}${TYPE_LABEL[item.type] || 'Pendiente'}`,
    2: item.name || 'Paciente',
    3: item.phone || 'sin número',
    4: dashboardUrl || pharmacyName || 'dashboard',
  };
}

/**
 * Alertas por WhatsApp usando la API REST de Twilio (sin SDK).
 * Si faltan variables, queda desactivado y send() devuelve false.
 * `fetchImpl` se puede inyectar para pruebas.
 */
function createTwilioNotifier(env, fetchImpl = globalThis.fetch) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, ALERT_WHATSAPP_TO, TWILIO_CONTENT_SID } = env;
  const recipients = (ALERT_WHATSAPP_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const enabled = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_NUMBER && recipients.length);

  return {
    enabled,
    async send(item, ctx) {
      if (!enabled) return false;
      // WhatsApp solo permite texto libre dentro de las 24 h posteriores a un mensaje del destinatario.
      // Para alertas confiables usa una plantilla aprobada (TWILIO_CONTENT_SID) con 4 variables: {{1}} tipo, {{2}} nombre, {{3}} teléfono, {{4}} enlace.
      const fields = TWILIO_CONTENT_SID
        ? {
            ContentSid: TWILIO_CONTENT_SID,
            ContentVariables: JSON.stringify(templateVars(item, ctx)),
          }
        : { Body: buildAlertText(item, ctx) };
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      let ok = false;
      for (const to of recipients) {
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`, To: `whatsapp:${to}`, ...fields }).toString(),
          });
          if (res.ok) ok = true;
          else console.error('Twilio respondió', res.status, (typeof res.text === 'function' ? (await res.text()).slice(0, 300) : ''));
        } catch (err) {
          console.error('Error enviando alerta de WhatsApp:', err.message);
        }
      }
      return ok;
    },
  };
}

module.exports = { createTwilioNotifier, buildAlertText, templateVars };
