'use strict';
// Simula una llamada de Vapi contra tu servidor (local o Railway) para ver aparecer el pendiente en el dashboard.
// Uso: BASE_URL=https://tu-app.up.railway.app VAPI_SECRET=xxx node scripts/simular-llamada.js [refill|mensaje|farmaceutico]
const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.VAPI_SECRET;
if (!secret) { console.error('Falta VAPI_SECRET'); process.exit(1); }

const kind = process.argv[2] || 'refill';
const callId = 'sim-' + Date.now();
const samples = {
  refill: ['guardar_refill', { nombre_paciente: 'Paciente de Prueba', medicamento: 'Lisinopril 10 mg', recogido: 'Hoy en la tarde', urgente: false }],
  mensaje: ['dejar_mensaje', { nombre_paciente: 'Paciente de Prueba', mensaje: 'Prueba: que me devuelvan la llamada.' }],
  farmaceutico: ['solicitar_farmaceutico', { nombre_paciente: 'Paciente de Prueba', motivo: 'Prueba de transferencia' }],
};
const [name, args] = samples[kind] || samples.refill;
const call = { id: callId, customer: { number: '+17875550100' } };

(async () => {
  const post = async (message) => {
    const r = await fetch(base + '/webhook/vapi', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vapi-secret': secret }, body: JSON.stringify({ message }) });
    return { status: r.status, body: await r.text() };
  };
  console.log('tool-calls →', await post({ type: 'tool-calls', call, toolCallList: [{ id: 't1', name, arguments: args }] }));
  console.log('end-of-call-report →', await post({
    type: 'end-of-call-report', call, durationSeconds: 42, summary: 'Llamada de prueba simulada.',
    artifact: { messages: [{ role: 'bot', message: 'Farmacia, le habla Sofía. ¿En qué le puedo ayudar?' }, { role: 'user', message: 'Es una prueba.' }] },
  }));
})();
