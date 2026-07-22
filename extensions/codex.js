'use strict';

const path = require('node:path');
const { findJsonlFiles, readJsonlFile } = require('../lib/jsonl');

const filesByRoot = new Map();

function valueText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => item && (item.text || item.summary || item.content || ''))
    .filter(Boolean)
    .join('\n');
}

function messageContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      if (item.type === 'input_text' || item.type === 'output_text') {
        return { type: 'text', text: item.text || '' };
      }
      return { ...item };
    })
    .filter(Boolean);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function customArguments(payload) {
  if (payload.name === 'exec') return { command: payload.input || '' };
  if (payload.name === 'apply_patch') return { patch: payload.input || '' };
  return parseArguments(payload.input);
}

function specialRecord(raw, title, summary = '') {
  return {
    type: 'codex_event',
    timestamp: raw.timestamp,
    title,
    summary,
    raw,
  };
}

function outputText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function eventSummary(payload) {
  if (payload.message) return outputText(payload.message);
  if (payload.command) {
    const command = Array.isArray(payload.command)
      ? payload.command.join(' ')
      : outputText(payload.command);
    return payload.exit_code == null
      ? command
      : `${command}\nexit ${payload.exit_code}`;
  }
  if (payload.query) return outputText(payload.query);
  if (payload.status) return String(payload.status);
  if (payload.reason) return String(payload.reason);
  if (payload.duration_ms != null) return `${payload.duration_ms} ms`;
  return '';
}

