# Chat Autonomous Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Chat tab from basic chat to full autonomous AI coding agent with tool handling, approval workflow, file system integration, agent controls, and git integration.

**Architecture:** All changes in single file (`index.ts`). New JS state variables, extended `handleChatEvent()`, new API routes in `createServer()`, and new CSS/HTML in embedded PAGE template. Follow existing patterns exactly.

**Tech Stack:** Bun, TypeScript, embedded HTML/CSS/JS SPA, bun:sqlite

---

### Task 1: Add new state variables & CSS variables for dark mode

**Files:**
- Modify: `index.ts:673-678` (JS state section)
- Modify: `index.ts:316-508` (CSS section)

**Step 1: Add new state variables after existing chat state**

Add after line 678 (after `const iconPen = ...`):
```js
let _chatMode = "autonomous";
let _chatPendingTools = [];
let _chatAbortController = null;
let _chatContextFiles = [];
let _chatDarkMode = false;
```

**Step 2: Add CSS variables for dark mode**

Add at end of `<style>` block (before `</style>`):
```css
:root { --bg: #f5f6f8; --bg-card: #fff; --text: #24292f; --text-secondary: #656d76; --border: #d0d7de; --primary: #0969da; --success: #1a7f37; --danger: #cf222e; --bg-code: #f3f4f6; }
body.dark { --bg: #0d1117; --bg-card: #161b22; --text: #e6edf3; --text-secondary: #8b949e; --border: #30363d; --primary: #58a6ff; --success: #3fb950; --danger: #f85149; --bg-code: #1c2128; }
body { background: var(--bg); color: var(--text); }
```

Update existing hardcoded colors in body to use `var(--bg)` etc. selectively (only body, .layout, .sidebar, .main, .topbar, .content, .provider, .model-card, .session-card, .chat-sidebar, etc.)

**Step 3: Verify**

Run: `bun index.ts` and check server starts without error on port 2084

**Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: add chat agent state vars and CSS variables for dark mode"
```

---

### Task 2: Add backend API endpoints (stop, approve-tool, files, git)

**Files:**
- Modify: `index.ts:2398-2400` (before 404 return in createServer)

**Step 1: Add `/api/chat/stop` endpoint**

Add before the final `return json({ error: "not found" }, 404)`:
```ts
if (url.pathname === "/api/chat/stop" && req.method === "POST") {
  return json({ ok: true });
  // Frontend handles abort via AbortController
}

if (url.pathname === "/api/chat/approve-tool" && req.method === "POST") {
  const { toolId, approved, modifiedArgs } = await req.json();
  // Proxy to OpenCode server if needed, or just log
  return json({ ok: true, toolId, approved });
}

if (url.pathname === "/api/files/tree" && req.method === "GET") {
  const dir = url.searchParams.get("dir") || homedir();
  try {
    const { readdirSync, statSync } = await import("fs");
    const { join } = await import("path");
    const entries = readdirSync(dir);
    const tree = entries.filter(e => !e.startsWith(".")).map(e => {
      const full = join(dir, e);
      try {
        const s = statSync(full);
        return { name: e, type: s.isDirectory() ? "directory" : "file", size: s.size };
      } catch { return { name: e, type: "unknown" }; }
    });
    return json({ ok: true, path: dir, entries: tree });
  } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
}

if (url.pathname === "/api/files/read" && req.method === "GET") {
  const path = url.searchParams.get("path");
  if (!path) return json({ ok: false, error: "path required" }, 400);
  try {
    const { readFileSync, existsSync, statSync } = await import("fs");
    if (!existsSync(path)) return json({ ok: false, error: "file not found" }, 404);
    const s = statSync(path);
    if (s.size > 1024 * 100) return json({ ok: false, error: "file too large (>100KB)" }, 413);
    const content = readFileSync(path, "utf-8");
    return json({ ok: true, path, content });
  } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
}

