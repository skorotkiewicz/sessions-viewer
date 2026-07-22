'use strict';

const state = {
  harnesses: [],
  harness: 'pi',
  sessions: [],
  selected: null,
  sort: 'date',
  direction: -1,
  query: '',
  request: 0,
};

const harnessSelect = document.getElementById('harness');
const sessionList = document.getElementById('session-list');
const detail = document.getElementById('detail');
const resultCount = document.getElementById('result-count');

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function append(parent, tag, className, text) {
  const element = createElement(tag, className, text);
  parent.appendChild(element);
  return element;
}

function addChip(parent, text, tone = '') {
  return append(parent, 'span', 'chip ' + tone, text);
}

function compactPath(value) {
  return (value || '')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^\/Users\/[^/]+/, '~');
}

function truncate(value, limit = 96) {
  const text = String(value || '');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function firstNonemptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function projectName(cwd) {
  return compactPath(cwd).split('/').filter(Boolean).pop() || 'Unknown path';
}

function displayTitle(session) {
  return truncate(
    firstNonemptyLine(session.firstUserMessage) || projectName(session.cwd),
    96,
  );
}

function messagePreview(session) {
  const text = String(session.firstUserMessage || 'No user message recorded')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, 180);
}

function short(value, size = 12) {
  return truncate(String(value || ''), size);
}

function formatDate(value, compact = false) {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  if (compact) {
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: '2-digit',
    });
  }
  return parsed.toLocaleString();
}

function formatDuration(milliseconds) {
  if (milliseconds == null) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}

