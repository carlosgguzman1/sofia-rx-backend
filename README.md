# Sofía RX
Agente de voz con IA para farmacias de Puerto Rico + dashboard del técnico.
*GA RX Consulting — Carlos Guzmán, PharmD*

```
Paciente llama → (desvío si nadie contesta) → Vapi: Sofía
     → herramientas → POST /webhook/vapi → este servidor (Railway)
          ├─ guarda el pendiente (refill / mensaje / transferida)
          ├─ alerta por WhatsApp (Twilio) al técnico
          └─ al terminar la llamada agrega resumen + conversación
Técnico → https://tu-app.up.railway.app → dashboard (se actualiza cada 5 s)
```

Sin dependencias: solo Node 20.6+. No hay `npm install`.

## Qué viene del bot de HandyWorks y qué cambió
| HandyWorks (contratistas) | Sofía RX |
|---|---|
| Leads, estimados, urgencia | Pendientes: refill, mensaje, transferida |
| Asistente "Mia" | Asistente "Sofía" con 4 herramientas |
| Webhook sin clave | Webhook exige `x-vapi-secret`; API exige token |
| Datos solo en memoria | Archivo JSON, se borran a los 30 días |
| Bot de WhatsApp con Claude | Quitado: en farmacia WhatsApp solo se usa para **alertas** |
| Dashboard solo lectura | Dashboard con login y botones Tomar / Listo / Reabrir |

## Puesta en marcha, en orden (≈30 min)
Necesitas: cuenta de GitHub, Railway, Vercel, Vapi, ElevenLabs y (opcional) Twilio.

### 1) Backend en Railway
1. Sube esta carpeta a un repo de GitHub (`.env`, `data/` y los asistentes generados ya están en `.gitignore`).
2. Railway → New Project → Deploy from GitHub.
3. Variables (ver `.env.example`):
   - `VAPI_SECRET` y `DASHBOARD_TOKEN`: dos claves largas y distintas (`openssl rand -hex 24`).
   - `PHARMACY_NAME`, `DASHBOARD_URL` (la URL del dashboard en Vercel, paso 2).
   - Alertas (opcional): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `ALERT_WHATSAPP_TO`.
   - **Importante:** WhatsApp solo entrega texto libre si el destinatario escribió al número en las últimas 24 h. Para producción crea en Twilio una plantilla *Utility* (`Sofía RX: {{1}} — {{2}}. Tel: {{3}}. Detalle: {{4}}`), espera su aprobación y pon su ID en `TWILIO_CONTENT_SID`.
   - `CORS_ORIGIN`: la URL exacta del dashboard en Vercel (paso 2), p. ej. `https://sofia-rx.vercel.app`.
4. Volume: Settings → Volumes → montar en `/data` y `DATA_FILE=/data/pendientes.json`.
5. Abre `https://tu-app.up.railway.app/health` → `"configured": true`.

### 2) Dashboard en Vercel
```bash
node scripts/preparar-vercel.js https://tu-app.up.railway.app
```
Crea la carpeta `vercel-dashboard/` (index.html + config.js + vercel.json con cabeceras de seguridad).
Vercel no recibe carpetas sueltas: o la subes a un repo de GitHub y la importas en Vercel (Root Directory = `vercel-dashboard`), o instalas el CLI (`npm i -g vercel`) y corres `vercel --prod` dentro de la carpeta. Framework: **Other**, sin build.
Copia la URL que te dé Vercel y ponla en `CORS_ORIGIN` y `DASHBOARD_URL` en Railway.
(También puedes servir el dashboard directamente desde Railway en `/`; no necesita Vercel ni CORS.)

### 3) Asistente en Vapi (uno por farmacia)
```bash
node scripts/generar-asistente.js \
  --farmacia "Nombre de la Farmacia" --horario "Lunes a viernes, 8:00 a. m. a 6:00 p. m." \
  --url https://tu-app.up.railway.app --secret EL_MISMO_VAPI_SECRET \
  --voz ID_VOZ_ELEVENLABS --recetario 787-555-0100 --crear
```
Con `--crear` (y `VAPI_API_KEY` en tu terminal) lo crea en tu cuenta; sin `--crear` solo escribe `vapi-assistant.<farmacia>.json` para importarlo a mano.
Luego en Vapi → Phone Numbers: asigna el asistente a tu número y configura en la farmacia el **desvío "si no contestan"** hacia ese número.

### 4) Prueba antes de entregar
```bash
BASE_URL=https://tu-app.up.railway.app VAPI_SECRET=xxx node scripts/simular-llamada.js refill   # o mensaje | farmaceutico
```
Debe aparecer en el dashboard en ≤5 s. Después haz **una llamada real** al número y pide un refill, un mensaje y hablar con el farmacéutico.

## Pruebas automáticas
```bash
npm test                                                   # 26 pruebas (backend, asistente, generador)
NODE_PATH=<ruta a playwright> node test/dashboard.e2e.js   # dashboard en navegador (14)
NODE_PATH=<ruta a playwright> node test/vercel.e2e.js      # dashboard en otro dominio, como Vercel (5)
```

## Lo que debes saber antes de usarlo con pacientes reales
- **Nunca probé contra Vapi, Twilio ni Railway reales.** Probé el formato de mensajes según la documentación que conozco; haz una llamada de prueba completa antes de ofrecerlo.
- **Sin conexión al sistema de la farmacia (PrimeRx/RX30).** `verificar_receta` solo deja una solicitud para que el equipo verifique; Sofía tiene instrucción de no confirmar nunca el estado de una receta.
- **Datos de pacientes (PHI).** Nombre, teléfono, medicamento y conversaciones se guardan en el servidor y pasan por Vapi, ElevenLabs, Deepgram, Twilio y Railway. Antes de operar, revisa los acuerdos de cada proveedor (BAA) y la política de la farmacia. No afirmes cumplimiento de HIPAA a clientes hasta confirmarlo. Las grabaciones de audio vienen desactivadas (`recordingEnabled: false`).
- Las alertas de WhatsApp llevan tipo, nombre y teléfono, **sin medicamento**. El detalle está en el dashboard.
- Una farmacia por despliegue de Railway (y un asistente de Vapi por farmacia). Para varias: repite el proceso por cada una.
- Si el paciente cuelga sin que Sofía use una herramienta, no se crea pendiente.
- Una sola clave compartida para el dashboard (sin usuarios individuales).


## Llamadas sin contestar y transferencia al farmacéutico

1. Número de Sofía: cómpralo en Vapi, o compra uno en Twilio (cuenta paga, no de prueba) e impórtalo en Vapi (Phone Numbers → Import → Twilio). Asígnale el asistente.
2. En la línea de la farmacia activa el desvío **condicional** (no contesta / ocupado) hacia ese número, con 15–20 s de timbre.
3. `--recetario` debe ser una línea directa del farmacéutico o su celular, **nunca** la línea que se desvía a Sofía (causaría un bucle).
4. Con Twilio: activa Voice → Geo Permissions para Puerto Rico.
5. Al pedir al farmacéutico, el pendiente y la alerta se registran antes de transferir; si nadie contesta, el equipo igual ve el aviso en el dashboard.