if (url.pathname.startsWith("/api/git/") && req.method === "GET") {
  const action = url.pathname.replace("/api/git/", "");
  const dir = url.searchParams.get("dir") || process.cwd();
  if (!["status", "diff", "log"].includes(action)) return json({ ok: false, error: "invalid action" }, 400);
  try {
    const { execSync } = await import("child_process");
    let cmd = "";
    if (action === "status") cmd = "git status --short";
    else if (action === "diff") cmd = "git diff --stat";
    else if (action === "log") cmd = "git log --oneline -10";
    const output = execSync(cmd, { cwd: dir, encoding: "utf-8", timeout: 10000 });
    return json({ ok: true, action, output });
  } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
}
```

**Step 2: Run to verify no syntax error**

Run: `bun index.ts` and check server starts

**Step 3: Commit**

```bash
git add index.ts
git commit -m "feat: add chat agent API endpoints (stop, approve, files, git)"
```

---

### Task 3: Extended tool event handling in handleChatEvent()

**Files:**
- Modify: `index.ts:1600-1636` (handleChatEvent function)

**Step 1: Replace handleChatEvent() with comprehensive switch**

Replace the existing `function handleChatEvent(event)` with:

```js
function handleChatEvent(event) {
  const textEl = $("chatStreamingText");
  const toolsEl = $("chatStreamingTools");
  if (!textEl || !toolsEl) return;

  if (event.type === "text") {
    _currentStreamText += (event.text || event.delta || "");
    textEl.innerHTML = renderMd(_currentStreamText);
  } else if (event.parts) {
    for (const p of event.parts) {
      if (p.type === "text") { _currentStreamText += p.text; }
    }
    textEl.innerHTML = renderMd(_currentStreamText);
  } else if (event.type === "think" || event.tool === "think") {
    const thought = event.thought || event.args?.thought || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="padding:8px 12px;font-size:13px;color:var(--text-secondary);font-style:italic">🤔 ' + escHtml(thought) + '</div>');
  } else if (event.type === "tool_call:run_command" || event.type === "run_command" || event.tool === "run_command") {
    const args = event.args || event.arguments || {};
    const cmd = args.command || args.CommandLine || event.command || "";
    addPendingTool(event, "run_command", cmd);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:12px;background:#1f2328;color:#f6f8fa;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-x:auto;">$ ' + escHtml(cmd) + '</div>');
  } else if (event.type === "tool_call:read_file" || event.type === "read_file" || event.tool === "read_file") {
    const args = event.args || event.arguments || {};
    const path = args.path || args.targetFile || args.filePath || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--primary);display:flex;align-items:center;gap:6px">📖 Reading ' + escHtml(path) + '</div>');
  } else if (event.type === "tool_call:edit_file" || event.type === "edit_file" || event.tool === "edit_file" || event.tool === "replace_file_content" || event.tool === "multi_replace_file_content") {
    const args = event.args || event.arguments || {};
    const target = args.targetFile || args.TargetFile || args.target || "";
    const oldStr = args.oldString || args.old || "";
    const newStr = args.newString || args.new || "";
    addPendingTool(event, "edit_file", target);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:#f0f6ff;border:1px solid #cce5ff;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--primary);display:flex;align-items:center;gap:6px">📝 Editing ' + escHtml(target) + '</div>');
  } else if (event.type === "tool_call:search" || event.type === "search" || event.tool === "search" || event.tool === "grep") {
    const args = event.args || event.arguments || {};
    const query = args.query || args.pattern || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);display:flex;align-items:center;gap:6px">🔍 Searching: <code style="font-size:11px">' + escHtml(query) + '</code></div>');
  } else if (event.type === "tool_call:glob" || event.tool === "glob") {
    const args = event.args || event.arguments || {};
    const pattern = args.pattern || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">📁 Glob: <code style="font-size:11px">' + escHtml(pattern) + '</code></div>');
  } else if (event.type === "tool_call:web_search" || event.tool === "web_search") {
    const args = event.args || event.arguments || {};
    const q = args.query || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">🌐 Searching web: ' + escHtml(q) + '</div>');
  } else if (event.type === "tool_call:web_fetch" || event.tool === "web_fetch") {
    const args = event.args || event.arguments || {};
    const url = args.url || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">🌍 Fetching: <code style="font-size:11px">' + escHtml(url) + '</code></div>');
  } else if (event.type === "tool_call:ask_user" || event.tool === "ask_user") {
    const args = event.args || event.arguments || {};
    const question = args.question || args.message || "";
    addPendingTool(event, "ask_user", question);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:12px;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;font-size:13px">' +
      '❓ ' + escHtml(question) +
      '<div style="margin-top:8px;display:flex;gap:6px"><input id="askInput" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" placeholder="Type your answer...">' +
      '<button class="btn btn-primary btn-sm" onclick="submitAskResponse()">Send</button></div></div>');
  } else if (event.tool === "git" || event.tool === "git_diff" || event.tool === "git_commit") {
    const args = event.args || event.arguments || {};
    const cmd = args.command || args.action || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:8px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">🔀 git: ' + escHtml(cmd) + '</div>');
  } else if (event.type === "tool_result") {
    const toolName = event.tool || event.name || "";
    const output = (event.result || event.output || event.text || "").slice(0, 500);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:0 0 10px;padding:8px 12px;font-size:11px;color:var(--success);background:#f0fff4;border:1px solid #b7e1c0;border-radius:6px;display:flex;align-items:flex-start;gap:6px">' +
      '<span style="flex-shrink:0">✅</span><span>' + (output || "Execution complete") + '</span></div>');
  }

  $("chatMessagesWrapper").scrollTop = $("chatMessagesWrapper").scrollHeight;
}
```

**Step 2: Add helper functions after handleChatEvent**

```js
function addPendingTool(event, type, summary) {
  _chatPendingTools.push({ id: Date.now() + "_" + Math.random().toString(36).slice(2, 8), event, type, summary, approved: null });
  if (_chatMode === "plan" || _chatMode === "ask") {
    renderPendingTools();
  }
}