function formatBytes(value) {
  if (value == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return amount.toFixed(unit ? 1 : 0) + ' ' + units[unit];
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return '$' + amount.toFixed(amount < 0.01 ? 4 : 2);
}

function totalCost(session) {
  return Number((session.cost || {}).total || 0);
}

function totalTokens(session) {
  return Number((session.usage || {}).totalTokens || 0);
}

function renderStats() {
  const messages = state.sessions.reduce(
    (total, session) => total + session.messageCount,
    0,
  );
  const sessionsWithCost = state.sessions.filter((session) =>
    Object.prototype.hasOwnProperty.call(session.cost || {}, 'total'));
  const cost = sessionsWithCost.reduce(
    (total, session) => total + totalCost(session),
    0,
  );
  const values = [
    state.sessions.length.toLocaleString(),
    messages.toLocaleString(),
    sessionsWithCost.length ? formatMoney(cost) : '—',
  ];

  document.querySelectorAll('#stats strong').forEach((node, index) => {
    node.textContent = values[index];
  });
}

function visibleSessions() {
  const query = state.query.trim().toLowerCase();
  const sessions = state.sessions.filter((session) => {
    const searchable = [
      session.id,
      session.cwd,
      session.firstUserMessage,
      (session.models || []).join(' '),
      (session.thinkingModes || []).join(' '),
    ].join(' ').toLowerCase();
    return !query || searchable.includes(query);
  });

  sessions.sort((left, right) => {
    const leftValue = state.sort === 'date'
      ? left.timestamp
      : state.sort === 'path'
        ? left.cwd
        : left.id;
    const rightValue = state.sort === 'date'
      ? right.timestamp
      : state.sort === 'path'
        ? right.cwd
        : right.id;
    return String(leftValue || '').localeCompare(
      String(rightValue || ''),
      undefined,
      { numeric: true, sensitivity: 'base' },
    ) * state.direction;
  });

  return sessions;
}

function renderSessionList() {
  const sessions = visibleSessions();
  resultCount.textContent = sessions.length + ' of ' + state.sessions.length;
  sessionList.replaceChildren();

  if (!sessions.length) {
    append(sessionList, 'div', 'loading', 'No sessions match this search.');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const button = createElement(
      'button',
      'session-card' + (session.id === state.selected ? ' active' : ''),
    );
    button.type = 'button';
    button.addEventListener('click', () => selectSession(session.id));

    const top = append(button, 'div', 'card-top');
    append(top, 'div', 'card-title', projectName(session.cwd));
    append(top, 'div', 'card-date', formatDate(session.timestamp, true));
    append(button, 'div', 'preview', messagePreview(session));
    append(button, 'div', 'path', compactPath(session.cwd));
    append(button, 'div', 'session-id', session.id);

    const metadata = append(button, 'div', 'card-meta');
    addChip(metadata, session.harnessLabel || state.harness, 'amber');
    addChip(metadata, session.messageCount + ' messages', 'blue');
    if (session.models[0]) addChip(metadata, short(session.models[0], 28), 'mint');
    if (totalCost(session)) addChip(metadata, formatMoney(totalCost(session)), 'amber');

    fragment.appendChild(button);
  }
  sessionList.appendChild(fragment);
}

function hashSelection() {
  const value = location.hash.slice(1);
  const separator = value.indexOf('/');
  if (separator < 0) return { harness: 'pi', id: decodeURIComponent(value) };
  return {
    harness: decodeURIComponent(value.slice(0, separator)),
    id: decodeURIComponent(value.slice(separator + 1)),
  };
}

function harnessLabel() {
  return state.harnesses.find((harness) => harness.id === state.harness)?.label
    || state.harness;
}

async function loadHarnesses() {
  try {
    const response = await fetch('/api/harnesses');
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    state.harnesses = data.harnesses;
    harnessSelect.replaceChildren();

    for (const harness of state.harnesses) {
      const option = createElement(
        'option',
        '',
        harness.label + (harness.available ? '' : ' · not found'),
      );
      option.value = harness.id;
      option.disabled = !harness.available;
      harnessSelect.appendChild(option);
    }

    const requested = hashSelection();
    const requestedHarness = state.harnesses.find((harness) =>
      harness.id === requested.harness && harness.available);
    const fallback = state.harnesses.find((harness) =>
      harness.id === 'pi' && harness.available)
      || state.harnesses.find((harness) => harness.available);
    if (!requestedHarness && !fallback) throw new Error('No session harnesses found');

    state.harness = (requestedHarness || fallback).id;
    harnessSelect.value = state.harness;
    await loadSessions(false, requestedHarness ? requested.id : '');
  } catch (error) {
    sessionList.replaceChildren(createElement('div', 'loading error', error.message));
    resultCount.textContent = 'Failed';
  }
}

async function loadSessions(refresh = false, requestedId = '') {
  state.selected = null;
  sessionList.replaceChildren(
    createElement('div', 'loading', 'Scanning ' + harnessLabel() + ' sessions…'),
  );
  detail.replaceChildren(
    createElement('div', 'empty', 'Select a session to inspect its complete timeline.'),
  );
  resultCount.textContent = 'Loading…';

  try {
    const query = new URLSearchParams({ harness: state.harness });
    if (refresh) query.set('refresh', '1');
    const response = await fetch('/api/sessions?' + query);
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();

    state.sessions = data.sessions;
    renderStats();
    renderSessionList();

    const first = (visibleSessions()[0] || {}).id;
    const selected = requestedId && state.sessions.some((session) =>
      session.id === requestedId) ? requestedId : first;
    if (selected) {
      await selectSession(selected);
    } else {
      detail.replaceChildren(
        createElement('div', 'empty', 'No ' + harnessLabel() + ' sessions found.'),
      );
    }
  } catch (error) {
    sessionList.replaceChildren(createElement('div', 'loading error', error.message));
    resultCount.textContent = 'Failed';
  }
}

async function selectSession(id) {
  state.selected = id;
  renderSessionList();
  history.replaceState(
    null,
    '',
    '#' + encodeURIComponent(state.harness) + '/' + encodeURIComponent(id),
  );
  const request = ++state.request;
  detail.replaceChildren(
    createElement('div', 'loading', 'Loading complete session…'),
  );

  try {
    const response = await fetch(
      '/api/session/' + encodeURIComponent(state.harness) + '/' + encodeURIComponent(id),
    );
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (request === state.request) renderDetail(data);
  } catch (error) {
    if (request === state.request) {
      detail.replaceChildren(createElement('div', 'loading error', error.message));
    }
  }
}

function addFact(parent, label, value, title) {
  const box = append(parent, 'div', 'fact');
  append(box, 'span', '', label);
  const strong = append(box, 'strong', '', value);
  if (title) strong.title = title;
}

function indexToolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    const message = (event.record || {}).message || {};
    if (!Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (item && item.type === 'toolCall' && item.id) calls.set(item.id, item);
    }
  }
  return calls;
}

