'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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

test('serves the embedded viewer', async (t) => {
  const server = createServer({ root: '/unused' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Pi Sessions/);
  assert.match(html, /Session ID/);
  assert.match(html, /function displayTitle/);
  assert.match(html, /function renderCodeBlock/);
  assert.match(html, /function renderToolCall/);
  assert.match(html, /function renderToolResult/);
});