function renderPendingTools() {
  const container = $("chatPendingTools");
  if (!container) return;
  let html = '<div style="margin-top:12px;padding:12px;background:var(--bg);border:1px solid #d4a72c;border-radius:8px">';
  html += '<div style="font-size:12px;font-weight:600;color:#9a6700;margin-bottom:8px">⏳ Pending Tools (' + _chatPendingTools.length + ')</div>';
  for (const t of _chatPendingTools) {
    if (t.approved !== null) continue;
    html += '<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg-card)">';
    html += '<div style="font-size:12px;color:var(--text);margin-bottom:6px">🔧 ' + escHtml(t.type) + ': ' + escHtml(t.summary) + '</div>';
    html += '<div style="display:flex;gap:4px">';
    html += '<button class="btn btn-sm btn-primary" onclick="approveTool(\'' + t.id + '\',true)">Approve</button>';
    html += '<button class="btn btn-sm" onclick="approveTool(\'' + t.id + '\',false)">Reject</button>';
    html += '<button class="btn btn-sm" onclick="editTool(\'' + t.id + '\')">Edit</button>';
    html += '</div></div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function approveTool(id, approved) {
  const tool = _chatPendingTools.find(t => t.id === id);
  if (tool) { tool.approved = approved; }
  fetch("/api/chat/approve-tool", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolId: id, approved })
  });
  renderPendingTools();
}

function editTool(id) {
  const tool = _chatPendingTools.find(t => t.id === id);
  if (!tool) return;
  const currentCmd = tool.event?.args?.command || tool.event?.arguments?.command || "";
  openModal("Edit Command",
    '<label>Command</label><textarea id="fEditCmd" rows="3" style="font-family:monospace;font-size:12px">' + escHtml(currentCmd) + '</textarea>',
    () => {
      const newCmd = $("fEditCmd").value.trim();
      if (newCmd && tool.event.args) tool.event.args.command = newCmd;
      if (newCmd && tool.event.arguments) tool.event.arguments.command = newCmd;
      closeModal();
      renderPendingTools();
    });
}

function submitAskResponse() {
  const input = $("askInput");
  if (!input || !input.value.trim()) return;
  // Send response back via tool approval
  fetch("/api/chat/approve-tool", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolId: "ask", approved: true, response: input.value.trim() })
  });
  input.disabled = true;
  input.value = "";
}
```

**Step 3: Verify no syntax errors**

Run: `bun index.ts` and check server starts

**Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: comprehensive tool event handling for 15+ tool types"
```

---

### Task 4: Agent controls in chat header bar

**Files:**
- Modify: `index.ts:594-621` (chat tab HTML)
- Modify: `index.ts:514-618` (CSS for new controls)