function renderDetail(data) {
  const session = data.summary;
  const toolCalls = indexToolCalls(data.events);
  detail.replaceChildren();

  const header = append(detail, 'header', 'detail-head');
  append(
    header,
    'div',
    'eyebrow',
    (session.harnessLabel || 'Harness') + ' · session'
      + (session.version ? ' · schema v' + session.version : ''),
  );
  append(header, 'h2', '', displayTitle(session));
  append(header, 'div', 'detail-path', compactPath(session.cwd));

  const facts = append(header, 'div', 'facts');
  addFact(facts, 'Started', formatDate(session.timestamp), session.timestamp);
  addFact(facts, 'Duration', formatDuration(session.durationMs));
  addFact(facts, 'Events', session.eventCount.toLocaleString());
  addFact(facts, 'Messages', session.messageCount.toLocaleString());
  addFact(facts, 'Tokens', totalTokens(session).toLocaleString());
  addFact(
    facts,
    'Cost',
    Object.prototype.hasOwnProperty.call(session.cost || {}, 'total')
      ? formatMoney(totalCost(session))
      : '—',
  );

  const extra = append(header, 'div', 'head-extra');
  append(extra, 'div', 'source', session.id);
  append(
    extra,
    'div',
    'source',
    session.fileDate + ' · ' + formatBytes(session.size) + ' · '
      + compactPath(session.sourceFile),
  );

  const tags = append(extra, 'div', 'chips');
  addChip(tags, session.harnessLabel || state.harness, 'amber');
  for (const model of session.models) addChip(tags, model, 'mint');
  for (const mode of session.thinkingModes) addChip(tags, 'thinking: ' + mode, 'blue');
  if (session.parentSession) addChip(tags, 'forked session', 'amber');
  if (session.parseErrors) addChip(tags, session.parseErrors + ' parse errors', 'amber');

  const timelineHeader = append(detail, 'div', 'timeline-head');
  append(timelineHeader, 'h3', '', 'Complete event timeline');
  append(
    timelineHeader,
    'div',
    'session-id',
    session.rawEventCount && session.rawEventCount !== data.events.length
      ? data.events.length + ' displayed · ' + session.rawEventCount + ' raw'
      : data.events.length + ' stored records',
  );

  const timeline = append(detail, 'section', 'timeline');
  const fragment = document.createDocumentFragment();
  data.events.forEach((event, index) => {
    fragment.appendChild(renderEvent(event, index, toolCalls));
  });
  timeline.appendChild(fragment);
}

function eventLabel(record) {
  if (record.type === 'message') {
    return (record.message && record.message.role) || 'message';
  }
  return String(record.variant || record.type || 'unknown').replaceAll('_', ' ');
}

function rawDetails(record) {
  const details = createElement('details', 'raw');
  append(details, 'summary', '', 'All stored fields · raw JSON');
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    append(details, 'pre', '', JSON.stringify(record, null, 2));
    details.dataset.loaded = 'yes';
  });
  return details;
}

function renderEvent(event, index, toolCalls) {
  const record = event.record || {};
  const context = event.context || {};
  const role = eventLabel(record);
  const article = createElement(
    'article',
    'event ' + (record.type === 'message' ? role : 'special'),
  );

  const header = append(article, 'div', 'event-header');
  append(header, 'div', 'event-role', role);
  append(
    header,
    'div',
    'event-time',
    formatDate(record.timestamp) + ' · #' + (index + 1),
  );

  const metadata = append(article, 'div', 'micro');
  addChip(
    metadata,
    'Model · ' + ([context.provider, context.model].filter(Boolean).join('/') || 'not set'),
    'mint',
  );
  addChip(metadata, 'Thinking · ' + (context.thinking || 'not set'), 'blue');
  if (record.id) addChip(metadata, 'ID · ' + short(record.id, 14));
  if (record.parentId) addChip(metadata, 'Parent · ' + short(record.parentId, 14));

  if (record.type === 'message') {
    renderMessage(article, record.message || {}, toolCalls);
  } else {
    renderSpecialEvent(article, record);
  }

  article.appendChild(rawDetails(record));
  return article;
}

function renderMessage(parent, message, toolCalls) {
  if (message.role === 'toolResult') {
    renderToolResult(parent, message, toolCalls);
    return;
  }

  if (message.role === 'bashExecution') {
    renderBashExecution(parent, message);
    return;
  }

  renderContent(parent, message.content);
  if (message.errorMessage) {
    append(parent, 'div', 'message-error', message.errorMessage);
  }
  renderUsage(parent, message);
}

