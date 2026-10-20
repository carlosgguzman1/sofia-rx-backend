'use strict';
// Genera la carpeta lista para subir a Vercel (vercel-dashboard/) apuntando a tu backend.
// Uso: node scripts/preparar-vercel.js https://tu-app.up.railway.app [carpeta-salida]
const fs = require('fs');
const path = require('path');

const api = (process.argv[2] || '').trim().replace(/\/+$/, '');
const out = path.resolve(process.argv[3] || path.join(__dirname, '..', 'vercel-dashboard'));
if (!/^https:\/\/[^\s/]+$/.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api)) {
  console.error('Uso: node scripts/preparar-vercel.js https://tu-app.up.railway.app');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'public', 'index.html'), path.join(out, 'index.html'));
fs.writeFileSync(
  path.join(out, 'config.js'),
  `// Generado por scripts/preparar-vercel.js. Backend de Sofía RX:\nwindow.SOFIA_CONFIG = { apiBase: ${JSON.stringify(api)} };\n`
);
const vercel = {
  cleanUrls: true,
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'Cache-Control', value: 'no-cache' },
        {
          key: 'Content-Security-Policy',
          value: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src ${api}; frame-ancestors 'none'`,
        },
      ],
    },
  ],
};
fs.writeFileSync(path.join(out, 'vercel.json'), JSON.stringify(vercel, null, 2) + '\n');
console.log(`Listo: ${out}\nBackend: ${api}\n\nEn Railway define CORS_ORIGIN con la URL EXACTA que te dé Vercel (ej. https://sofia-rx.vercel.app).`);
