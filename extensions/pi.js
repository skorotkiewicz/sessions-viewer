'use strict';

const path = require('node:path');
const { findJsonlFiles, readJsonlFile } = require('../lib/jsonl');

const filesByRoot = new Map();

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
    if (record.type === 'model_change') {
      models.add([record.provider, record.modelId].filter(Boolean).join('/'));
    }
    if (record.type === 'thinking_level_change' && record.thinkingLevel) {
      thinkingModes.add(record.thinkingLevel);
    }
    if (record.type !== 'message' || !record.message) continue;

    const message = record.message;
    roles[message.role || 'unknown'] = (roles[message.role || 'unknown'] || 0) + 1;
    if (!firstUserMessage && message.role === 'user') {
      firstUserMessage = textFromContent(message.content).trim();
    }
    if (message.model) models.add([message.provider, message.model].filter(Boolean).join('/'));
    if (message.responseModel) {
      models.add([message.provider, message.responseModel].filter(Boolean).join('/'));
    }
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
    durationMs: Number.isFinite(started) && Number.isFinite(ended)
      ? Math.max(0, ended - started)
      : null,
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
      active = {
        ...active,
        provider: record.provider || null,
        model: record.modelId || null,
      };
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

async function readSessionFile(sourceFile) {
  const parsed = await readJsonlFile(sourceFile);
  return {
    summary: {
      ...summarizeRecords(parsed.records, sourceFile, parsed.stat),
      parseErrors: parsed.errors.length,
    },
    events: contextualize(parsed.records),
    parseErrors: parsed.errors,
  };
}

async function listSessions({ root }) {
  const sessions = [];
  const errors = [];
  const filesById = new Map();
  let sourceFiles;

  try {
    sourceFiles = await findJsonlFiles(root);
  } catch (error) {
    return { sessions, errors: [{ sourceFile: root, error: error.message }] };
  }

  for (const sourceFile of sourceFiles) {
    try {
      const session = await readSessionFile(sourceFile);
      session.summary.relativeFile = path.relative(root, sourceFile);
      sessions.push(session.summary);
      if (session.summary.id) filesById.set(session.summary.id, sourceFile);
    } catch (error) {
      errors.push({ sourceFile, error: error.message });
    }
  }

  filesByRoot.set(root, filesById);
  sessions.sort((left, right) =>
    (right.timestamp || '').localeCompare(left.timestamp || ''));
  return { sessions, errors };
}

async function loadSession({ root, id }) {
  if (!filesByRoot.get(root)?.has(id)) await listSessions({ root });
  const sourceFile = filesByRoot.get(root)?.get(id);
  return sourceFile ? readSessionFile(sourceFile) : null;
}

module.exports = {
  id: 'pi',
  label: 'Pi',
  defaultRoot: '~/.pi/agent/sessions',
  rootEnv: 'PI_SESSIONS_DIR',
  contextualize,
  listSessions,
  loadSession,
  readSessionFile,
  summarizeRecords,
};