function renderUsage(parent, message) {
  if (!message.usage) return;
  const row = append(parent, 'div', 'chips');
  if (message.usage.input != null) {
    addChip(row, 'in ' + Number(message.usage.input).toLocaleString());
  }
  if (message.usage.output != null) {
    addChip(row, 'out ' + Number(message.usage.output).toLocaleString());
  }
  if (message.usage.reasoning) {
    addChip(row, 'reasoning ' + Number(message.usage.reasoning).toLocaleString());
  }
  if (message.usage.cacheRead) {
    addChip(row, 'cache ' + Number(message.usage.cacheRead).toLocaleString());
  }
  if (message.usage.cost && message.usage.cost.total != null) {
    addChip(row, formatMoney(message.usage.cost.total), 'amber');
  }
  if (message.stopReason) addChip(row, 'stop · ' + message.stopReason);
}

function normalizeArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function simpleToolName(name) {
  return String(name || 'tool').split('.').pop();
}

function toolPath(call) {
  const argumentsValue = normalizeArguments((call || {}).arguments);
  return argumentsValue.path || argumentsValue.file_path || '';
}

function toolSummary(call, fallbackName) {
  const name = simpleToolName((call || {}).name || fallbackName);
  const sourcePath = toolPath(call);
  return [name, sourcePath ? compactPath(sourcePath) : ''].filter(Boolean).join(' · ');
}

function renderToolResult(parent, message, toolCalls) {
  const call = toolCalls.get(message.toolCallId);
  const details = append(
    parent,
    'details',
    'tool-result' + (message.isError ? ' error' : ''),
  );
  append(
    details,
    'summary',
    '',
    'Result · ' + toolSummary(call, message.toolName)
      + (message.isError ? ' · error' : ''),
  );

  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    const body = append(details, 'div', 'tool-body');
    if (message.toolCallId) {
      append(body, 'div', 'tool-path', 'Call ' + message.toolCallId);
    }
    renderToolOutput(body, message.content, call, message.toolName);
    details.dataset.loaded = 'yes';
  });
}

function renderBashExecution(parent, message) {
  const details = append(parent, 'details', 'tool-result');
  append(details, 'summary', '', '$ ' + truncate(message.command || 'Shell command', 120));
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    const body = append(details, 'div', 'tool-body');
    renderCodeBlock(body, message.command || '', 'shell', 'Command');
    renderCodeBlock(body, message.output || '', 'text', 'Output');
    const metadata = append(body, 'div', 'chips');
    if (message.exitCode != null) {
      addChip(
        metadata,
        'exit ' + message.exitCode,
        message.exitCode ? 'amber' : 'mint',
      );
    }
    details.dataset.loaded = 'yes';
  });
}

function renderToolOutput(parent, content, call, fallbackName) {
  const name = simpleToolName((call || {}).name || fallbackName);
  const sourcePath = toolPath(call);

  if (['read', 'bash', 'exec', 'exec_command', 'apply_patch'].includes(name)
    && Array.isArray(content)) {
    for (const item of content) {
      if (item && item.type === 'text') {
        renderCodeBlock(
          parent,
          item.text || '',
          ['bash', 'exec', 'exec_command'].includes(name)
            ? 'text'
            : name === 'apply_patch'
              ? 'diff'
              : languageFromPath(sourcePath),
          sourcePath ? compactPath(sourcePath) : name + ' output',
        );
      } else {
        renderContent(parent, [item]);
      }
    }
    return;
  }

  renderContent(parent, content);
}

function renderContent(parent, content) {
  if (typeof content === 'string') {
    renderRichText(parent, content);
    return;
  }
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      append(parent, 'div', 'text-content', String(item));
    } else if (item.type === 'text') {
      renderRichText(parent, item.text || '');
    } else if (item.type === 'thinking') {
      renderThinking(parent, item);
    } else if (item.type === 'context') {
      renderContext(parent, item);
    } else if (item.type === 'toolCall') {
      renderToolCall(parent, item);
    } else if (item.type === 'image') {
      renderImage(parent, item);
    } else {
      renderDataContent(parent, item);
    }
  }
}

function renderRichText(parent, text) {
  const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = fence.exec(text))) {
    if (match.index > cursor) {
      append(parent, 'div', 'text-content', text.slice(cursor, match.index));
    }
    renderCodeBlock(
      parent,
      match[2].replace(/\r?\n$/, ''),
      match[1].trim() || 'text',
      'Code',
    );
    cursor = fence.lastIndex;
  }

  if (cursor < text.length) {
    append(parent, 'div', 'text-content', text.slice(cursor));
  }
}