**Step 1: Add CSS for chat header bar**

Add to `<style>` before `@media`:
```css
.chat-header { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--border); background:var(--bg-card); flex-wrap:wrap; }
.chat-header select { padding:4px 8px; border:1px solid var(--border); border-radius:6px; font-size:12px; background:var(--bg-card); color:var(--text); cursor:pointer; }
.chat-header .badge { padding:2px 8px; border-radius:10px; font-size:11px; background:var(--bg-code); color:var(--text-secondary); }
.chat-header .badge.active { background:#f0f6ff; color:var(--primary); border:1px solid #cce5ff; }
.chat-stop-btn { padding:4px 12px; border-radius:6px; border:1px solid var(--danger); background:transparent; color:var(--danger); font-size:12px; cursor:pointer; font-weight:600; }
.chat-stop-btn:hover { background:#ffebe9; }
```

**Step 2: Add chat header HTML after the chat-layout div**

Insert before `chat-sidebar` inside `tabChat`:
```html
<div class="chat-header" id="chatHeader" style="display:none">
  <select id="chatModeSelect">
    <option value="autonomous">🤖 Autonomous</option>
    <option value="plan">📋 Plan</option>
    <option value="ask">❓ Ask</option>
  </select>
  <select id="chatModelSelect" style="max-width:180px">
    <option value="">Default model</option>
  </select>
  <button class="chat-stop-btn" id="chatStopBtn" style="display:none">⏹ Stop</button>
  <div style="flex:1"></div>
  <span class="badge" id="chatContextBadge">📎 0 files</span>
  <span class="badge" id="chatCostBadge">💰 $0.0000</span>
  <button class="icon-btn" id="chatDarkToggle" title="Toggle dark mode">🌙</button>
</div>
```

**Step 3: Wire up event handlers in DOMContentLoaded**

Add inside `document.addEventListener("DOMContentLoaded", ...)`:
```js
$("chatModeSelect")?.addEventListener("change", (e) => { _chatMode = e.target.value; });
$("chatDarkToggle")?.addEventListener("click", () => {
  _chatDarkMode = !_chatDarkMode;
  document.body.classList.toggle("dark", _chatDarkMode);
  $("chatDarkToggle").textContent = _chatDarkMode ? "☀️" : "🌙";
});
$("chatStopBtn")?.addEventListener("click", () => {
  if (_chatAbortController) { _chatAbortController.abort(); }
  fetch("/api/chat/stop", { method: "POST" }).catch(() => {});
  $("chatStopBtn").style.display = "none";
});
```

Populate model select when loadChat runs (add after `sidebar.innerHTML = html` in loadChat):
```js
fetch("/api/config").then(r => r.json()).then(cfg => {
  const sel = $("chatModelSelect");
  if (!sel) return;
  const cur = cfg.current || "";
  sel.innerHTML = '<option value="">Default model</option>';
  for (const [prov, data] of Object.entries(cfg.providers || {})) {
    for (const key of Object.keys(data.models || {})) {
      const full = prov + "/" + key;
      sel.innerHTML += '<option value="' + full + '"' + (full === cur ? ' selected' : '') + '>' + full + '</option>';
    }
  }
});
```

**Step 4: Add pending tools container in chat HTML**

Insert before `chat-input-wrapper`:
```html
<div id="chatPendingTools"></div>
```

**Step 5: Show chat header when chat is active**

In `selectChatSession` and `sendChatMessage`, add:
```js
$("chatHeader").style.display = "flex";
```

**Step 6: Show stop button when sending**

In `sendChatMessage`, before fetch:
```js
_chatAbortController = new AbortController();
$("chatStopBtn").style.display = "";
```

After stream ends:
```js
$("chatStopBtn").style.display = "none";
```

**Step 7: Verify**

Run: `bun index.ts` and check chat header appears

**Step 8: Commit**

```bash
git add index.ts
git commit -m "feat: add agent controls header (mode, model, stop, dark mode)"
```

---

### Task 5: File system explorer in chat sidebar

**Files:**
- Modify: `index.ts:594-621` (chat sidebar HTML)
- Modify: `index.ts:316-508` (CSS for file explorer)

