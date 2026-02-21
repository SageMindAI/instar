import { PrivateViewer } from './dist/publishing/PrivateViewer.js';
import express from 'express';
import { Tunnel } from 'cloudflared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PIN = '1234';

// Set up viewer
const viewsDir = path.join(os.tmpdir(), 'instar-demo-views-' + Date.now());
fs.mkdirSync(viewsDir, { recursive: true });
const viewer = new PrivateViewer({ viewsDir });

// Create test view with PIN
const view = viewer.create(
  'Secret Test Report',
  '# Hello from Instar\n\nThis is a **PIN-protected** private view.\n\nIf you can see this, the PIN worked!\n\n---\n\n*Served securely via Cloudflare Tunnel + PIN gate.*',
  PIN
);
console.log('View created:', view.id);

// Start express server
const app = express();
app.use(express.json());

app.get('/view/:id', (req, res) => {
  const v = viewer.get(req.params.id);
  if (!v) return res.status(404).send('Not found');
  if (v.pinHash) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewer.renderPinPage(v));
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewer.renderHtml(v));
  }
});

app.post('/view/:id/unlock', (req, res) => {
  const v = viewer.get(req.params.id);
  if (!v) return res.status(404).send('Not found');
  const pin = req.body?.pin;
  if (!pin || !viewer.verifyPin(req.params.id, pin)) {
    return res.status(403).json({ error: 'Incorrect PIN' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(viewer.renderHtml(v));
});

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('Server on port', port);

  const localUrl = `http://127.0.0.1:${port}`;
  // Use explicit --config to prevent ~/.cloudflared/config.yml
  // named tunnel ingress rules from overriding the quick tunnel
  const cfgPath = path.join(os.tmpdir(), 'instar-demo-cf.yml');
  fs.writeFileSync(cfgPath, '# Quick tunnel — no ingress rules\n');
  const t = Tunnel.quick(localUrl, { '--config': cfgPath });

  t.once('url', (tunnelUrl) => {
    const viewUrl = `${tunnelUrl}/view/${view.id}`;
    console.log('TUNNEL_URL=' + viewUrl);
    console.log('PIN=' + PIN);
    fs.writeFileSync('/tmp/instar-demo-url.txt', viewUrl + '\n' + PIN);
  });

  t.on('error', (err) => {
    console.error('Tunnel error:', err.message);
  });

  // Keep process alive
  process.on('SIGINT', () => {
    t.stop();
    server.close();
    process.exit();
  });
});
