'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { loadExtensions } = require('./extensions');
const { expandHome, parseJsonl } = require('./lib/jsonl');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const PAGE_FILE = path.join(__dirname, 'page.html');
const APP_FILE = path.join(__dirname, 'public', 'app.js');
const STYLE_FILE = path.join(__dirname, 'public', 'style.css');
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#111923"/><text x="32" y="44" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#70e1bd">◇</text></svg>';

function extensionRoot(extension, options = {}) {
  if (options.roots?.[extension.id]) return expandHome(options.roots[extension.id]);
  return expandHome(process.env[extension.rootEnv] || extension.defaultRoot);
}

function defaultExtension(extensions) {
  return [...extensions.values()].find((extension) => extension.default)
    || extensions.values().next().value;
}

async function describeExtensions(extensions, options) {
  return Promise.all([...extensions.values()].map(async (extension) => {
    const root = extensionRoot(extension, options);
    let available = true;
    try {
      await fs.access(root);
    } catch {
      available = false;
    }
    return {
      id: extension.id,
      label: extension.label,
      root,
      available,
      default: extension === defaultExtension(extensions),
    };
  }));
}

function send(res, status, body, type) {
  const headers = {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function createServer(options = {}) {
  const extensions = options.extensions || loadExtensions();
  const scanCache = new Map();

  async function sessionsFor(extension, refresh) {
    const root = extensionRoot(extension, options);
    const key = extension.id + '\0' + root;
    if (!refresh && scanCache.has(key)) return scanCache.get(key);
    const result = await extension.listSessions({ root });
    const normalized = {
      root,
      errors: result.errors || [],
      sessions: result.sessions.map((session) => ({
        ...session,
        harness: extension.id,
        harnessLabel: extension.label,
      })),
    };
    scanCache.set(key, normalized);
    return normalized;
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (url.pathname === '/') {
        return send(res, 200, await fs.readFile(PAGE_FILE, 'utf8'), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/app.js') {
        return send(res, 200, await fs.readFile(APP_FILE, 'utf8'), 'text/javascript; charset=utf-8');
      }
      if (url.pathname === '/style.css') {
        return send(res, 200, await fs.readFile(STYLE_FILE, 'utf8'), 'text/css; charset=utf-8');
      }
      if (url.pathname === '/favicon.svg') {
        return send(res, 200, FAVICON, 'image/svg+xml');
      }
      if (url.pathname === '/api/harnesses') {
        return sendJson(res, 200, {
          harnesses: await describeExtensions(extensions, options),
        });
      }
      if (url.pathname === '/api/sessions') {
        const harness = url.searchParams.get('harness') || defaultExtension(extensions)?.id;
        const extension = extensions.get(harness);
        if (!extension) return sendJson(res, 404, { error: 'Unknown harness' });
        const result = await sessionsFor(
          extension,
          url.searchParams.get('refresh') === '1',
        );
        return sendJson(res, 200, { harness, ...result });
      }
      if (url.pathname.startsWith('/api/session/')) {
        const parts = url.pathname.slice('/api/session/'.length).split('/');
        const explicitHarness = parts.length > 1 && extensions.has(parts[0]);
        const harness = explicitHarness
          ? decodeURIComponent(parts.shift())
          : defaultExtension(extensions)?.id;
        const id = decodeURIComponent(parts.join('/'));
        const extension = extensions.get(harness);
        if (!extension) return sendJson(res, 404, { error: 'Unknown harness' });
        const root = extensionRoot(extension, options);
        const session = await extension.loadSession({ root, id });
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        session.summary = {
          ...session.summary,
          harness: extension.id,
          harnessLabel: extension.label,
        };
        return sendJson(res, 200, session);
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  const extensions = loadExtensions();
  createServer({ extensions }).listen(PORT, HOST, () => {
    console.log(`Session Viewer: http://${HOST}:${PORT}`);
    for (const extension of extensions.values()) {
      console.log(`${extension.label}: ${extensionRoot(extension)}`);
    }
  });
}

module.exports = { createServer, parseJsonl };