function normalizeRecords(records) {
  const metadata = records.find((record) => record.type === 'session_meta')?.payload || {};
  const callNames = new Map();
  const responseMessages = new Map();
  let finalTokenIndex = -1;

  function messageKey(role, text) {
    return role + '\0' + String(text || '');
  }

  records.forEach((raw, index) => {
    const payload = raw.payload || {};
    if (raw.type === 'response_item'
      && ['function_call', 'custom_tool_call'].includes(payload.type)
      && payload.call_id) {
      callNames.set(payload.call_id, payload.name || payload.type);
    }
    if (raw.type === 'response_item'
      && (payload.type === 'message' || payload.type === 'agent_message')) {
      const role = payload.role || (payload.type === 'agent_message' ? 'assistant' : 'unknown');
      const key = messageKey(role, valueText(payload.content));
      responseMessages.set(key, (responseMessages.get(key) || 0) + 1);
    }
    if (raw.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      finalTokenIndex = index;
    }
  });

  let active = {
    provider: metadata.model_provider || null,
    model: null,
    thinking: null,
  };
  let firstMetadata = true;
  const events = [];

  function push(record) {
    const message = record.message || {};
    events.push({
      record,
      context: {
        provider: message.provider || active.provider,
        model: message.model || active.model,
        thinking: active.thinking,
      },
    });
  }

  records.forEach((raw, index) => {
    const payload = raw.payload || {};

    if (raw.type === 'session_meta') {
      if (firstMetadata) {
        firstMetadata = false;
        push({
          type: 'session',
          id: payload.id || payload.session_id,
          timestamp: payload.timestamp || raw.timestamp,
          cwd: payload.cwd || '',
          parentSession: payload.forked_from_id || payload.parent_thread_id || null,
          raw,
        });
      } else {
        push(specialRecord(raw, 'Session metadata updated', payload.cwd || ''));
      }
      return;
    }

    if (raw.type === 'turn_context') {
      active = {
        provider: metadata.model_provider || active.provider,
        model: payload.model || active.model,
        thinking: payload.effort || active.thinking,
      };
      push(specialRecord(
        raw,
        'Turn context',
        [payload.model, payload.effort && `thinking ${payload.effort}`]
          .filter(Boolean)
          .join(' · '),
      ));
      return;
    }

    if (raw.type === 'response_item') {
      if (payload.type === 'message' || payload.type === 'agent_message') {
        push({
          type: 'message',
          id: payload.id,
          timestamp: raw.timestamp,
          message: {
            role: payload.role || (payload.type === 'agent_message' ? 'assistant' : 'unknown'),
            content: messageContent(payload.content),
            provider: active.provider,
            model: active.model,
            phase: payload.phase,
          },
          raw,
        });
        return;
      }

      if (payload.type === 'reasoning') {
        const thinking = valueText(payload.summary) || valueText(payload.content)
          || (payload.encrypted_content ? 'Encrypted reasoning is available in raw JSON.' : '');
        push({
          type: 'message',
          id: payload.id,
          timestamp: raw.timestamp,
          message: {
            role: 'assistant',
            content: thinking ? [{ type: 'thinking', thinking }] : [],
            provider: active.provider,
            model: active.model,
            phase: 'reasoning',
          },
          raw,
        });
        return;
      }

      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        push({
          type: 'message',
          id: payload.id || payload.call_id,
          timestamp: raw.timestamp,
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: payload.call_id,
              name: payload.name || payload.type,
              arguments: payload.type === 'custom_tool_call'
                ? customArguments(payload)
                : parseArguments(payload.arguments),
            }],
            provider: active.provider,
            model: active.model,
          },
          raw,
        });
        return;
      }

      if (payload.type === 'function_call_output'
        || payload.type === 'custom_tool_call_output') {
        push({
          type: 'message',
          id: payload.call_id,
          timestamp: raw.timestamp,
          message: {
            role: 'toolResult',
            toolCallId: payload.call_id,
            toolName: callNames.get(payload.call_id) || 'tool',
            content: [{ type: 'text', text: outputText(payload.output) }],
            isError: payload.output?.success === false,
          },
          raw,
        });
        return;
      }

      if (payload.type === 'web_search_call' || payload.type === 'tool_search_call') {
        push({
          type: 'message',
          id: payload.id || payload.call_id,
          timestamp: raw.timestamp,
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: payload.call_id || payload.id,
              name: payload.type.replace(/_call$/, ''),
              arguments: payload.arguments || payload.action || {},
            }],
            provider: active.provider,
            model: active.model,
          },
          raw,
        });
        return;
      }

      push(specialRecord(raw, payload.type || 'Response item', eventSummary(payload)));
      return;
    }

    if (raw.type === 'event_msg') {
      if (payload.type === 'user_message' || payload.type === 'agent_message') {
        const role = payload.type === 'user_message' ? 'user' : 'assistant';
        const key = messageKey(role, payload.message);
        const duplicates = responseMessages.get(key) || 0;
        if (duplicates) {
          responseMessages.set(key, duplicates - 1);
          return;
        }
        push({
          type: 'message',
          timestamp: raw.timestamp,
          message: {
            role,
            content: [{ type: 'text', text: payload.message || '' }],
            provider: active.provider,
            model: active.model,
            phase: payload.phase,
          },
          raw,
        });
        return;
      }
      if (payload.type === 'token_count' && index !== finalTokenIndex) return;

      if (payload.type === 'error') {
        push({
          type: 'message',
          timestamp: raw.timestamp,
          message: {
            role: 'toolResult',
            toolName: 'Codex',
            content: [{ type: 'text', text: payload.message || 'Unknown Codex error' }],
            isError: true,
          },
          raw,
        });
        return;
      }

      if (payload.type === 'token_count') {
        const usage = payload.info?.total_token_usage || {};
        push(specialRecord(
          raw,
          'Token usage',
          `${Number(usage.total_tokens || 0).toLocaleString()} total tokens`,
        ));
        return;
      }

      const title = String(payload.type || 'Codex event')
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      push(specialRecord(raw, title, eventSummary(payload)));
      return;
    }

    if (raw.type === 'compacted') {
      push({
        type: 'compaction',
        timestamp: raw.timestamp,
        summary: valueText(payload.message) || 'Context compacted',
        raw,
      });
      return;
    }

    push(specialRecord(raw, raw.type || 'Codex record', eventSummary(payload)));
  });

  return events;
}