function renderThinking(parent, item) {
  const details = append(parent, 'details', 'thinking');
  append(details, 'summary', '', 'Thinking');
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    append(details, 'div', 'text-content', item.thinking || '');
    details.dataset.loaded = 'yes';
  });
}

function renderContext(parent, item) {
  const details = append(parent, 'details', 'context-block ' + (item.tone || 'context'));
  append(details, 'summary', '', item.label || 'Context');
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    const body = append(details, 'div', 'context-body');
    renderRichText(body, item.text || '');
    details.dataset.loaded = 'yes';
  });
}

function renderDataContent(parent, item) {
  const details = append(parent, 'details', 'data-content');
  append(
    details,
    'summary',
    '',
    String(item.type || 'Data').replaceAll('_', ' '),
  );
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    renderCodeBlock(details, JSON.stringify(item, null, 2), 'json', 'Stored content');
    details.dataset.loaded = 'yes';
  });
}

function renderToolCall(parent, item) {
  const details = append(parent, 'details', 'tool');
  append(details, 'summary', '', 'Tool call · ' + toolSummary(item, item.name));
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    const body = append(details, 'div', 'tool-body');
    if (item.id) append(body, 'div', 'tool-path', 'Call ' + item.id);
    renderToolArguments(body, item);
    details.dataset.loaded = 'yes';
  });
}

function renderToolArguments(parent, call) {
  const name = simpleToolName(call.name);
  const argumentsValue = normalizeArguments(call.arguments);
  const sourcePath = argumentsValue.path || argumentsValue.file_path || '';

  if (sourcePath) {
    append(parent, 'div', 'tool-path', compactPath(sourcePath));
  }

  if (name === 'write' && typeof argumentsValue.content === 'string') {
    renderCodeBlock(
      parent,
      argumentsValue.content,
      languageFromPath(sourcePath),
      compactPath(sourcePath) || 'Written content',
    );
    return;
  }

  if (name === 'edit' && Array.isArray(argumentsValue.edits)) {
    argumentsValue.edits.forEach((edit, index) => {
      renderDiff(
        parent,
        edit.oldText || '',
        edit.newText || '',
        (compactPath(sourcePath) || 'Edit') + ' · change ' + (index + 1),
      );
    });
    return;
  }

  if (name === 'read') {
    const metadata = append(parent, 'div', 'chips');
    if (argumentsValue.offset != null) {
      addChip(metadata, 'from line ' + argumentsValue.offset);
    }
    if (argumentsValue.limit != null) {
      addChip(metadata, 'limit ' + argumentsValue.limit + ' lines');
    }
    if (!metadata.childElementCount) {
      append(parent, 'div', 'text-content', 'File contents are in the following result.');
    }
    return;
  }

  if (['bash', 'exec', 'exec_command'].includes(name)) {
    const command = argumentsValue.command || argumentsValue.cmd;
    if (command) {
      renderCodeBlock(
        parent,
        Array.isArray(command) ? command.join(' ') : String(command),
        'shell',
        'Command',
      );
      return;
    }
  }

  if (name === 'apply_patch' && typeof argumentsValue.patch === 'string') {
    renderCodeBlock(parent, argumentsValue.patch, 'diff', 'Patch');
    return;
  }

  renderCodeBlock(
    parent,
    JSON.stringify(argumentsValue, null, 2),
    'json',
    'Arguments',
  );
}

function languageFromPath(sourcePath) {
  const extension = String(sourcePath || '').split('.').pop().toLowerCase();
  const languages = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonl: 'jsonl',
    jsx: 'jsx',
    md: 'markdown',
    odin: 'odin',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'tsx',
    yaml: 'yaml',
    yml: 'yaml',
    zig: 'zig',
  };
  return languages[extension] || 'text';
}

function renderCodeBlock(parent, source, language, label) {
  const wrapper = append(parent, 'div', 'code-block');
  const header = append(wrapper, 'div', 'code-header');
  append(
    header,
    'span',
    'code-header-label',
    (label || 'Code') + ' · ' + (language || 'text'),
  );

  const copy = append(header, 'button', 'copy-button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(source || ''));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } catch {
      copy.textContent = 'Unavailable';
    }
  });

  append(wrapper, 'pre', 'code', String(source || ''));
  return wrapper;
}

