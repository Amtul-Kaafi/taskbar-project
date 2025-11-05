'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/apps') {
    const apps = JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.json'), 'utf8'));
    return send(res, 200, JSON.stringify(apps), { 'Content-Type': MIME_TYPES['.json'] });
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
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
});

server.listen(PORT, () => {
  console.log(`Taskbar running at http://localhost:${PORT}`);
});