function summarizeRecords(records, sourceFile = '', stat = {}, events = normalizeRecords(records)) {
  const metadata = records.find((record) => record.type === 'session_meta')?.payload || {};
  const eventTypes = {};
  const models = new Set();
  const thinkingModes = new Set();
  let finalUsage = {};
  let firstUserMessage = '';
  let lastTimestamp = metadata.timestamp || records[0]?.timestamp || '';
  let errors = 0;

  for (const raw of records) {
    const payload = raw.payload || {};
    const key = payload.type ? `${raw.type}:${payload.type}` : raw.type;
    eventTypes[key || 'unknown'] = (eventTypes[key || 'unknown'] || 0) + 1;
    if (raw.timestamp) lastTimestamp = raw.timestamp;
    if (raw.type === 'turn_context') {
      if (payload.model) models.add([metadata.model_provider, payload.model].filter(Boolean).join('/'));
      if (payload.effort) thinkingModes.add(payload.effort);
    }
    if (!firstUserMessage && raw.type === 'event_msg' && payload.type === 'user_message') {
      firstUserMessage = payload.message || '';
    }
    if (raw.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      finalUsage = payload.info.total_token_usage || finalUsage;
    }
    if (raw.type === 'event_msg' && payload.type === 'error') errors += 1;
  }

  if (!firstUserMessage) {
    const user = events.find((event) => event.record.message?.role === 'user');
    firstUserMessage = valueText(user?.record.message?.content) || '';
  }

  const roles = {};
  for (const event of events) {
    const role = event.record.message?.role;
    if (role) roles[role] = (roles[role] || 0) + 1;
  }

  const filename = sourceFile ? path.basename(sourceFile, '.jsonl') : '';
  const match = filename.match(/^rollout-(.+)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  const startedAt = metadata.timestamp || records[0]?.timestamp || '';
  const started = Date.parse(startedAt);
  const ended = Date.parse(lastTimestamp);
  const toolCalls = events.reduce((count, event) =>
    count + (event.record.message?.content || [])
      .filter((item) => item.type === 'toolCall').length, 0);
  const thinkingBlocks = events.reduce((count, event) =>
    count + (event.record.message?.content || [])
      .filter((item) => item.type === 'thinking').length, 0);

  return {
    id: metadata.id || metadata.session_id || match?.[2] || filename,
    version: null,
    agentVersion: metadata.cli_version || null,
    cwd: metadata.cwd || '',
    parentSession: metadata.forked_from_id || metadata.parent_thread_id || null,
    timestamp: startedAt,
    fileDate: match?.[1] || '',
    endedAt: lastTimestamp,
    durationMs: Number.isFinite(started) && Number.isFinite(ended)
      ? Math.max(0, ended - started)
      : null,
    firstUserMessage,
    eventCount: events.length,
    rawEventCount: records.length,
    messageCount: Object.values(roles).reduce((sum, count) => sum + count, 0),
    roles,
    eventTypes,
    models: [...models].filter(Boolean),
    thinkingModes: [...thinkingModes],
    usage: {
      input: finalUsage.input_tokens || 0,
      output: finalUsage.output_tokens || 0,
      cacheRead: finalUsage.cached_input_tokens || 0,
      reasoning: finalUsage.reasoning_output_tokens || 0,
      totalTokens: finalUsage.total_tokens || 0,
    },
    cost: {},
    toolCalls,
    images: eventTypes['response_item:image_generation_call'] || 0,
    thinkingBlocks,
    errors,
    sourceFile,
    size: stat.size ?? null,
    modifiedAt: stat.mtime instanceof Date ? stat.mtime.toISOString() : null,
    provider: metadata.model_provider || null,
    originator: metadata.originator || null,
    git: metadata.git || null,
  };
}

async function readSessionFile(sourceFile) {
  const parsed = await readJsonlFile(sourceFile);
  const events = normalizeRecords(parsed.records);
  return {
    summary: {
      ...summarizeRecords(parsed.records, sourceFile, parsed.stat, events),
      parseErrors: parsed.errors.length,
    },
    events,
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
  id: 'codex',
  label: 'Codex',
  defaultRoot: '~/.codex/sessions',
  rootEnv: 'CODEX_SESSIONS_DIR',
  listSessions,
  loadSession,
  normalizeRecords,
  readSessionFile,
  summarizeRecords,
};