function renderDiff(parent, oldText, newText, label) {
  const wrapper = append(parent, 'div', 'code-block');
  const header = append(wrapper, 'div', 'code-header');
  append(header, 'span', 'code-header-label', label + ' · diff');
  const diff = append(wrapper, 'div', 'diff');

  for (const line of String(oldText).split('\n')) {
    append(diff, 'span', 'diff-line removed', '- ' + line);
  }
  for (const line of String(newText).split('\n')) {
    append(diff, 'span', 'diff-line added', '+ ' + line);
  }
}

function renderImage(parent, item) {
  const safeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!safeTypes.includes(item.mimeType) || !item.data) {
    append(parent, 'div', 'text-content', 'Image · ' + (item.mimeType || 'unknown'));
    return;
  }
  const image = append(parent, 'img', 'image');
  image.alt = 'Session image';
  image.loading = 'lazy';
  image.src = 'data:' + item.mimeType + ';base64,' + item.data;
}

function renderSpecialEvent(parent, record) {
  let title = record.title || record.type || 'Event';
  let copy = record.summary || '';

  if (record.type === 'session') {
    title = 'Session started';
    copy = record.cwd || '';
  } else if (record.type === 'model_change') {
    title = 'Model changed';
    copy = [record.provider, record.modelId].filter(Boolean).join('/');
  } else if (record.type === 'thinking_level_change') {
    title = 'Thinking mode changed';
    copy = record.thinkingLevel || '';
  } else if (record.type === 'compaction') {
    title = 'Context compacted';
    copy = record.summary || '';
  } else if (record.type === 'turn_aborted') {
    title = 'Turn aborted';
    copy = [
      record.reason,
      record.durationMs != null ? formatDuration(record.durationMs) : '',
    ].filter(Boolean).join(' · ');
  } else if (record.type === 'custom') {
    title = 'Custom event · ' + (record.customType || 'unknown');
    copy = JSON.stringify(record.data, null, 2);
  } else if (record.type === 'custom_message') {
    title = 'Custom message · ' + (record.customType || 'unknown');
    copy = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content, null, 2);
  }

  append(parent, 'div', 'special-title', title);
  if (copy) append(parent, 'div', 'special-copy', copy);
  renderRecordDetails(parent, record);
}

function valueAtPath(value, path) {
  return (path || []).reduce(
    (current, key) => current == null ? undefined : current[key],
    value,
  );
}

function renderRecordDetails(parent, record) {
  const display = record.display;
  if (!display) return;

  if (display.fields && display.fields.length) {
    const metadata = append(parent, 'div', 'chips record-fields');
    for (const field of display.fields) {
      addChip(metadata, field.label + ' · ' + compactPath(String(field.value)));
    }
  }

  for (const context of display.contexts || []) renderContext(parent, context);

  if (!display.details) return;
  const details = append(parent, 'details', 'record-details');
  append(details, 'summary', '', display.details.label || 'Stored details');
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded) return;
    const source = valueAtPath(record, display.details.path);
    const stored = source && typeof source === 'object' ? { ...source } : source;
    for (const key of display.details.omit || []) {
      if (stored && typeof stored === 'object') delete stored[key];
    }
    renderCodeBlock(details, JSON.stringify(stored, null, 2), 'json', 'Event details');
    details.dataset.loaded = 'yes';
  });
}

document.getElementById('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderSessionList();
});

document.getElementById('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderSessionList();
});

document.getElementById('direction').addEventListener('click', (event) => {
  state.direction *= -1;
  event.currentTarget.textContent = state.direction === -1 ? '↓' : '↑';
  renderSessionList();
});

harnessSelect.addEventListener('change', () => {
  state.harness = harnessSelect.value;
  loadSessions();
});

document.getElementById('refresh').addEventListener('click', () => {
  loadSessions(true);
});

window.addEventListener('hashchange', () => {
  const requested = hashSelection();
  if (!requested.id) return;
  if (requested.harness !== state.harness
    && state.harnesses.some((harness) =>
      harness.id === requested.harness && harness.available)) {
    state.harness = requested.harness;
    harnessSelect.value = state.harness;
    loadSessions(false, requested.id);
  } else if (requested.id !== state.selected) {
    selectSession(requested.id);
  }
});

loadHarnesses();
