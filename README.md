# Pi Sessions

A local, read-only web viewer for [Pi](https://github.com/badlogic/pi-mono) agent session files.

It scans `~/.pi/agent/sessions`, builds a searchable session index, and renders complete JSONL timelines without uploading data or installing dependencies.

![Pi Sessions showing parsed code, model metadata, and tool results](docs/pi-sessions.png)

## Features

- Search sessions by prompt, path, session ID, model, or thinking mode
- Sort by date, project path, or session ID
- Show model, provider, and thinking mode on every event
- Display token usage, cache usage, cost, timestamps, IDs, and file metadata
- Render `write` calls as code and `edit` calls as readable diffs
- Keep tool calls, tool results, skills, reasoning, and raw JSON collapsed until requested
- Render fenced code blocks and session images
- Preserve every stored field in an expandable raw JSON view
- Responsive desktop and mobile layout

## Requirements

- Node.js 18 or newer
- Pi sessions stored as JSONL files

No package installation or build step is required.

## Run

```bash
node server.js
```

Open <http://127.0.0.1:4173>.

The server binds only to `127.0.0.1` and reads sessions from:

```text
~/.pi/agent/sessions
```

Link directly to a session with its ID:

```text
http://127.0.0.1:4173/#019f8b7f-f4f4-7441-8291-f18fef3372cf
```

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | Local HTTP port |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | Session directory to scan |

Examples:

```bash
PORT=8080 node server.js
```

```bash
PI_SESSIONS_DIR=~/other/pi-sessions node server.js
```

## Tests

With Node.js:

```bash
node server.test.js
```

With Bun:

```bash
bun test server.test.js
```

Use `bun test`, not `bun run`: Bun must start its test runner for the `node:test` API.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | JSONL parser, session index, metadata aggregation, and local HTTP API |
| `page.html` | Responsive interface and semantic event/code rendering |
| `server.test.js` | Parser, context propagation, page, and favicon checks |

## Privacy

Session files can contain prompts, source code, command output, paths, and tool results. The viewer:

- listens only on localhost;
- reads but never modifies session files;
- makes no external network requests;
- has no third-party runtime dependencies.
