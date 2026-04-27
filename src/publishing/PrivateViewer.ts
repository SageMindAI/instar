/**
 * Private content viewer for Instar agents.
 *
 * Stores markdown content locally and serves it as rendered HTML
 * via the agent's HTTP server. When combined with a Cloudflare Tunnel,
 * this provides authenticated access to rendered content from anywhere.
 *
 * Unlike Telegraph (public), private views are gated by the agent's
 * auth token and only accessible through the tunnel URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { marked } from 'marked';

// ── Types ──────────────────────────────────────────────────────────

export interface PrivateViewMetadata {
  /** Source that created this view (e.g. { type: 'job', id: 'coherence-audit' }) */
  source?: { type: string; id: string };
  /** Arbitrary key-value pairs for linking views to originating contexts */
  [key: string]: unknown;
}

export interface PrivateView {
  id: string;
  title: string;
  markdown: string;
  /** SHA-256 hash of the PIN, if PIN-protected */
  pinHash?: string;
  createdAt: string;
  updatedAt?: string;
  /** Optional metadata for linking views to jobs, features, etc. */
  metadata?: PrivateViewMetadata;
}

export interface PrivateViewerConfig {
  /** Directory to store views */
  viewsDir: string;
}

// ── Service ────────────────────────────────────────────────────────

export class PrivateViewer {
  private viewsDir: string;
  private lastTimestamp = 0;

  constructor(config: PrivateViewerConfig) {
    this.viewsDir = config.viewsDir;
    if (!fs.existsSync(this.viewsDir)) {
      fs.mkdirSync(this.viewsDir, { recursive: true });
    }
  }

  /**
   * Store markdown content for private viewing.
   * If a PIN is provided, the view requires PIN entry before content is shown.
   */
  create(title: string, markdown: string, pin?: string, metadata?: PrivateViewMetadata): PrivateView {
    const id = crypto.randomUUID();
    // Ensure monotonically increasing timestamps even within same millisecond
    let now = Date.now();
    if (now <= this.lastTimestamp) {
      now = this.lastTimestamp + 1;
    }
    this.lastTimestamp = now;

    const view: PrivateView = {
      id,
      title,
      markdown,
      createdAt: new Date(now).toISOString(),
    };
    if (pin) {
      view.pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    }
    if (metadata && Object.keys(metadata).length > 0) {
      view.metadata = metadata;
    }
    this.save(view);
    return view;
  }

  /**
   * Update an existing view.
   */
  update(id: string, title: string, markdown: string): PrivateView | null {
    const existing = this.get(id);
    if (!existing) return null;

    existing.title = title;
    existing.markdown = markdown;
    existing.updatedAt = new Date().toISOString();
    this.save(existing);
    return existing;
  }

