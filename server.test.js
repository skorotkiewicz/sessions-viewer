'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const codex = require('./extensions/codex');
const { contextualize, createServer, parseJsonl, summarizeRecords } = require('./server');

const records = [
  { type: 'session', version: 3, id: 'session-id', timestamp: '2026-07-22T20:24:06.644Z', cwd: '/home/mod/Dev/demo' },
  { type: 'model_change', provider: 'openai', modelId: 'gpt-test', timestamp: '2026-07-22T20:24:07.000Z' },
  { type: 'thinking_level_change', thinkingLevel: 'high', timestamp: '2026-07-22T20:24:08.000Z' },
  { type: 'message', id: 'user-1', timestamp: '2026-07-22T20:24:09.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Build it' }] } },
  { type: 'message', id: 'assistant-1', timestamp: '2026-07-22T20:24:10.000Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-test', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a' } }, { type: 'text', text: 'Done' }], usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } }, stopReason: 'stop' } },
];

test('parses and summarizes Pi JSONL with model/thinking context', () => {
  const source = records.map(JSON.stringify).join('\n') + '\n{unfinished';
  const parsed = parseJsonl(source);
  assert.equal(parsed.records.length, 5);
  assert.equal(parsed.errors.length, 1);

  const summary = summarizeRecords(parsed.records, '/tmp/2026-07-22T20-24-06-644Z_session-id.jsonl', { size: 123, mtime: new Date('2026-07-22T20:30:00Z') });
  assert.equal(summary.id, 'session-id');
  assert.equal(summary.cwd, '/home/mod/Dev/demo');
  assert.equal(summary.fileDate, '2026-07-22T20-24-06-644Z');
  assert.equal(summary.firstUserMessage, 'Build it');
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.usage.totalTokens, 15);
  assert.equal(summary.cost.total, 0.25);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.thinkingBlocks, 1);
  assert.deepEqual(summary.models, ['openai/gpt-test']);
  assert.deepEqual(summary.thinkingModes, ['high']);

  const events = contextualize(parsed.records);
  assert.deepEqual(events[3].context, { provider: 'openai', model: 'gpt-test', thinking: 'high' });
  assert.deepEqual(events[4].context, { provider: 'openai', model: 'gpt-test', thinking: 'high' });
});

test('normalizes Codex sessions without duplicate messages or token overcounting', () => {
  const codexRecords = [
    { timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-id', timestamp: '2026-07-01T10:00:00.000Z', cwd: '/home/mod/Dev/codex-demo', model_provider: 'openai', cli_version: '1.0.0' } },
    { timestamp: '2026-07-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test', effort: 'xhigh' } },
    { timestamp: '2026-07-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Build it' } },
    { timestamp: '2026-07-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: 'Build it' }] } },
    { timestamp: '2026-07-01T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
    { timestamp: '2026-07-01T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md' } },
    { timestamp: '2026-07-01T10:00:04.500Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Only in the event stream' } },
    { timestamp: '2026-07-01T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2, reasoning_output_tokens: 1, total_tokens: 15 } } } },
    { timestamp: '2026-07-01T10:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 4, reasoning_output_tokens: 2, total_tokens: 28 } } } },
  ];

  const events = codex.normalizeRecords(codexRecords);
  const summary = codex.summarizeRecords(
    codexRecords,
    '/tmp/rollout-2026-07-01T10-00-00-codex-id.jsonl',
    { size: 123, mtime: new Date('2026-07-01T10:00:06Z') },
    events,
  );

  assert.equal(events.filter((event) => event.record.message?.role === 'user').length, 1);
  assert.equal(summary.firstUserMessage, 'Build it');
  assert.deepEqual(summary.models, ['openai/gpt-test']);
  assert.deepEqual(summary.thinkingModes, ['xhigh']);
  assert.equal(summary.usage.totalTokens, 28);
  assert.equal(summary.toolCalls, 1);
  assert(events.some((event) => event.record.message?.content?.[0]?.text === 'Only in the event stream'));
  assert.equal(events.find((event) => event.record.message?.role === 'toolResult').record.message.toolName, 'exec_command');
  assert.deepEqual(events[2].context, { provider: 'openai', model: 'gpt-test', thinking: 'xhigh' });
});

test('preserves Codex instructions, aborts, and event payloads semantically', () => {
  const events = codex.normalizeRecords([
    { timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-context', cwd: '/tmp/demo', model_provider: 'openai' } },
    { timestamp: '2026-07-01T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-test', effort: 'high', approval_policy: 'on-request', permission_profile: 'workspace', sandbox_policy: { type: 'workspace-write' } } },
    { timestamp: '2026-07-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>\nRead only\n</permissions instructions>' }] } },
    { timestamp: '2026-07-01T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the turn.\n</turn_aborted>' }] } },
    { timestamp: '2026-07-01T10:00:04.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted', duration_ms: 2500 } },
    { timestamp: '2026-07-01T10:00:05.000Z', type: 'event_msg', payload: { type: 'thread_goal_updated', threadId: 'codex-context', goal: 'Ship it' } },
  ]);

  const permissions = events.find((event) => event.record.message?.role === 'developer');
  assert.deepEqual(permissions.record.message.content[0], {
    type: 'context',
    label: 'Permissions instructions',
    text: 'Read only',
    tone: 'instruction',
  });
  const injectedAbort = events.find((event) =>
    event.record.message?.content?.[0]?.label === 'Turn aborted');
  assert.equal(injectedAbort.record.message.content[0].tone, 'warning');

  const abort = events.find((event) => event.record.type === 'turn_aborted');
  assert.equal(abort.record.reason, 'interrupted');
  assert.equal(abort.record.durationMs, 2500);

  const turnContext = events.find((event) => event.record.variant === 'turn_context');
  assert.deepEqual(
    turnContext.record.display.fields.find((field) => field.label === 'Approval'),
    { label: 'Approval', value: 'on-request' },
  );
  assert.deepEqual(turnContext.record.display.details.path, ['raw', 'payload']);
  const goal = events.find((event) => event.record.variant === 'thread_goal_updated');
  assert.equal(goal.record.summary, 'Ship it');
  assert.equal(goal.record.display.details.label, 'Codex payload · 2 fields');
});

test('serves the extension-aware viewer', async (t) => {
  const server = createServer({ root: '/unused' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Session Viewer/);
  assert.match(html, /id="harness"/);
  assert.match(html, /Session ID/);
  assert.match(html, /src="\/app.js"/);

  const application = await fetch('http://127.0.0.1:' + address.port + '/app.js');
  const javascript = await application.text();
  assert.equal(application.status, 200);
  assert.match(javascript, /function displayTitle/);
  assert.match(javascript, /function renderCodeBlock/);
  assert.match(javascript, /function renderToolCall/);
  assert.match(javascript, /function renderToolResult/);
  assert.match(javascript, /function renderRecordDetails/);
  assert.doesNotMatch(javascript, /renderCodexPayload|approval_policy|permission_profile/);

  const harnesses = await (await fetch('http://127.0.0.1:' + address.port + '/api/harnesses')).json();
  assert.deepEqual(harnesses.harnesses.map((harness) => harness.id), ['codex', 'pi']);

  const stylesheet = await fetch('http://127.0.0.1:' + address.port + '/style.css');
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /--background/);
});