**Step 1: Add CSS for file explorer**

```css
.file-explorer { border-bottom:1px solid var(--border); background:var(--bg-card); }
.file-explorer-header { padding:8px 12px; font-size:12px; font-weight:600; color:var(--text-secondary); cursor:pointer; display:flex; align-items:center; gap:4px; user-select:none; }
.file-explorer-header:hover { background:var(--bg-code); }
.file-explorer-tree { padding:4px 0; max-height:200px; overflow-y:auto; font-size:12px; }
.file-item { padding:3px 12px; cursor:pointer; display:flex; align-items:center; gap:4px; color:var(--text); }
.file-item:hover { background:var(--bg-code); color:var(--primary); }
.file-item .icon { width:16px; text-align:center; flex-shrink:0; }
.file-item .fname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file-item.dir { font-weight:500; }
```

**Step 2: Add file explorer HTML in chat sidebar**

Insert at top of `chat-sidebar-list`, before the session list:
```html
<div class="file-explorer">
  <div class="file-explorer-header" onclick="toggleFileExplorer()">
    <span id="feChevron">&#x25BC;</span> Workspace
  </div>
  <div class="file-explorer-tree" id="fileTree"></div>
</div>
```

**Step 3: Add file explorer JS functions**

```js
let _fileExplorerOpen = true;
function toggleFileExplorer() {
  _fileExplorerOpen = !_fileExplorerOpen;
  $("fileTree").style.display = _fileExplorerOpen ? "" : "none";
  $("feChevron").textContent = _fileExplorerOpen ? "\u25BC" : "\u25B6";
}

async function loadFileTree(dir) {
  const container = $("fileTree");
  if (!container) return;
  container.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--text-secondary)">Loading...</div>';
  try {
    const r = await fetch("/api/files/tree?dir=" + encodeURIComponent(dir || ""));
    const d = await r.json();
    if (!d.ok) { container.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--danger)">' + escHtml(d.error) + '</div>'; return; }
    let html = "";
    for (const e of d.entries) {
      const icon = e.type === "directory" ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
      const cls = e.type === "directory" ? "file-item dir" : "file-item";
      html += '<div class="' + cls + '" onclick="' + (e.type === "directory" ? "loadFileTree('" + escHtml(dir + "/" + e.name) + "')" : "previewFile('" + escHtml(dir + "/" + e.name) + "')") + '">';
      html += '<span class="icon">' + icon + '</span><span class="fname">' + escHtml(e.name) + '</span></div>';
    }
    container.innerHTML = html;
  } catch { container.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--danger)">Error loading files</div>'; }
}

let _previewPanel = null;
function previewFile(path) {
  // Create or reuse preview panel
  if (!_previewPanel) {
    _previewPanel = document.createElement("div");
    _previewPanel.id = "filePreview";
    _previewPanel.style.cssText = "position:fixed;right:0;top:0;bottom:0;width:400px;max-width:80vw;background:var(--bg-card);border-left:1px solid var(--border);z-index:300;display:flex;flex-direction:column;box-shadow:-4px 0 12px rgba(0,0,0,0.1)";
    document.body.appendChild(_previewPanel);
  }
  _previewPanel.innerHTML = '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0">' +
    '<span style="font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(path) + '</span>' +
    '<button class="icon-btn" onclick="closePreview()">' + iconX + '</button></div>' +
    '<div style="flex:1;overflow:auto;padding:16px"><div class="loading" style="padding:0">Loading...</div></div>';
  _previewPanel.style.display = "flex";

  fetch("/api/files/read?path=" + encodeURIComponent(path)).then(r => r.json()).then(d => {
    const contentDiv = _previewPanel.querySelector("div:last-child");
    if (d.ok) {
      contentDiv.innerHTML = '<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;color:var(--text);overflow-x:auto;white-space:pre-wrap;word-break:break-all">' + escHtml(d.content) + '</pre>';
    } else {
      contentDiv.innerHTML = '<div style="color:var(--danger);font-size:13px">' + escHtml(d.error) + '</div>';
    }
  });
}

function closePreview() { if (_previewPanel) _previewPanel.style.display = "none"; }
```

**Step 4: Load file tree when chat loads**

