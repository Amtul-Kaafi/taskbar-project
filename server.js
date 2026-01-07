'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/* ---------- environment configuration ---------- */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TITLE = process.env.TASKBAR_TITLE || 'Taskbar';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APPS_FILE = process.env.APPS_FILE || path.join(__dirname, 'apps.json');
const VERSION = process.env.APP_VERSION || require('./package.json').version;

const PUBLIC_DIR = path.join(__dirname, 'public');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-cache' }, headers));
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': MIME_TYPES['.json'] });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- persisted notes (live on the mounted volume) ---------- */

async function readNotes() {
  try {
    const raw = await fsp.readFile(NOTES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      savedAt: parsed.savedAt || null
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', savedAt: null };
    throw err;
  }
}

async function writeNotes(text) {
  const payload = { text, savedAt: new Date().toISOString() };
  await fsp.mkdir(DATA_DIR, { recursive: true });
  // Write to a temp file first so a crash mid-write cannot truncate the notes.
  const tmp = NOTES_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, NOTES_FILE);
  return payload;
}

/* ---------- API ---------- */

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      host: os.hostname(),
      uptime: Math.round(process.uptime())
    });
  }

  if (pathname === '/api/config') {
    return sendJson(res, 200, {
      title: TITLE,
      version: VERSION,
      host: os.hostname(),
      dataDir: DATA_DIR,
      node: process.version
    });
  }

  if (pathname === '/api/apps') {
    const apps = JSON.parse(await fsp.readFile(APPS_FILE, 'utf8'));
    return sendJson(res, 200, apps);
  }

  if (pathname === '/api/notes' && req.method === 'GET') {
    return sendJson(res, 200, await readNotes());
  }

  if (pathname === '/api/notes' && req.method === 'PUT') {
    const raw = await readBody(req);
    let text;
    try {
      text = JSON.parse(raw).text;
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    if (typeof text !== 'string') {
      return sendJson(res, 400, { error: 'Expected { "text": string }' });
    }
    return sendJson(res, 200, await writeNotes(text));
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

/* ---------- static files ---------- */

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));

  // Keep requests inside public/ so path traversal cannot escape it.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
    const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type });
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error(`${req.method} ${pathname} failed:`, err.message);
      sendJson(res, 500, { error: 'Internal error' });
    });
    return;
  }

  serveStatic(res, pathname);
});

/* ---------- lifecycle ---------- */

fsp.mkdir(DATA_DIR, { recursive: true })
  .catch((err) => console.error(`Could not create ${DATA_DIR}: ${err.message}`))
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`${TITLE} v${VERSION} listening on http://${HOST}:${PORT} — host ${os.hostname()}, data ${DATA_DIR}`);
    });
  });

// Containers stop with SIGTERM; exit promptly instead of waiting to be killed.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
