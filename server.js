require('dotenv').config();
const express = require("express");
const twilio = require("twilio");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── IN-MEMORY STORE ───────────────────────────────────────────────
let refills   = [];
let mensajes  = [];
let recetas   = [];
let llamadas  = [];
let idCounter = 1;

// ─── TWILIO CLIENT ─────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsApp(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.log("[WhatsApp SKIP - no credentials]", body);
    return;
  }
  try {
    await twilioClient.messages.create({
      from: "whatsapp:" + process.env.TWILIO_WHATSAPP_FROM,
      to:   "whatsapp:" + to,
      body,
    });
    console.log("[WhatsApp enviado a]", to);
  } catch (e) {
    console.error("[WhatsApp error]", e.message);
  }
}

function timestamp() {
  return new Date().toLocaleString("es-PR", {
    timeZone: "America/Puerto_Rico",
    hour: "2-digit", minute: "2-digit",
    month: "short", day: "numeric",
  });
}

// ─── VAPI WEBHOOK ──────────────────────────────────────────────────
// Vapi llama a POST /webhook cuando el AI activa un tool
app.post("/webhook", async (req, res) => {
  console.log("[Webhook recibido] tool:", req.body?.message?.toolCallList?.[0]?.name);

  // Vapi tool-calls format
  const toolCallList = req.body?.message?.toolCallList || [];

  if (!toolCallList.length) {
    return res.json({ results: [] });
  }

  const results = [];

  for (const toolCall of toolCallList) {
    const { id, name, arguments: args } = toolCall;
    let result = "OK";

    // ── guardar_refill ──
    if (name === "guardar_refill") {
      const item = {
        id: idCounter++,
        tipo: "refill",
        estado: "pendiente",
        nombre_paciente:  args.nombre_paciente  || "",
        fecha_nacimiento: args.fecha_nacimiento || "",
        medicamento:      args.medicamento      || "",
        cantidad:         args.cantidad         || "",
        notas:            args.notas            || "",
        timestamp:        timestamp(),
        ts_raw:           Date.now(),
      };
      refills.unshift(item);
      llamadas.unshift({ ...item, tipo: "refill" });

      const msg =
        `🔔 *NUEVO REFILL — SOFÍA RX*\n\n` +
        `👤 Paciente: ${item.nombre_paciente}\n` +
        `🎂 Nacimiento: ${item.fecha_nacimiento}\n` +
        `💊 Medicamento: ${item.medicamento}\n` +
        (item.cantidad ? `📦 Cantidad: ${item.cantidad}\n` : "") +
        (item.notas    ? `📝 Notas: ${item.notas}\n`    : "") +
        `⏰ ${item.timestamp}`;

      await sendWhatsApp(process.env.TECNICO_PHONE, msg);
      result = `Refill de ${item.medicamento} anotado para ${item.nombre_paciente}. Le avisamos cuando esté listo.`;
    }

    // ── verificar_receta ──
    else if (name === "verificar_receta") {
      const item = {
        id: idCounter++,
        tipo: "verificacion",
        estado: "pendiente",
        nombre_paciente:  args.nombre_paciente  || "",
        fecha_nacimiento: args.fecha_nacimiento || "",
        medicamento:      args.medicamento      || "",
        timestamp:        timestamp(),
        ts_raw:           Date.now(),
      };
      recetas.unshift(item);
      llamadas.unshift({ ...item, tipo: "verificacion" });

      const msg =
        `🔍 *VERIFICAR RECETA — SOFÍA RX*\n\n` +
        `👤 Paciente: ${item.nombre_paciente}\n` +
        `🎂 Nacimiento: ${item.fecha_nacimiento}\n` +
        `💊 Medicamento: ${item.medicamento}\n` +
        `⏰ ${item.timestamp}`;

      await sendWhatsApp(process.env.TECNICO_PHONE, msg);
      result = `Solicitud de verificación anotada para ${item.nombre_paciente}. Le confirmamos en unos minutos.`;
    }

    // ── solicitar_farmaceutico ──
    else if (name === "solicitar_farmaceutico") {
      const item = {
        id: idCounter++,
        tipo: "farmaceutico",
        estado: "pendiente",
        nombre_paciente: args.nombre_paciente || "",
        motivo:          args.motivo          || "",
        urgencia:        args.urgencia        || "NORMAL",
        telefono:        args.telefono        || "",
        timestamp:       timestamp(),
        ts_raw:          Date.now(),
      };
      mensajes.unshift(item);
      llamadas.unshift({ ...item });

      const esUrgente = item.urgencia === "URGENTE";
      const emoji = esUrgente ? "🚨" : "📲";
      const msg =
        `${emoji} *${esUrgente ? "URGENTE — " : ""}FARMACÉUTICO SOLICITADO*\n\n` +
        `👤 Paciente: ${item.nombre_paciente}\n` +
        `📋 Motivo: ${item.motivo}\n` +
        (item.telefono ? `📞 Teléfono: ${item.telefono}\n` : "") +
        `⚡ Urgencia: ${item.urgencia}\n` +
        `⏰ ${item.timestamp}`;

      await sendWhatsApp(process.env.FARMACEUTICO_PHONE, msg);
      result = "Farmacéutico notificado. Le atenderá en un momento.";
    }

    // ── dejar_mensaje ──
    else if (name === "dejar_mensaje") {
      const item = {
        id: idCounter++,
        tipo: "mensaje",
        estado: "pendiente",
        nombre_paciente: args.nombre_paciente || "",
        mensaje:         args.mensaje         || "",
        telefono:        args.telefono        || "",
        timestamp:       timestamp(),
        ts_raw:          Date.now(),
      };
      mensajes.unshift(item);
      llamadas.unshift({ ...item });

      const msg =
        `💬 *NUEVO MENSAJE — SOFÍA RX*\n\n` +
        `👤 Paciente: ${item.nombre_paciente}\n` +
        `📝 Mensaje: ${item.mensaje}\n` +
        (item.telefono ? `📞 Teléfono: ${item.telefono}\n` : "") +
        `⏰ ${item.timestamp}`;

      await sendWhatsApp(process.env.TECNICO_PHONE, msg);
      result = `Mensaje anotado. El equipo se comunica con ${item.nombre_paciente} pronto.`;
    }

    results.push({ toolCallId: id, result });
  }

  res.json({ results });
});