In `loadChat()`, after loading sessions:
```js
const cfg = await fetch("/api/config").then(r => r.json()).catch(() => ({}));
const workDir = cfg.raw?.integrations?.github?.workspaceDir || homedir();
loadFileTree(workDir);
```

**Step 5: Verify**

Run: `bun index.ts` and check file explorer appears in chat sidebar

**Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: file explorer with preview panel in chat sidebar"
```

---

### Task 6: Context drawer with file management & git

**Files:**
- Modify: `index.ts:316-508` (CSS for context drawer)
- Modify: `index.ts:594-621` (chat HTML for drawer)
- Modify: `index.ts` close to line 1835 (JS for drawer)

**Step 1: Add CSS for context drawer**

```css
.context-drawer { position:fixed; right:0; top:0; bottom:0; width:320px; max-width:85vw; background:var(--bg-card); border-left:1px solid var(--border); z-index:250; display:none; flex-direction:column; box-shadow:-4px 0 12px rgba(0,0,0,0.1); }
.context-drawer.open { display:flex; }
.context-drawer-header { padding:12px 16px; border-bottom:1px solid var(--border); font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px; }
.context-drawer-body { flex:1; overflow-y:auto; padding:12px 16px; }
.context-section { margin-bottom:16px; }
.context-section-title { font-size:11px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px; }
.context-file-row { display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:4px; font-size:12px; cursor:pointer; }
.context-file-row:hover { background:var(--bg-code); }
.context-file-row .remove-btn { margin-left:auto; color:var(--danger); cursor:pointer; opacity:0; }
.context-file-row:hover .remove-btn { opacity:1; }
```

**Step 2: Add context drawer HTML before `</body>`**

```html
<div class="context-drawer" id="contextDrawer">
  <div class="context-drawer-header">
    <span>📎 Context</span>
    <button class="icon-btn" onclick="closeContextDrawer()">' + iconX + '</button>
  </div>
  <div class="context-drawer-body">
    <div class="context-section">
      <div class="context-section-title">Files in Context (<span id="ctxFileCount">0</span>)</div>
      <div id="ctxFileList"><div style="font-size:12px;color:var(--text-secondary)">No files added.</div></div>
      <button class="btn btn-sm" style="margin-top:8px;width:100%" onclick="addContextFile()">+ Add file</button>
      <button class="btn btn-sm" style="margin-top:4px;width:100%" onclick="copyContext()">📋 Copy context</button>
    </div>
    <div class="context-section">
      <div class="context-section-title">🔀 Git</div>
      <div id="ctxGitInfo"><div style="font-size:12px;color:var(--text-secondary)">Loading...</div></div>
    </div>
    <div class="context-section">
      <div class="context-section-title">💰 Usage</div>
      <div id="ctxUsage"><div style="font-size:12px;color:var(--text-secondary)">No data yet.</div></div>
    </div>
  </div>
</div>
```

**Step 3: Add context drawer JS functions**

```js
function openContextDrawer() {
  $("contextDrawer").classList.add("open");
  loadContextDrawer();
}
function closeContextDrawer() { $("contextDrawer").classList.remove("open"); }

