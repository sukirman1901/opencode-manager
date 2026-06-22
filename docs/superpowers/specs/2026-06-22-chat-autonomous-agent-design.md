# OpenCode Manager — Chat Autonomous Agent

**Date:** 2026-06-22
**Status:** Draft

## Overview

Upgrade the Chat tab in OpenCode Manager from a basic chat interface to a full autonomous AI coding agent with streaming, tool execution visualization, approval workflow, file system integration, and agent controls — matching the capabilities of opencode web.

## Architecture

All changes live in `index.ts` (single-file pattern). No new files, no build step. Frontend is embedded HTML/JS SPA served by Bun.

### New State Variables

```js
let _chatMode = "autonomous";          // "autonomous" | "plan" | "ask"
let _chatPendingTools = [];            // tool calls awaiting approval
let _chatAbortController = null;       // AbortController for stop
let _chatContextFiles = [];            // files in context
let _chatDarkMode = false;
```

### New API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat/stop` | POST | Interrupt active request |
| `/api/chat/approve-tool` | POST | Approve/reject tool execution |
| `/api/files/read?path=` | GET | Read file content |
| `/api/files/tree?dir=` | GET | Directory listing |
| `/api/git/:action` | GET | Git status/diff/log |

## Section 1 — State Management & API

Chat state lives in global JS variables (existing pattern). AbortController allows stopping mid-stream. API endpoints proxy to OpenCode server or local filesystem.

- `_chatAbortController` created before each fetch, aborted on stop
- `/api/chat/stop` sends abort signal, closes reader
- All new endpoints follow existing `json()` / error patterns

## Section 2 — Tool Event Handling

`handleChatEvent()` extended with comprehensive tool type switch:

| Tool Event | Visual Component |
|---|---|
| `think` | Italic bubble `🤔 *thinking...*` |
| `read_file` | File card with path + content preview (truncated) |
| `search` / `grep` / `glob` | Search card with query + result count |
| `edit_file` / `write_file` | Diff card with old → new content |
| `replace_file_content` / `multi_replace_file_content` | Diff card (same as edit) |
| `run_command` | Terminal-style block with command |
| `web_search` / `web_fetch` | Link card with snippet |
| `ask_user` | Question card with text input + submit |
| `git` / `git_diff` / `git_commit` | Git badge with detail |
| `tool_result` | Status badge + output (collapsible) |

Each tool card renders into `#chatStreamingTools` div. CSS follows existing pattern: `background: #fff`, `border: 1px solid #d0d7de`, monospace for code.

## Section 3 — Approval Workflow

Three modes control tool execution visibility:

- **Autonomous:** Tools execute automatically on server. UI shows them as they happen. No blocking.
- **Plan:** Tools queue in `_chatPendingTools[].` UI shows approve/reject buttons. Approved tools send POST to server to continue.
- **Ask:** Same as Plan, but `ask_user` tool shows an input field for user response. Response sent back to server.

Pending tool UI:
```
┌─────────────────────────────────────┐
│ 🔧 Pending: run_command             │
│ $ npm install react                 │
│ [Approve] [Reject] [Edit]          │
└─────────────────────────────────────┘
```

"Edit" opens a modal (reuse existing `openModal()` pattern) to modify command/args before approval.

## Section 4 — File System Integration

File explorer in chat sidebar, above session list. Collapsible section.

- Click file → file preview in right panel (read-only, monospace)
- Files being edited/read by agent get colored indicators
- Data fetched from `/api/files/tree` (reads working directory)
- Working directory from session metadata or user selection

File preview:
```
┌─ Read: src/index.ts ───────────────┐
│ import { readFileSync } from "fs"; │
│ ...                                │
└────────────────────────────────────┘
```

Diff view for edits:
```
┌─ Changes ──────────────────────────┐
│ src/App.tsx                        │
├────────────────────────────────────┤
│ - const x = 1;                     │
│ + const x = 2;                     │
│ [Approve] [Reject]                 │
└────────────────────────────────────┘
```

CSS consistent with `.msg-row`, `.usage-table` patterns.

## Section 5 — Agent Controls & UX

Chat header bar (above input):

| Control | Implementation |
|---------|---------------|
| Mode dropdown | `<select>` with 3 options, updates `_chatMode` |
| Model dropdown | `<select>` populated from `/api/config` providers |
| Stop button | `<button>` that calls `abort()` on `_chatAbortController` |
| Context pill | Click opens context drawer |
| Dark mode | Toggle switch, flips CSS variables |
| Cost badge | Real-time from token usage |

Thinking indicator as inline status badge in assistant bubble:
- "🤔 Analyzing..." for think
- "🔧 Editing path..." for edit_file
- "⚙️ Running `command`..." for run_command
- "📖 Reading path..." for read_file

## Section 6 — Context Management & Git

**Context Drawer** — slide-in panel from right side:
- Lists files in context (add/remove via [x] button)
- "Add file" button → file browser from workspace tree
- "Copy context to clipboard" button
- Git section: branch, uncommitted changes count
- Usage summary: tokens in/out, cost

**Git endpoints:**
- `GET /api/git/status` — git status output
- `GET /api/git/diff` — git diff output
- `GET /api/git/log?n=10` — recent commits

All git commands run via `Bun.spawnSync` in the session's working directory.

## UI Consistency Rules

1. All new UI elements use the same color variables: `#24292f` (text), `#656d76` (secondary), `#0969da` (primary blue), `#1a7f37` (success green), `#cf222e` (danger red), `#d0d7de` (borders), `#f6f8fa` (backgrounds)
2. Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` for UI, `ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace` for code
3. Border radius: `6px` for small elements, `8px` for cards, `12px` for modals
4. Buttons use existing `.btn`, `.btn-primary`, `.btn-sm`, `.icon-btn` classes
5. All new state follows `_chat*` naming convention
6. All new event listeners use delegation pattern (existing `document.addEventListener`)