  /**
   * Get a view by ID.
   */
  get(id: string): PrivateView | null {
    const filePath = path.join(this.viewsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * List all views.
   */
  list(): PrivateView[] {
    try {
      const files = fs.readdirSync(this.viewsDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.viewsDir, f), 'utf-8')) as PrivateView;
        } catch {
          return null;
        }
      }).filter((v): v is PrivateView => v !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * Delete a view.
   */
  delete(id: string): boolean {
    const filePath = path.join(this.viewsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return false;
      // safe-git-allow: incremental-migration
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify a PIN against a view's stored hash.
   */
  verifyPin(id: string, pin: string): boolean {
    const view = this.get(id);
    if (!view || !view.pinHash) return false;
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(view.pinHash, 'hex'),
    );
  }

  /**
   * Render a PIN entry page for a protected view.
   */
  renderPinPage(view: PrivateView, error = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8f9fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #1a1a2e;
    }
    .pin-box {
      background: #fff;
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      max-width: 380px;
      width: 90%;
      text-align: center;
    }
    .pin-box h1 {
      font-size: 1.3rem;
      margin-bottom: 0.5rem;
      color: #16213e;
    }
    .pin-box p {
      font-size: 0.9rem;
      color: #666;
      margin-bottom: 1.5rem;
    }
    .pin-input {
      width: 100%;
      padding: 0.75rem 1rem;
      font-size: 1.5rem;
      letter-spacing: 0.3em;
      text-align: center;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      outline: none;
      transition: border-color 0.2s;
    }
    .pin-input:focus { border-color: #533483; }
    .pin-input.error { border-color: #e74c3c; }
    .error-msg {
      color: #e74c3c;
      font-size: 0.85rem;
      margin-top: 0.5rem;
      display: ${error ? 'block' : 'none'};
    }
    .submit-btn {
      width: 100%;
      padding: 0.75rem;
      margin-top: 1.25rem;
      background: #16213e;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .submit-btn:hover { background: #533483; }
    .submit-btn:disabled { background: #aaa; cursor: not-allowed; }
    .lock-icon { font-size: 2rem; margin-bottom: 0.75rem; }
  </style>
</head>
<body>
  <div class="pin-box">
    <div class="lock-icon">&#128274;</div>
    <h1>${escapeHtml(view.title)}</h1>
    <p>This content is PIN-protected.</p>
    <form id="pin-form">
      <input type="password" class="pin-input${error ? ' error' : ''}" id="pin" name="pin"
        placeholder="Enter PIN" autocomplete="off" inputmode="numeric" autofocus>
      <div class="error-msg" id="error-msg">Incorrect PIN. Please try again.</div>
      <button type="submit" class="submit-btn">Unlock</button>
    </form>
  </div>
  <script>
    document.getElementById('pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = document.getElementById('pin').value;
      const btn = document.querySelector('.submit-btn');
      btn.disabled = true;
      btn.textContent = 'Verifying...';
      try {
        const res = await fetch(window.location.pathname + '/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        if (res.ok) {
          const html = await res.text();
          document.open();
          document.write(html);
          document.close();
        } else {
          document.getElementById('error-msg').style.display = 'block';
          document.getElementById('pin').classList.add('error');
          document.getElementById('pin').value = '';
          document.getElementById('pin').focus();
          btn.disabled = false;
          btn.textContent = 'Unlock';
        }
      } catch {
        btn.disabled = false;
        btn.textContent = 'Unlock';
      }
    });
  </script>
</body>
</html>`;
  }

  /**
   * Render a view as self-contained HTML.
   */
  renderHtml(view: PrivateView): string {
    const bodyHtml = marked.parse(view.markdown, { async: false, gfm: true }) as string;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(view.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a2e;
      background: #f8f9fa;
      padding: 0;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      background: #fff;
      min-height: 100vh;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
      color: #16213e;
      border-bottom: 2px solid #e8e8e8;
      padding-bottom: 0.5rem;
    }
    .meta {
      font-size: 0.85rem;
      color: #888;
      margin-bottom: 2rem;
    }
    h3 { font-size: 1.4rem; margin: 1.5rem 0 0.75rem; color: #16213e; }
    h4 { font-size: 1.15rem; margin: 1.25rem 0 0.5rem; color: #16213e; }
    p { margin: 0.75rem 0; }
    a { color: #0f3460; text-decoration: underline; }
    a:hover { color: #533483; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    s { text-decoration: line-through; color: #888; }
    code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: #f0f0f0;
      padding: 0.15em 0.35em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre {
      background: #1a1a2e;
      color: #e8e8e8;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: 0.85rem;
    }
    blockquote {
      border-left: 3px solid #533483;
      padding: 0.5rem 1rem;
      margin: 1rem 0;
      color: #555;
      background: #faf8ff;
      border-radius: 0 4px 4px 0;
    }
    ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    hr {
      border: none;
      border-top: 1px solid #e0e0e0;
      margin: 1.5rem 0;
    }
    img { max-width: 100%; border-radius: 4px; }
    figure { margin: 1rem 0; }
    figcaption { font-size: 0.85rem; color: #888; text-align: center; margin-top: 0.25rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #e0e0e0; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    input[type="checkbox"] { margin-right: 0.4rem; }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #e8e8e8;
      font-size: 0.8rem;
      color: #aaa;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(view.title)}</h1>
    <div class="meta">${new Date(view.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${view.updatedAt ? ' (updated)' : ''}</div>
    ${bodyHtml}
    <div class="footer">Served by Instar</div>
  </div>
</body>
</html>`;
  }

  private save(view: PrivateView): void {
    const filePath = path.join(this.viewsDir, `${view.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(view, null, 2));
  }
}

// ── HTML Rendering ─────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