function loadContextDrawer() {
  // Files
  const list = $("ctxFileList");
  if (_chatContextFiles.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">No files added.</div>';
  } else {
    let html = "";
    for (const f of _chatContextFiles) {
      html += '<div class="context-file-row"><span>📄</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px">' + escHtml(f) + '</span><span class="remove-btn" onclick="removeContextFile(\'' + escHtml(f) + '\')">' + iconX + '</span></div>';
    }
    list.innerHTML = html;
  }
  $("ctxFileCount").textContent = _chatContextFiles.length;
  
  // Git info
  fetch("/api/git/status?dir=" + encodeURIComponent(homedir())).then(r => r.json()).then(d => {
    if (d.ok) {
      const count = d.output.trim() ? d.output.split("\n").length : 0;
      $("ctxGitInfo").innerHTML = '<div style="font-size:12px">Branch: main<br>' + (count > 0 ? '<span style="color:var(--danger)">● ' + count + ' uncommitted</span>' : '<span style="color:var(--success)">✔ Clean</span>') + '</div>';
    }
  }).catch(() => { $("ctxGitInfo").innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">Not a git repo</div>'; });
  
  // Usage
  // Updated from chat message tracking
}

function addContextFile() {
  const path = prompt("Enter file path:");
  if (path && path.trim()) {
    _chatContextFiles.push(path.trim());
    loadContextDrawer();
  }
}

function removeContextFile(path) {
  _chatContextFiles = _chatContextFiles.filter(f => f !== path);
  loadContextDrawer();
}

function copyContext() {
  const text = _chatContextFiles.join("\n");
  navigator.clipboard.writeText(text).then(() => showToast("Context copied!")).catch(() => showToast("Failed to copy", true));
}
```

**Step 4: Wire context badge click**

In `DOMContentLoaded`:
```js
$("chatContextBadge")?.addEventListener("click", openContextDrawer);
```

**Step 5: Verify**

Run: `bun index.ts` and check context drawer opens

**Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: context drawer with file management, git status, and usage"
```

---

### Task 7: Thinking indicator & cost tracking in chat bubbles

**Files:**
- Modify: `index.ts:1600-1636` (handleChatEvent inline indicators)
- Modify: `index.ts:1500-1598` (sendChatMessage for cost tracking)

**Step 1: Add thinking indicator inline in handleChatEvent**

For think events, update the streaming text area:
```js
// In handleChatEvent, for "think" type:
if (event.type === "think") {
  textEl.innerHTML = '<div style="font-style:italic;color:var(--text-secondary)">🤔 ' + escHtml(event.thought || "Analyzing...") + '</div>';
  return;
}
```

**Step 2: Track cost in sendChatMessage**

Add after stream completes:
```js
// After stream ends in sendChatMessage, update cost badge:
try {
  const tokensIn = 0; // approximated
  const tokensOut = _currentStreamText.length / 4; // rough char→token estimate
  const cost = (tokensIn * 0.000003 + tokensOut * 0.000015);
  $("chatCostBadge").textContent = "💰 $" + cost.toFixed(4);
} catch(e) {}
```

**Step 3: Verify**

Run: `bun index.ts` and check thinking indicator appears

**Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: thinking indicator and cost tracking in chat"
```

---

### Task 8: Mode-aware sendChatMessage with AbortController

**Files:**
- Modify: `index.ts:1500-1598` (sendChatMessage function)

**Step 1: Integrate AbortController into sendChatMessage**

Wrap fetch with AbortController signal:
```js
_chatAbortController = new AbortController();
const signal = _chatAbortController.signal;
$("chatStopBtn").style.display = "";

const r = await fetch("/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal
});
```

**Step 2: Pass mode to API**

In payload, add:
```js
payload.mode = _chatMode;
```

**Step 3: Handle abort error**

In catch block of sendChatMessage:
```js
catch (e) {
  if (e.name === "AbortError") {
    const pending = $("chatPending");
    if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:var(--text-secondary)">⏹ Stopped</div></div>';
  } else {
    // existing error handling
  }
}
```

**Step 4: Verify**

Run: `bun index.ts` and test stop button

**Step 5: Commit**

```bash
git add index.ts
git commit -m "feat: abort controller for stop button and mode-aware chat"
```

---

### Task 9: Comprehensive testing & bug fixes

**Files:**
- Test: `index.ts`

**Step 1: Run server and test all endpoints**

```bash
bun index.ts &
sleep 2
# Test config
curl -s http://localhost:2084/api/config | head -c 100
# Test files
curl -s "http://localhost:2084/api/files/tree?dir=." | head -c 200
# Test file read
curl -s "http://localhost:2084/api/files/read?path=package.json" | head -c 200
# Test git
curl -s "http://localhost:2084/api/git/status" | head -c 200
# Test stop
curl -s -X POST http://localhost:2084/api/chat/stop
# Test approve-tool
curl -s -X POST -H "content-type: application/json" -d '{"toolId":"test","approved":true}' http://localhost:2084/api/chat/approve-tool
kill %1
```

**Step 2: Fix any bugs found**

Fix any issues from testing

**Step 3: Verify UI renders without JS errors**

Open http://localhost:2084 and check browser console for errors

**Step 4: Commit**

```bash
git add index.ts
git commit -m "fix: bugs found during integration testing"
```
