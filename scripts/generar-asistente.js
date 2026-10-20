'use strict';
// Genera el asistente de Vapi listo para UNA farmacia y (opcional) lo crea en tu cuenta de Vapi.
//
//   node scripts/generar-asistente.js \
//     --farmacia "Farmacia Mia" --horario "Lunes a viernes, 8:00 a. m. a 6:00 p. m." \
//     --url https://tu-app.up.railway.app --secret TU_VAPI_SECRET \
//     --voz ID_DE_VOZ_ELEVENLABS --recetario 787-555-0100 [--crear]
//
// Con --crear necesitas la variable VAPI_API_KEY (clave privada de Vapi). Sin --crear solo escribe el archivo.
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--crear') o.crear = true;
    else if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  }
  return o;
}

function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

function build(opts, template) {
  const missing = ['farmacia', 'horario', 'url', 'secret', 'voz', 'recetario'].filter((k) => !opts[k]);
  if (missing.length) throw new Error('Faltan: ' + missing.map((m) => '--' + m).join(', '));
  const url = opts.url.replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('--url debe ser https://… sin ruta');
  const phone = toE164(opts.recetario);
  if (!phone) throw new Error('--recetario debe ser un teléfono de 10 dígitos');
  if (opts.secret.length < 16) throw new Error('--secret debe tener al menos 16 caracteres (usa el mismo VAPI_SECRET de Railway)');

  const map = [
    ['[NOMBRE DE LA FARMACIA]', opts.farmacia],
    ['[HORARIO]', opts.horario],
    ['https://REEMPLAZAR.up.railway.app', url],
    ['REEMPLAZAR_CON_VAPI_SECRET', opts.secret],
    ['REEMPLAZAR_VOICE_ID', opts.voz],
    ['+1787REEMPLAZAR', phone],
  ];
  const walk = (v) => {
    if (typeof v === 'string') return map.reduce((s, [from, to]) => s.split(from).join(to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(template);
  out.name = `Sofía RX — ${opts.farmacia}`;
  const text = JSON.stringify(out);
  if (/REEMPLAZAR|\[NOMBRE DE LA FARMACIA\]|\[HORARIO\]/.test(text)) throw new Error('Quedaron marcadores sin reemplazar en la plantilla');
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vapi-assistant.json'), 'utf8'));
  const assistant = build(opts, template);
  const slug = opts.farmacia.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = path.join(process.cwd(), `vapi-assistant.${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(assistant, null, 2), { mode: 0o600 });
  console.log('Asistente generado:', file, '(contiene tu secret: no lo subas a GitHub)');

  if (opts.crear) {
    if (!process.env.VAPI_API_KEY) throw new Error('Falta la variable VAPI_API_KEY');
    const res = await fetch('https://api.vapi.ai/assistant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(assistant),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Vapi respondió ${res.status}: ${body.slice(0, 600)}`);
    console.log('Creado en Vapi. ID:', JSON.parse(body).id, '\nAhora asígnalo a tu número en Vapi → Phone Numbers.');
  }
}

if (require.main === module) main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
module.exports = { build, toE164 };
