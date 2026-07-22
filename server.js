'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const SESSION_ROOT = expandHome(process.env.PI_SESSIONS_DIR || '~/.pi/agent/sessions');
const PAGE_FILE = path.join(__dirname, 'page.html');

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}

function parseJsonl(source) {
  const records = [];
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  }
  return { records, errors };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n');
}

function summarizeRecords(records, sourceFile = '', stat = {}) {
  const header = records.find((record) => record.type === 'session') || {};
  const roles = {};
  const eventTypes = {};
  const usage = {};
  const cost = {};
  const models = new Set();
  const thinkingModes = new Set();
  let firstUserMessage = '';
  let lastTimestamp = header.timestamp || '';
  let toolCalls = 0;
  let images = 0;
  let thinkingBlocks = 0;
  let errors = 0;

  for (const record of records) {
    eventTypes[record.type || 'unknown'] = (eventTypes[record.type || 'unknown'] || 0) + 1;
    if (record.timestamp) lastTimestamp = record.timestamp;
    if (record.type === 'model_change') models.add([record.provider, record.modelId].filter(Boolean).join('/'));
    if (record.type === 'thinking_level_change' && record.thinkingLevel) thinkingModes.add(record.thinkingLevel);
    if (record.type !== 'message' || !record.message) continue;

    const message = record.message;
    roles[message.role || 'unknown'] = (roles[message.role || 'unknown'] || 0) + 1;
    if (!firstUserMessage && message.role === 'user') firstUserMessage = textFromContent(message.content).trim();
    if (message.model) models.add([message.provider, message.model].filter(Boolean).join('/'));
    if (message.responseModel) models.add([message.provider, message.responseModel].filter(Boolean).join('/'));
    if (message.isError || message.errorMessage) errors += 1;

    for (const [key, value] of Object.entries(message.usage || {})) {
      if (typeof value === 'number') usage[key] = (usage[key] || 0) + value;
      if (key === 'cost' && value && typeof value === 'object') {
        for (const [costKey, amount] of Object.entries(value)) {
          if (typeof amount === 'number') cost[costKey] = (cost[costKey] || 0) + amount;
        }
      }
    }

    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item && item.type === 'toolCall') toolCalls += 1;
        if (item && item.type === 'image') images += 1;
        if (item && item.type === 'thinking') thinkingBlocks += 1;
      }
    }
  }

  const filename = sourceFile ? path.basename(sourceFile, '.jsonl') : '';
  const separator = filename.lastIndexOf('_');
  const started = Date.parse(header.timestamp || '');
  const ended = Date.parse(lastTimestamp || '');

  return {
    id: header.id || (separator >= 0 ? filename.slice(separator + 1) : filename),
    version: header.version ?? null,
    cwd: header.cwd || '',
    parentSession: header.parentSession || null,
    timestamp: header.timestamp || '',
    fileDate: separator >= 0 ? filename.slice(0, separator) : '',
    endedAt: lastTimestamp,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
    firstUserMessage,
    eventCount: records.length,
    messageCount: Object.values(roles).reduce((sum, count) => sum + count, 0),
    roles,
    eventTypes,
    models: [...models].filter(Boolean),
    thinkingModes: [...thinkingModes],
    usage,
    cost,
    toolCalls,
    images,
    thinkingBlocks,
    errors,
    sourceFile,
    size: stat.size ?? null,
    modifiedAt: stat.mtime instanceof Date ? stat.mtime.toISOString() : null,
  };
}

function contextualize(records) {
  let active = { provider: null, model: null, thinking: null };
  return records.map((record) => {
    if (record.type === 'model_change') {
      active = { ...active, provider: record.provider || null, model: record.modelId || null };
    }
    if (record.type === 'thinking_level_change') {
      active = { ...active, thinking: record.thinkingLevel || null };
    }
    const message = record.message || {};
    return {
      record,
      context: {
        provider: message.provider || active.provider,
        model: message.model || active.model,
        thinking: active.thinking,
      },
    };
  });
}

async function findSessionFiles(root) {
  const found = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(fullPath);
    }
  }
  await walk(root);
  return found.sort();
}

async function readSessionFile(sourceFile) {
  const [source, stat] = await Promise.all([fs.readFile(sourceFile, 'utf8'), fs.stat(sourceFile)]);
  const parsed = parseJsonl(source);
  return {
    summary: { ...summarizeRecords(parsed.records, sourceFile, stat), parseErrors: parsed.errors.length },
    events: contextualize(parsed.records),
    parseErrors: parsed.errors,
  };
}

async function scanSessions(root = SESSION_ROOT) {
  const sessions = [];
  const filesById = new Map();
  const errors = [];

  for (const sourceFile of await findSessionFiles(root)) {
    try {
      const session = await readSessionFile(sourceFile);
      session.summary.relativeFile = path.relative(root, sourceFile);
      sessions.push(session.summary);
      if (session.summary.id) filesById.set(session.summary.id, sourceFile);
    } catch (error) {
      errors.push({ sourceFile, error: error.message });
    }
  }

  sessions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return { sessions, filesById, errors };
}



function send(res, status, body, type) {
  const headers = {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function createServer({ root = SESSION_ROOT } = {}) {
  let filesById = new Map();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (url.pathname === '/') return send(res, 200, await fs.readFile(PAGE_FILE, 'utf8'), 'text/html; charset=utf-8');
      if (url.pathname === '/api/sessions') {
        const scan = await scanSessions(root);
        filesById = scan.filesById;
        return sendJson(res, 200, { sessions: scan.sessions, errors: scan.errors, root });
      }
      if (url.pathname.startsWith('/api/session/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/session/'.length));
        if (!filesById.has(id)) {
          const scan = await scanSessions(root);
          filesById = scan.filesById;
        }
        const sourceFile = filesById.get(id);
        if (!sourceFile) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, await readSessionFile(sourceFile));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be between 1 and 65535');
  createServer().listen(PORT, HOST, () => {
    console.log(`Pi Sessions: http://${HOST}:${PORT}`);
    console.log(`Reading: ${SESSION_ROOT}`);
  });
}

module.exports = { contextualize, createServer, parseJsonl, readSessionFile, scanSessions, summarizeRecords };
