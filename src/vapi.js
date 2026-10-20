'use strict';

/* ------------------------------------------------------------------
   Utilidades de limpieza
   ------------------------------------------------------------------ */
function clean(v, max = 300) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function truthy(v) {
  return v === true || (typeof v === 'string' && ['true', 'si', 'sí', 'yes', '1'].includes(v.trim().toLowerCase()));
}

/** +17875550101 -> 787-555-0101. Si no es un número de 10 dígitos, se devuelve limpio. */
function fmtPhone(raw) {
  const s = clean(raw, 40);
  const digits = s.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length === 10) return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  return s;
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  if (typeof a === 'string') {
    try {
      const o = JSON.parse(a);
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

/** Vapi envía las llamadas a herramientas en formatos ligeramente distintos según la versión. */
function extractToolCalls(msg) {
  if (Array.isArray(msg.toolCallList) && msg.toolCallList.length) {
    return msg.toolCallList.map((c) => ({
      id: c.id,
      name: c.name || (c.function && c.function.name),
      args: parseArgs(c.arguments !== undefined ? c.arguments : c.function && c.function.arguments),
    }));
  }
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
    return msg.toolCalls.map((c) => ({
      id: c.id,
      name: (c.function && c.function.name) || c.name,
      args: parseArgs(c.function ? c.function.arguments : c.arguments),
    }));
  }
  if (msg.functionCall) {
    return [{ id: msg.functionCall.id || 'function-call', name: msg.functionCall.name, args: parseArgs(msg.functionCall.parameters) }];
  }
  return [];
}

/* ------------------------------------------------------------------
   Herramientas de Sofía
   Cada una devuelve el texto que Sofía lee para saber qué decir.
   ------------------------------------------------------------------ */
const TOOLS = {
  guardar_refill: {
    type: 'refill',
    required: [['nombre_paciente', 'nombre del paciente'], ['medicamento', 'medicamento']],
    build(a) {
      return {
        name: clean(a.nombre_paciente, 80),
        med: clean(a.medicamento, 120),
        rx: clean(a.numero_receta, 40),
        pickup: clean(a.recogido, 120),
        msg: '',
      };
    },
    keyPart: (d) => d.rx || d.med.toLowerCase(),
    ok: (d) =>
      `Refill registrado para ${d.name}. Dígale que el equipo de la farmacia lo prepara y le avisa. No confirme que ya está listo ni una hora exacta.`,
  },
  verificar_receta: {
    type: 'message',
    required: [['nombre_paciente', 'nombre del paciente']],
    need: (a) => (clean(a.numero_receta) || clean(a.medicamento) || clean(a.pregunta) ? null : 'qué quiere saber el paciente o el medicamento'),
    build(a) {
      const rx = clean(a.numero_receta, 40);
      const med = clean(a.medicamento, 120);
      const q = clean(a.pregunta, 250);
      const what = [rx && `receta ${rx}`, med].filter(Boolean).join(' · ');
      return {
        name: clean(a.nombre_paciente, 80),
        rx,
        med,
        msg: `Verificar${what ? ' ' + what : ' receta'}${q ? ': ' + q : ''}`,
        pickup: '',
      };
    },
    keyPart: (d) => 'v:' + (d.rx || d.med.toLowerCase() || d.msg.toLowerCase().slice(0, 40)),
    ok: (d) =>
      `Solicitud anotada para ${d.name}. Un miembro del equipo verificará la receta y le devolverá la llamada. No diga si la receta está aprobada, lista o vigente.`,
  },
  solicitar_farmaceutico: {
    type: 'transfer',
    required: [],
    build(a) {
      return {
        name: clean(a.nombre_paciente, 80) || 'Paciente',
        msg: clean(a.motivo, 250) || 'Quiere hablar con el farmacéutico.',
        rx: '',
        med: '',
        pickup: '',
      };
    },
    keyPart: () => 'transfer',
    ok: () => 'El equipo ya fue avisado. Dígale al paciente que lo va a comunicar con el recetario y proceda a transferir la llamada.',
  },
  dejar_mensaje: {
    type: 'message',
    required: [['nombre_paciente', 'nombre del paciente'], ['mensaje', 'mensaje']],
    build(a) {
      return { name: clean(a.nombre_paciente, 80), msg: clean(a.mensaje, 400), rx: '', med: '', pickup: '' };
    },
    keyPart: (d) => 'm:' + d.msg.toLowerCase().slice(0, 40),
    ok: (d) => `Mensaje anotado para ${d.name}. Dígale que el equipo de la farmacia le devolverá la llamada.`,
  },
};

async function handleToolCall(call, ctx, deps) {
  const tool = TOOLS[call.name];
  if (!tool) return { result: `Herramienta desconocida: ${clean(call.name, 60)}.` };

  const a = call.args;
  const missing = tool.required.filter(([k]) => !clean(a[k])).map(([, label]) => label);
  if (tool.need) {
    const m = tool.need(a);
    if (m) missing.push(m);
  }
  if (missing.length) {
    return { result: `No se pudo guardar. Falta: ${missing.join(', ')}. Pídaselo al paciente con amabilidad.` };
  }

  const data = tool.build(a);
  const phone = fmtPhone(a.telefono && clean(a.telefono).replace(/\D/g, '').length >= 10 ? a.telefono : ctx.callerPhone);
  const urgent = truthy(a.urgente);
  const key = ctx.callId ? `${ctx.callId}:${call.name}:${tool.keyPart(data)}` : null;

  // Si Vapi reintenta la misma llamada, se actualiza en lugar de duplicar.
  const existing = deps.store.findByKey(key);
  if (existing) {
    deps.store.update(existing.id, { ...data, phone, urgent: existing.urgent || urgent });
    return { result: tool.ok(data) };
  }

  const item = deps.store.add({ ...data, type: tool.type, phone, urgent, callId: ctx.callId || null, key });
  try {
    const sent = await deps.notify(item);
    if (sent) deps.store.update(item.id, { alertSentAt: Date.now() });
  } catch (err) {
    console.error('Alerta fallida:', err.message);
  }
  return { result: tool.ok(data), item };
}

/* ------------------------------------------------------------------
   Reporte de fin de llamada: agrega resumen, conversación y duración
   ------------------------------------------------------------------ */
function buildTranscript(msg) {
  const list = (msg.artifact && msg.artifact.messages) || msg.messages || [];
  const out = [];
  for (const m of list) {
    const role = m.role;
    const text = clean(m.message !== undefined ? m.message : m.content, 600);
    if (!text) continue;
    if (role === 'bot' || role === 'assistant') out.push(['S', text]);
    else if (role === 'user') out.push(['P', text]);
  }
  return out.slice(0, 80);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function handleEndOfCall(msg, deps) {
  const call = msg.call || {};
  const items = deps.store.findByCall(call.id);
  if (!items.length) return 0;

  const summary = clean(msg.summary || (msg.analysis && msg.analysis.summary) || (msg.artifact && msg.artifact.summary), 800);
  const transcript = buildTranscript(msg);
  let seconds = msg.durationSeconds;
  if (seconds === undefined && call.startedAt && call.endedAt) {
    seconds = (new Date(call.endedAt) - new Date(call.startedAt)) / 1000;
  }
  const phone = fmtPhone(call.customer && call.customer.number);

  for (const it of items) {
    const patch = { transcript, summary: summary || it.summary || '' };
    if (!it.phone && phone) patch.phone = phone;
    if (it.type === 'transfer' && seconds !== undefined && !Number.isNaN(Number(seconds))) patch.duration = fmtDuration(seconds);
    deps.store.update(it.id, patch);
  }
  return items.length;
}

/* ------------------------------------------------------------------
   Punto de entrada del webhook
   ------------------------------------------------------------------ */
async function handleWebhook(body, deps) {
  const msg = (body && body.message) || body || {};
  const call = msg.call || {};
  const ctx = { callId: call.id || null, callerPhone: call.customer && call.customer.number };

  if (msg.type === 'tool-calls' || msg.type === 'function-call') {
    const calls = extractToolCalls(msg);
    const results = [];
    for (const c of calls) {
      let r;
      try {
        r = await handleToolCall(c, ctx, deps);
      } catch (err) {
        console.error(`Error en ${c.name}:`, err);
        r = { result: 'Hubo un problema técnico al guardar. Dígale al paciente que el equipo de la farmacia lo llamará.' };
      }
      results.push({ toolCallId: c.id, result: r.result });
    }
    return msg.type === 'function-call' ? { result: results[0] ? results[0].result : '' } : { results };
  }

  if (msg.type === 'end-of-call-report') {
    handleEndOfCall(msg, deps);
  }
  return {};
}

module.exports = { handleWebhook, handleToolCall, handleEndOfCall, fmtPhone, clean, extractToolCalls, TOOLS };
