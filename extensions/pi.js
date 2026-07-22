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

function humanize(value) {
  return String(value || 'Event')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function parseEmbeddedJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    let quoted = false;
    let escaped = false;
    let sanitized = '';
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (quoted && code < 32) {
        sanitized += `\\u${code.toString(16).padStart(4, '0')}`;
        escaped = false;
        continue;
      }
      sanitized += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = !quoted;
      }
    }
    return JSON.parse(sanitized);
  }
}

function editArguments(args) {
  let edits = args.edits;
  if (typeof edits === 'string') {
    try {
      edits = parseEmbeddedJson(edits);
    } catch {
      edits = [];
    }
  }
  if (!Array.isArray(edits)) {
    const hasEdit = ['oldText', 'old_text', 'old', 'newText', 'new_text']
      .some((key) => Object.prototype.hasOwnProperty.call(args, key));
    edits = hasEdit ? [args] : [];
  }
  return edits.map((edit) => {
    if (typeof edit !== 'string') return edit;
    try {
      return parseEmbeddedJson(edit);
    } catch {
      return { newText: edit };
    }
  });
}

function editText(edit, keys) {
  const key = keys.find((name) => Object.prototype.hasOwnProperty.call(edit || {}, name));
  const value = key ? edit[key] : '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function toolCall(item) {
  const name = String(item.name || 'tool').split('.').pop();
  const args = parseArguments(item.arguments);
  const sourcePath = args.path || args.file_path || args['"path"'] || '';
  const edits = name === 'edit' ? editArguments(args) : [];
  let details;

  if (name === 'write' && typeof args.content === 'string') {
    details = [{ type: 'code', source: args.content, path: sourcePath, label: sourcePath }];
  } else if (name === 'edit' && edits.length) {
    details = edits.map((edit, index) => ({
      type: 'diff',
      oldText: editText(edit, ['oldText', 'old_text', 'old']),
      newText: editText(edit, ['newText', 'new_text']),
      label: `${sourcePath || 'Edit'} · change ${index + 1}`,
    }));
  } else if (name === 'edit' && typeof args.edits === 'string') {
    details = [{
      type: 'code',
      source: args.edits,
      language: 'json',
      label: `${sourcePath || 'Edit'} · stored payload`,
    }];
  } else if (name === 'read') {
    const fields = [
      args.offset != null && { label: 'From line', value: args.offset },
      args.limit != null && { label: 'Limit', value: `${args.limit} lines` },
    ].filter(Boolean);
    details = fields.length
      ? [{ type: 'fields', fields }]
      : [{ type: 'text', text: 'File contents are in the following result.' }];
  } else if (name === 'bash') {
    details = [{
      type: 'code',
      source: Array.isArray(args.command) ? args.command.join(' ') : args.command || '',
      language: 'shell',
      label: 'Command',
    }];
  } else {
    details = [{ type: 'data', label: 'Arguments', value: args }];
  }

  return { ...item, label: name, path: sourcePath, details };
}

function resultDetails(message, call) {
  const name = String(call?.name || message.toolName || '').split('.').pop();
  if (name === 'edit') {
    const diff = message.details?.patch || message.details?.diff;
    if (diff) {
      return [{
        type: 'diff',
        source: diff,
        label: `${call?.path || 'Edit'} · applied diff`,
      }, ...(message.content || [])];
    }
  }
  if (name === 'read') {
    return (message.content || []).map((item) => item?.type === 'text'
      ? { type: 'code', source: item.text || '', path: call?.path, label: call?.path || 'Output' }
      : item);
  }
  if (name === 'bash') {
    return (message.content || []).map((item) => item?.type === 'text'
      ? { type: 'code', source: item.text || '', language: 'text', label: 'Output' }
      : item);
  }
  return message.content;
}

function normalizeRecord(record, toolCalls = new Map()) {
  if (record.type === 'message' && record.message?.role === 'toolResult') {
    const message = record.message;
    return {
      ...record,
      message: {
        role: 'tool',
        content: [{
          type: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          label: toolCalls.get(message.toolCallId)?.label || message.toolName,
          details: resultDetails(message, toolCalls.get(message.toolCallId)),
          isError: message.isError,
        }],
      },
      raw: record,
    };
  }
  if (record.type === 'message' && record.message?.role === 'bashExecution') {
    const message = record.message;
    return {
      ...record,
      message: {
        role: 'tool',
        content: [{
          type: 'command',
          command: message.command,
          output: message.output,
          exitCode: message.exitCode,
        }],
      },
      raw: record,
    };
  }
  if (record.type === 'message') {
    const content = (record.message?.content || []).map((item) =>
      item?.type === 'toolCall' ? toolCall(item) : item);
    return content.some((item, index) => item !== record.message.content[index])
      ? { ...record, message: { ...record.message, content }, raw: record }
      : record;
  }

  const normalized = {
    ...record,
    type: 'event',
    variant: record.type,
    raw: record,
  };
  if (record.type === 'session') {
    normalized.title = 'Session started';
    normalized.summary = record.cwd || '';
  } else if (record.type === 'model_change') {
    normalized.title = 'Model changed';
    normalized.summary = [record.provider, record.modelId].filter(Boolean).join('/');
  } else if (record.type === 'thinking_level_change') {
    normalized.title = 'Thinking mode changed';
    normalized.summary = record.thinkingLevel || '';
  } else if (record.type === 'compaction') {
    normalized.title = 'Context compacted';
    normalized.summary = record.summary || '';
  } else if (record.type === 'custom') {
    normalized.title = 'Custom event · ' + (record.customType || 'unknown');
    normalized.summary = JSON.stringify(record.data, null, 2);
  } else if (record.type === 'custom_message') {
    normalized.title = 'Custom message · ' + (record.customType || 'unknown');
    normalized.summary = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content, null, 2);
  } else {
    normalized.title = record.title || humanize(record.type);
    normalized.summary = record.summary || '';
  }
  return normalized;
}

function contextualize(records) {
  let active = { provider: null, model: null, thinking: null };
  const toolCalls = new Map();
  for (const record of records) {
    for (const item of record.message?.content || []) {
      if (item?.type === 'toolCall' && item.id) toolCalls.set(item.id, toolCall(item));
    }
  }
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
      record: normalizeRecord(record, toolCalls),
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
  default: true,
  id: 'pi',
  label: 'Pi',
  defaultRoot: '~/.pi/agent/sessions',
  rootEnv: 'PI_SESSIONS_DIR',
  contextualize,
  listSessions,
  loadSession,
  normalizeRecord,
  readSessionFile,
  summarizeRecords,
};