// ─── API — DASHBOARD ───────────────────────────────────────────────
app.get("/api/refills",   (_, res) => res.json(refills));
app.get("/api/recetas",   (_, res) => res.json(recetas));
app.get("/api/mensajes",  (_, res) => res.json(mensajes));
app.get("/api/llamadas",  (_, res) => res.json(llamadas.slice(0, 50)));

app.get("/api/stats", (_, res) => {
  const hoy = Date.now() - 86400000;
  res.json({
    refills_hoy:    refills.filter(r => r.ts_raw > hoy).length,
    refills_pend:   refills.filter(r => r.estado === "pendiente").length,
    mensajes_pend:  mensajes.filter(m => m.estado === "pendiente").length,
    recetas_pend:   recetas.filter(r => r.estado === "pendiente").length,
    total_llamadas: llamadas.length,
  });
});

// Marcar como completado
app.post("/api/completar/:tipo/:id", (req, res) => {
  const { tipo, id } = req.params;
  const numId = parseInt(id);
  const stores = { refill: refills, receta: recetas, farmaceutico: mensajes, mensaje: mensajes };
  const store = stores[tipo];
  if (!store) return res.status(400).json({ error: "Tipo inválido" });
  const item = store.find(i => i.id === numId);
  if (!item) return res.status(404).json({ error: "No encontrado" });
  item.estado = "completado";
  item.completado_en = timestamp();
  // Update in llamadas too
  const lItem = llamadas.find(l => l.id === numId);
  if (lItem) { lItem.estado = "completado"; lItem.completado_en = item.completado_en; }
  res.json({ ok: true });
});

// ─── REPORTES AUTOMÁTICOS ──────────────────────────────────────────
async function enviarReporte() {
  const pend_r = refills.filter(r => r.estado === "pendiente").length;
  const pend_m = mensajes.filter(m => m.estado === "pendiente").length;
  const pend_v = recetas.filter(r => r.estado === "pendiente").length;
  const total  = refills.length + mensajes.length + recetas.length;

  const msg =
    `📊 *REPORTE SOFÍA RX*\n` +
    `⏰ ${timestamp()}\n\n` +
    `💊 Refills pendientes: ${pend_r}\n` +
    `💬 Mensajes pendientes: ${pend_m}\n` +
    `🔍 Verificaciones pend.: ${pend_v}\n` +
    `📞 Total llamadas hoy: ${total}\n\n` +
    (pend_r + pend_m + pend_v > 0
      ? "⚠️ Hay tareas pendientes en el dashboard."
      : "✅ Todo al día.");

  await sendWhatsApp(process.env.TECNICO_PHONE, msg);
  if (process.env.FARMACEUTICO_PHONE !== process.env.TECNICO_PHONE) {
    await sendWhatsApp(process.env.FARMACEUTICO_PHONE, msg);
  }
}

// Reportes a las 12pm y 5pm hora PR
function scheduleReports() {
  setInterval(() => {
    const now = new Date().toLocaleString("en-US", { timeZone: "America/Puerto_Rico" });
    const d = new Date(now);
    const h = d.getHours(), m = d.getMinutes();
    if ((h === 12 || h === 17) && m === 0) enviarReporte();
  }, 60000); // cada minuto
}
scheduleReports();

// ─── HEALTH CHECK ──────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Sofía RX Backend corriendo en puerto ${PORT}`);
});
