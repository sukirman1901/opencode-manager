#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "2084");

// --- Dynamic path detection ---
function findPaths() {
  const home = homedir();
  const envConfig = process.env.OPENCODE_CONFIG;
  const envData = process.env.OPENCODE_DATA;

  // All possible locations for OpenCode config (in priority order)
  const configCandidates = [
    envConfig,
    join(home, ".config/opencode/opencode.json"),
    join(home, ".config/opencode/config.json"),
    join(home, ".opencode/config.json"),
    join(home, ".config/opencode/opencode.jsonc"),
  ].filter(Boolean) as string[];

  // Known possible locations for OpenCode data directory
  const dataCandidates = envData
    ? [envData]
    : [
        join(home, ".local/share/opencode"),
        join(home, ".opencode"),
        join(home, ".config/opencode"),
      ];

  // Find ALL existing config files (not just the first)
  const configPaths = configCandidates.filter(p => existsSync(p));

  let dataDir = "";
  for (const d of dataCandidates) {
    const db = join(d, "opencode.db");
    if (existsSync(db)) { dataDir = d; break; }
  }

  return { configPaths, primaryConfig: configPaths[0] || "", dataDir, dbPath: dataDir ? join(dataDir, "opencode.db") : "" };
}

let _paths = findPaths();
let _configCache: { data: any; time: number } | null = null;
let _builtInProviders: Record<string, string[]> | null = null;
let _db: { conn: Database; path: string } | null = null;

// Eagerly attempt SDK init (background)
setTimeout(() => initSDK(), 0);

// --- SDK client (optional, for connecting to running OpenCode server) ---
let _sdkClient: any = null;

async function initSDK() {
  const sdkPath = join(homedir(), ".opencode/node_modules/@opencode-ai/sdk/dist/client.js");
  try {
    if (!existsSync(sdkPath)) return null;
    const mod = await import(sdkPath);
    _sdkClient = mod.createOpencodeClient({ baseUrl: process.env.OPENCODE_SERVER || "http://127.0.0.1:17497" });
    return _sdkClient;
  } catch {}
  return null;
}

async function fetchConfigViaSDK() {
  if (!_sdkClient) await initSDK();
  if (!_sdkClient) return null;
  try {
    const pathRes = await _sdkClient.path.get();
    const pathInfo = (pathRes as any)?.data || pathRes;
    if (pathInfo?.config) {
      _paths.primaryConfig = pathInfo.config;
      if (!_paths.configPaths.includes(pathInfo.config)) _paths.configPaths.unshift(pathInfo.config);
    }
    if (pathInfo?.state) {
      _paths.dataDir = pathInfo.state;
      const sdkDbPath = join(pathInfo.state, "opencode.db");
      if (existsSync(sdkDbPath)) _paths.dbPath = sdkDbPath;
    }
  } catch {}
  // SDK config.get() returns stale startup config — always read from files
  return null;
}

async function readConfig() {
  const sdkCfg = await fetchConfigViaSDK();
  if (sdkCfg) {
    const providers: Record<string, any> = {};

    // Step 1: Get configured models from SDK config (only what user configured)
    if (sdkCfg.provider) {
      for (const [name, data] of Object.entries(sdkCfg.provider)) {
        providers[name] = {
          npm: (data as any).npm,
          options: (data as any).options || {},
          models: (data as any).models || {},
        };
      }
    }

    // Step 2: Add built-in providers (opencode, opencode-go) from SDK provider list
    // These are NOT in config files but ARE shown by `opencode models` CLI.
    try {
      if (_sdkClient?.provider?.list) {
        const provList = await _sdkClient.provider.list();
        const provArr = (provList as any)?.data?.all || (provList as any)?.all || provList || [];
        for (const p of provArr) {
          const name = p.id || p.name;
          if (!name || providers[name]) continue;
          if (name === "opencode" || name === "opencode-go") {
            const models: Record<string, any> = {};
            if (p.models) {
              for (const [mk, mv] of Object.entries(p.models)) {
                models[mk] = { name: (mv as any).name || mk };
              }
            }
            providers[name] = { npm: "", options: {}, models };
          }
        }
      }
    } catch {}

    _configCache = { data: { current: sdkCfg.model || "", providers, raw: sdkCfg }, time: Date.now() };
    return _configCache.data;
  }

  // Fallback: merge all discovered config files (with cache)
  if (_configCache && Date.now() - _configCache.time < 2000) {
    return _configCache.data;
  }
  _paths = findPaths();
  if (!_paths.configPaths.length) return { current: "", providers: {}, raw: {} };

  let merged: any = { provider: {} };
  let currentModel = "";

  for (const cp of _paths.configPaths) {
    try {
      const raw = JSON.parse(readFileSync(cp, "utf-8"));
      const provSource = raw.provider || raw.providers || {};
      for (const [name, data] of Object.entries(provSource)) {
        if (merged.provider[name]) {
          // Merge models from both configs
          const existing = merged.provider[name].models || {};
          merged.provider[name] = {
            ...data,
            models: { ...existing, ...((data as any).models || {}) },
          };
        } else {
          merged.provider[name] = data;
        }
      }
      if (!currentModel && raw.model) currentModel = raw.model;
      // Merge plugins, agents, etc.
      if (raw.plugin) merged.plugin = [...new Set([...(merged.plugin || []), ...raw.plugin])];
      if (raw.agent) merged.agent = { ...(merged.agent || {}), ...raw.agent };
      if (raw.plugins) merged.plugins = [...new Set([...(merged.plugins || []), ...raw.plugins])];
      if (raw.agents) merged.agents = { ...(merged.agents || {}), ...raw.agents };
    } catch {}
  }

  const providers: Record<string, any> = {};
  for (const [name, data] of Object.entries(merged.provider)) {
    providers[name] = {
      npm: (data as any).npm,
      options: (data as any).options || {},
      models: (data as any).models || {},
    };
  }
  // Supplement with built-in providers from `opencode models` CLI (cached)
  if (!_builtInProviders) {
    try {
      const opencodeBin = process.env.OPENCODE_BIN || `${homedir()}/.opencode/bin/opencode`;
      const proc = Bun.spawnSync([opencodeBin, "models"], {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      if (proc.exitCode === 0) {
        _builtInProviders = {};
        const lines = proc.stdout.toString().trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const idx = line.indexOf("/");
          if (idx === -1) continue;
          const prov = line.slice(0, idx);
          const model = line.slice(idx + 1);
          if (!_builtInProviders[prov]) _builtInProviders[prov] = [];
          _builtInProviders[prov].push(model);
        }
      }
    } catch {}
  }
  if (_builtInProviders) {
    for (const [prov, models] of Object.entries(_builtInProviders)) {
      if (providers[prov]) continue; // already from config
      providers[prov] = { npm: "", options: {}, models: {} };
      for (const mk of models) {
        providers[prov].models[mk] = { name: mk };
      }
    }
  }

  _configCache = { data: { current: currentModel, providers, raw: merged }, time: Date.now() };
  return _configCache.data;
}

async function writeConfig(updater: (cfg: any) => any, targetProvider?: string, targetKey?: string) {
  // NOTE: SDK config.update() (PATCH) returns updated config but doesn't persist
  // to disk. Always write to files directly for reliable persistence.

  _paths = findPaths();
  let targetFile = _paths.primaryConfig;

  if (_paths.configPaths.length > 1) {
    // For plugins/agents: find which config has the item
    if (!targetProvider && targetKey) {
      for (const cp of _paths.configPaths) {
        try {
          const raw = JSON.parse(readFileSync(cp, "utf-8"));
          const plugins = raw.plugin || [];
          const agents = raw.agent || {};
          if (plugins.includes(targetKey) || agents[targetKey]) { targetFile = cp; break; }
        } catch {}
      }
    } else if (targetProvider) {
      for (const cp of _paths.configPaths) {
        try {
          const raw = JSON.parse(readFileSync(cp, "utf-8"));
          const provSource = raw.provider || raw.providers || {};
          if (provSource[targetProvider]) { targetFile = cp; break; }
        } catch {}
      }
    }
  }

  if (!targetFile) throw new Error("No config file found");
  const raw = JSON.parse(readFileSync(targetFile, "utf-8"));
  const updated = updater(raw);
  writeFileSync(targetFile, JSON.stringify(updated, null, 2));
  _configCache = null;
}

function getDB() {
  if (_paths.dbPath && existsSync(_paths.dbPath)) {
    if (!_db || _db.path !== _paths.dbPath) {
      _db?.conn.close();
      _db = { conn: new Database(_paths.dbPath), path: _paths.dbPath };
    }
    return _db.conn;
  }
  return null;
}

// --- CORS & helpers ---
function cors(r: Response) { r.headers.set("access-control-allow-origin", "*"); return r; }
function json(d: any, s = 200) { return cors(new Response(JSON.stringify(d), { s, headers: { "content-type": "application/json" } })); }
function html(s: string) { return cors(new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } })); }

// --- Web UI (unchanged) ---
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenCode Manager</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f5f6f8; color: #24292f; min-height: 100vh; -webkit-font-smoothing: antialiased; }
  .layout { display: flex; min-height: 100vh; }
  .sidebar { width: 220px; background: #fff; border-right: 1px solid #d0d7de; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-brand { padding: 18px 20px; font-size: 15px; font-weight: 600; color: #1f2328; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d0d7de; cursor: pointer; }
  .sidebar-brand svg { width: 18px; height: 18px; color: #656d76; }
  .sidebar-nav { padding: 8px; flex: 1; }
  .sidebar-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; color: #656d76; cursor: pointer; transition: all .1s; }
  .sidebar-item:hover { background: #f3f4f6; color: #1f2328; }
  .sidebar-item.active { background: #e8f0fe; color: #0969da; font-weight: 600; }
  .sidebar-item svg { width: 16px; height: 16px; flex-shrink: 0; }
  .sidebar-footer { padding: 12px 16px; border-top: 1px solid #d0d7de; font-size: 11px; color: #8c959f; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { display: flex; align-items: center; gap: 8px; padding: 18px 20px; border-bottom: 1px solid #d0d7de; background: #fff; }
  .topbar h1 { font-size: 15px; font-weight: 600; color: #1f2328; }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .model-bar { margin: 16px 20px 0; padding: 14px 18px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; }
  .model-bar-label { font-size: 11px; font-weight: 500; color: #656d76; text-transform: uppercase; letter-spacing: .04em; }
  .model-bar-id { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 14px; color: #0969da; margin-top: 2px; word-break: break-all; }
  .content { padding: 16px 20px 24px; flex: 1; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .search-wrap { position: relative; flex: 1; min-width: 160px; }
  .search-wrap input { width: 100%; padding: 7px 12px 7px 32px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; color: #24292f; font-size: 13px; outline: none; }
  .search-wrap input:focus { border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.15); }
  .search-wrap input::placeholder { color: #8c959f; }
  .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #8c959f; font-size: 13px; pointer-events: none; }
  .providers { display: flex; flex-direction: column; gap: 10px; }
  .provider { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  .provider-header { padding: 12px 16px; display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; border-bottom: 1px solid #d0d7de; }
  .provider-header:hover { background: #f8f9fa; }
  .provider-chevron { color: #8c959f; font-size: 10px; transition: transform .2s; width: 14px; text-align: center; }
  .provider-chevron.open { transform: rotate(90deg); }
  .provider-name { font-size: 14px; font-weight: 600; color: #1f2328; }
  .provider-npm { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 11px; color: #656d76; background: #f3f4f6; padding: 1px 8px; border-radius: 4px; }
  .provider-badge { font-size: 11px; color: #656d76; background: #f3f4f6; padding: 1px 8px; border-radius: 10px; margin-left: auto; }
  .provider-actions { display: flex; gap: 4px; margin-left: 4px; }
  .provider-actions button { background: none; border: none; color: #656d76; cursor: pointer; padding: 3px 6px; border-radius: 4px; font-size: 13px; }
  .provider-actions button:hover { background: #e8eaed; }
  .provider-actions .del-prov-btn:hover { color: #cf222e; }
  .provider-models { display: none; }
  .provider-models.open { display: block; }
  .model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; padding: 12px 16px; }
  .model-card { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; border: 1px solid #d0d7de; cursor: pointer; transition: all .1s; }
  .model-card:hover { border-color: #0969da; background: #f8fbff; }
  .model-card.active { border-color: #1a7f37; background: #f0fff4; }
  .model-card-indicator { width: 6px; height: 6px; border-radius: 50%; background: #d0d7de; flex-shrink: 0; }
  .model-card.active .model-card-indicator { background: #1a7f37; box-shadow: 0 0 4px rgba(26,127,55,.3); }
  .model-card-name { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; color: #24292f; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .model-card.active .model-card-name { color: #1a7f37; font-weight: 600; }
  .model-card-actions { display: none; gap: 2px; flex-shrink: 0; }
  .model-card:hover .model-card-actions { display: flex; }
  .model-card-actions button { background: none; border: none; color: #656d76; cursor: pointer; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  .model-card-actions button:hover { background: #e8eaed; }
  .model-card-actions .edit-action:hover { color: #9a6700; }
  .model-card-actions .del-action:hover { color: #cf222e; }
  .empty-models { padding: 24px 16px; text-align: center; color: #656d76; font-size: 13px; }
  .btn { display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; padding: 6px 14px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; color: #24292f; white-space: nowrap; transition: background .1s; }
  .btn:hover { background: #e8eaed; }
  .btn-primary { background: #0969da; border-color: #0969da; color: #fff; }
  .btn-primary:hover { background: #0550ae; }
  .btn-sm { padding: 3px 8px; font-size: 11px; gap: 3px; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 10px 20px; border-radius: 8px; font-size: 13px; background: #1a7f37; color: #fff; opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none; z-index: 100; transform: translateY(8px); }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.error { background: #cf222e; }
  .loading { text-align: center; padding: 48px; color: #656d76; font-size: 14px; }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(27,31,35,.5); z-index: 200; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 28px; width: 420px; max-width: 92vw; box-shadow: 0 8px 32px rgba(0,0,0,.12); }
  .modal-title { font-size: 16px; font-weight: 600; color: #1f2328; margin-bottom: 20px; }
  .modal-body label { display: block; font-size: 12px; font-weight: 500; color: #656d76; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
  .modal-body input, .modal-body select, .modal-body textarea { width: 100%; padding: 8px 12px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; color: #24292f; font-family: inherit; font-size: 13px; margin-bottom: 14px; outline: none; transition: border-color .1s; }
  .modal-body input:focus, .modal-body select:focus, .modal-body textarea:focus { border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.15); }
  .modal-body select { cursor: pointer; appearance: none; -webkit-appearance: none; padding-right: 32px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23656d76' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; background-size: 12px; }
  .modal-body select:hover { border-color: #8c959f; }
  .modal-body input[readonly] { opacity: .5; cursor: not-allowed; }
  .modal-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .usage-card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; }
  .usage-card-label { font-size: 11px; color: #656d76; text-transform: uppercase; letter-spacing: .05em; }
  .usage-card-value { font-size: 22px; font-weight: 600; color: #1f2328; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .usage-card-note { font-size: 11px; color: #656d76; margin-top: 2px; }
  .usage-section-title { font-size: 13px; font-weight: 600; color: #1f2328; margin-bottom: 10px; }
  .usage-table-wrap { overflow-x: auto; margin-bottom: 20px; border: 1px solid #d0d7de; border-radius: 8px; background: #fff; }
  .usage-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .usage-table th { text-align: left; padding: 8px 12px; color: #656d76; font-weight: 500; border-bottom: 1px solid #d0d7de; background: #f6f8fa; white-space: nowrap; }
  .usage-table td { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; color: #24292f; white-space: nowrap; }
  .usage-table tr:hover td { background: #f8fbff; }
  .usage-table .model-cell { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 11px; color: #0969da; }
  .usage-table .when-cell { color: #656d76; font-size: 11px; }
  .usage-table .num-cell { font-variant-numeric: tabular-nums; text-align: right; }
  .usage-table .cost-cell { font-variant-numeric: tabular-nums; text-align: right; }
  .section-title { font-size: 13px; font-weight: 600; color: #1f2328; margin-bottom: 10px; }
  .plugin-list, .agent-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }
  .plugin-item, .agent-card { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; }
  .plugin-url { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; color: #0969da; flex: 1; word-break: break-all; }
  .agent-card { flex-wrap: wrap; }
  .agent-name { font-size: 13px; font-weight: 600; color: #1f2328; min-width: 100px; }
  .agent-meta { font-size: 11px; color: #656d76; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; flex: 1; }
  .agent-desc { font-size: 11px; color: #656d76; width: 100%; margin-top: 2px; }
  .menu-toggle { background: none; border: none; color: #656d76; cursor: pointer; padding: 4px 6px; border-radius: 4px; display: flex; align-items: center; font-size: 20px; line-height: 1; }
  .menu-toggle:hover { background: #f3f4f6; color: #1f2328; }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(27,31,35,.5); z-index: 99; }
  .sidebar-overlay.open { display: block; }
  @media (min-width: 768px) {
    .sidebar { transition: width .2s ease; }
    .sidebar.collapsed { width: 0 !important; overflow: hidden; border-right: none; }
    .sidebar.collapsed .sidebar-brand,
    .sidebar.collapsed .sidebar-nav,
    .sidebar.collapsed .sidebar-footer { display: none; }
    .sidebar.collapsed + .main .menu-toggle { display: flex; }
    .menu-toggle { display: none; }
  }
  @media (max-width: 767px) {
    .sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 100; transform: translateX(-100%); transition: transform .2s; }
    .sidebar.open { transform: translateX(0); }
    .menu-toggle { display: flex; }
    .model-grid { grid-template-columns: 1fr; }
    .toolbar { flex-direction: column; }
    .search-wrap { min-width: 0; }
    .usage-grid { grid-template-columns: 1fr 1fr; }
    .content { padding: 12px 12px 20px; }
    .model-bar { margin: 12px 12px 0; }
    .topbar { padding: 12px 12px; }
  }
  .session-card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; cursor: pointer; transition: border-color .1s; }
  .session-card:hover { border-color: #0969da; }
  .session-card-title { font-size: 14px; font-weight: 600; color: #1f2328; }
  .session-card-meta { font-size: 11px; color: #656d76; margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
  .session-card-meta span { display: inline-flex; align-items: center; gap: 3px; }
  .session-card .model-tag { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 11px; color: #0969da; background: #f0f6ff; padding: 1px 6px; border-radius: 4px; }
  .detail-header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .detail-header h2 { font-size: 15px; font-weight: 600; color: #1f2328; flex: 1; }
  .msg-row { display: flex; gap: 8px; padding: 10px 14px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 6px; }
  .msg-role { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; min-width: 70px; padding-top: 1px; }
  .msg-role.user { color: #0969da; }
  .msg-role.assistant { color: #1a7f37; }
  .msg-role.tool { color: #9a6700; }
  .msg-info { font-size: 11px; color: #656d76; }
  .session-empty { text-align: center; padding: 48px; color: #656d76; font-size: 13px; }
  .chat-layout { display: flex; gap: 0; height: calc(100vh - 140px); }
  .chat-sidebar { width: 200px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid #d0d7de; padding: 8px; }
  .chat-sidebar-item { padding: 8px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; color: #656d76; margin-bottom: 2px; }
  .chat-sidebar-item:hover { background: #f3f4f6; color: #1f2328; }
  .chat-sidebar-item.active { background: #e8f0fe; color: #0969da; font-weight: 600; }
  .chat-sidebar-item .chat-sidebar-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-sidebar-item .chat-sidebar-meta { font-size: 10px; color: #8c959f; margin-top: 1px; }
  .chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .chat-msgs { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .chat-bubble { margin-bottom: 10px; max-width: 85%; }
  .chat-bubble.user { margin-left: auto; }
  .chat-bubble.assistant { margin-right: auto; }
  .chat-bubble-inner { padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5; word-break: break-word; white-space: pre-wrap; }
  .chat-bubble.user .chat-bubble-inner { background: #0969da; color: #fff; border-bottom-right-radius: 2px; }
  .chat-bubble.assistant .chat-bubble-inner { background: #f3f4f6; color: #24292f; border-bottom-left-radius: 2px; }
  .chat-bubble .chat-bubble-time { font-size: 10px; color: #8c959f; margin-top: 3px; }
  .chat-bubble.user .chat-bubble-time { text-align: right; }
  .chat-input-bar { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #d0d7de; background: #fff; }
  .chat-input-bar textarea { flex: 1; resize: none; padding: 8px 12px; border: 1px solid #d0d7de; border-radius: 8px; font-family: inherit; font-size: 13px; outline: none; }
  .chat-input-bar textarea:focus { border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.15); }
  .chat-input-bar button { align-self: flex-end; }
  .chat-welcome { text-align: center; padding: 48px 16px; color: #656d76; font-size: 13px; }
  .chat-welcome .new-session-btn { margin-top: 12px; }
  .chat-loading { text-align: center; padding: 24px; color: #8c959f; font-size: 12px; }
  @media (max-width: 767px) {
    .chat-sidebar { display: none; }
    .chat-bubble { max-width: 95%; }
  }
</style>
</head>
<body>
<div class="layout">
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>
  <div class="sidebar" id="sidebar">
    <div class="sidebar-brand" onclick="switchTab('models')">
      <svg viewBox="0 0 24 24" fill="none"><rect x="2" y="12" width="6" height="10" rx="1" fill="currentColor" opacity=".7"/><rect x="2" y="4" width="6" height="8" rx="1" fill="currentColor" opacity=".35"/><rect x="10" y="12" width="6" height="10" rx="1" fill="currentColor" opacity=".7"/><rect x="10" y="4" width="6" height="8" rx="1" fill="currentColor" opacity=".35"/><rect x="18" y="4" width="6" height="18" rx="1" fill="currentColor" opacity=".7"/><rect x="18" y="8" width="6" height="4" rx="1" fill="currentColor" opacity=".35"/></svg>
      OpenCode
    </div>
    <div class="sidebar-nav">
      <div class="sidebar-item active" data-tab="models" onclick="switchTab('models')">
        <svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        Models
      </div>
      <div class="sidebar-item" data-tab="usage" onclick="switchTab('usage')">
        <svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="10" width="3" height="5" rx=".5"/><rect x="6.5" y="5" width="3" height="10" rx=".5"/><rect x="11" y="7" width="3" height="8" rx=".5"/></svg>
        Usage
      </div>
      <div class="sidebar-item" data-tab="plugins" onclick="switchTab('plugins')">
        <svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="9" height="11" rx="1.5"/><circle cx="11" cy="7" r="2.5"/></svg>
        Plugins
      </div>
      <div class="sidebar-item" data-tab="sessions" onclick="switchTab('sessions')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
        Sessions
      </div>
      <div class="sidebar-item" data-tab="chat" onclick="switchTab('chat')">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v9H5.5L2 14V2z"/></svg>
        Chat
      </div>
    </div>
    <div class="sidebar-footer">OpenCode Manager</div>
  </div>
  <div class="main">
    <div class="topbar">
      <button class="menu-toggle" id="menuToggle" onclick="toggleSidebar()">&#x2630;</button>
      <h1 id="pageTitle">Models</h1>
      <div class="topbar-right">
        <button class="btn btn-sm" id="btnRefresh" style="font-size:13px">&#x21bb;</button>
      </div>
    </div>
    <div class="model-bar">
      <div>
        <div class="model-bar-label">Active Model</div>
        <div class="model-bar-id" id="currentModel">&mdash;</div>
      </div>
    </div>
    <div class="content">
      <div class="tab-content active" id="tabModels">
        <div class="toolbar">
          <div class="search-wrap">
            <span class="search-icon">&#x1F50D;</span>
            <input id="searchInput" placeholder="Search models..." autocomplete="off">
          </div>
          <button class="btn btn-primary" id="btnAddModel">+ Add Model</button>
          <button class="btn" id="btnAddProvider">+ Provider</button>
        </div>
        <div class="providers" id="providers"><div class="loading">Loading...</div></div>
      </div>
      <div class="tab-content" id="tabUsage">
        <div id="usageContent"><div class="loading">Loading...</div></div>
      </div>
      <div class="tab-content" id="tabPlugins">
        <div id="pluginsContent"><div class="loading">Loading...</div></div>
      </div>
      <div class="tab-content" id="tabSessions">
        <div id="sessionsList"></div>
        <div id="sessionDetail" style="display:none"></div>
      </div>
      <div class="tab-content" id="tabChat">
        <div class="chat-layout">
          <div class="chat-sidebar" id="chatSessionList"></div>
          <div class="chat-main" id="chatMain">
            <div id="chatMessages" class="chat-msgs"></div>
            <div class="chat-input-bar">
              <textarea id="chatInput" rows="2" placeholder="Type a message..." autocomplete="off"></textarea>
              <button class="btn btn-primary" id="chatSendBtn">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-title" id="modalTitle">Add Model</div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-buttons">
      <button class="btn" id="modalCancel">Cancel</button>
      <button class="btn btn-primary" id="modalOk">Save</button>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let modalCallback = null;
let searchTimer = null;

function toast(msg, err) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " error" : "");
  setTimeout(() => t.classList.remove("show"), 2500);
}

function openModal(title, bodyHtml, cb) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  $("modalOverlay").classList.add("open");
  modalCallback = cb;
  setTimeout(() => $("modalBody").querySelector("input,select")?.focus(), 100);
}

function closeModal() { $("modalOverlay").classList.remove("open"); modalCallback = null; $("modalOk").textContent = "Save"; }

function showConfirmModal(msg, confirmText, cb) {
  $("modalTitle").textContent = "Confirm";
  $("modalBody").innerHTML = '<p style="font-size:13px;color:#656d76">' + msg + '</p>';
  $("modalOk").textContent = confirmText || "Delete";
  $("modalOverlay").classList.add("open");
  modalCallback = cb;
}

$("modalCancel").addEventListener("click", closeModal);
$("modalOverlay").addEventListener("click", (e) => { if (e.target === $("modalOverlay")) closeModal(); });
$("modalOk").addEventListener("click", () => { if (modalCallback) modalCallback(); });

$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(filterModels, 200);
});

function filterModels() {
  const q = $("searchInput").value.toLowerCase().trim();
  document.querySelectorAll(".provider").forEach(p => {
    let hasMatch = false;
    p.querySelectorAll(".model-card").forEach(m => {
      const name = m.querySelector(".model-card-name")?.textContent?.toLowerCase() || "";
      const match = !q || name.includes(q);
      m.style.display = match ? "" : "none";
      if (match) hasMatch = true;
    });
    const body = p.querySelector(".provider-models");
    if (body) body.classList.toggle("open", !q || hasMatch);
    const empty = p.querySelector(".empty-models");
    if (empty) empty.style.display = (!q && hasMatch) || q ? "none" : "";
    p.style.display = q && !hasMatch ? "none" : "";
  });
}

function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function renderMd(t) {
  if (!t) return "";
  var s = escHtml(t);
  var nl = String.fromCharCode(10);
  var bt = String.fromCharCode(96);
  var bs = String.fromCharCode(92);
  var tbt = bt + bt + bt;
  // code blocks
  var cb = tbt + tbt;
  var cp = s.split(cb);
  if (cp.length > 1) {
    var out = cp[0];
    for (var i = 1; i < cp.length; i++) {
      var lf = cp[i].indexOf(nl);
      var lang = lf > 0 ? escHtml(cp[i].slice(0, lf).trim()) : '';
      var code = lf > 0 ? cp[i].slice(lf + 1) : cp[i];
      var endTag = tbt + String.fromCharCode(36);
      if (code.slice(-4) === endTag) code = code.slice(0, -4);
      out += (lang ? '<pre><code class="lang-'+lang+'">' : '<pre><code>') + code + '</code></pre>';
      if (cp[i + 1]) { out += cp[++i]; }
    }
    s = out;
  }
  // inline code
  var ic = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
  s = s.replace(ic, '<code>$1</code>');
  // bold/italic (build regex with char codes to avoid Bun template literal escape bugs)
  var st = bs + '*';
  var bbb = new RegExp(st+st+st+'(.+?)'+st+st+st, 'g');
  s = s.replace(bbb, '<strong><em>$1</em></strong>');
  var bb = new RegExp(st+st+'(.+?)'+st+st, 'g');
  s = s.replace(bb, '<strong>$1</strong>');
  var bi = new RegExp(st+'([^*'+String.fromCharCode(92)+'n]+?)'+st, 'g');
  s = s.replace(bi, '<em>$1</em>');
  // headers (check line starts) and HR
  var lines = s.split(nl);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.slice(0, 5) === '#### ') { lines[i] = '<h4>' + l.slice(5) + '</h4>'; }
    else if (l.slice(0, 4) === '### ') { lines[i] = '<h3>' + l.slice(4) + '</h3>'; }
    else if (l.slice(0, 3) === '## ') { lines[i] = '<h2>' + l.slice(3) + '</h2>'; }
    else if (l.slice(0, 2) === '# ') { lines[i] = '<h1>' + l.slice(2) + '</h1>'; }
    else if (l === '---') { lines[i] = '<hr>'; }
  }
  s = lines.join(nl);
  // lists
  var html = '';
  var inUl = false, inOl = false;
  var ws = bs + 's';
  var ulREstr = '^[' + ws + ']*[-*]' + ws + '+(.+)';
  var ulRE = new RegExp(ulREstr);
  var olREstr = '^[' + ws + ']*[0-9]+' + bs + '.' + ws + '+(.+)';
  var olRE = new RegExp(olREstr);
  lines = s.split(nl);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var isCodeLine = line.indexOf('<pre>') === 0 || line.indexOf('</pre>') === 0;
    var inCode = isCodeLine || (i > 0 && lines[i-1].indexOf('<pre>') === 0 && line.indexOf('</pre>') === -1);
    var um = !inCode ? line.match(ulRE) : null;
    var om = !inCode ? line.match(olRE) : null;
    if (um) {
      if (inOl) { html += '</ol>' + nl; inOl = false; }
      if (!inUl) { html += '<ul>' + nl; inUl = true; }
      html += '<li>' + um[1] + '</li>' + nl;
    } else if (om) {
      if (inUl) { html += '</ul>' + nl; inUl = false; }
      if (!inOl) { html += '<ol>' + nl; inOl = true; }
      html += '<li>' + om[1] + '</li>' + nl;
    } else {
      if (inUl) { html += '</ul>' + nl; inUl = false; }
      if (inOl) { html += '</ol>' + nl; inOl = false; }
      if (line === '<hr>' || line.slice(0, 3) === '<h1' || line.slice(0, 3) === '<h2' || line.slice(0, 3) === '<h3' || line.slice(0, 3) === '<h4' || isCodeLine) {
        html += line + nl;
      } else if (line.trim() === '') {
        html += nl;
      } else {
        html += '<p>' + line + '</p>' + nl;
      }
    }
  }
  if (inUl) html += '</ul>' + nl;
  if (inOl) html += '</ol>' + nl;
  return html;
}
function fmtNum(n) { return Number(n).toLocaleString(); }
function fmtTime(ts) {
  const d = new Date(ts);
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

function switchTab(name) {
  document.querySelectorAll(".sidebar-item").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === "tab" + name.charAt(0).toUpperCase() + name.slice(1)));
  $("pageTitle").textContent = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === "usage") loadUsage();
  else if (name === "plugins") loadPlugins();
  else if (name === "sessions") loadSessions();
  else if (name === "chat") loadChat();
  if (window.innerWidth <= 767) toggleSidebar();
}

function toggleSidebar() {
  const s = document.getElementById("sidebar");
  const o = document.getElementById("sidebarOverlay");
  if (window.innerWidth <= 767) {
    s.classList.toggle("open");
    o.classList.toggle("open");
  } else {
    s.classList.toggle("collapsed");
  }
}

async function loadModels() {
  const r = await fetch("/api/config");
  const cfg = await r.json();
  $("currentModel").textContent = cfg.current || "(none)";

  let html = "";
  for (const [prov, data] of Object.entries(cfg.providers)) {
    const total = Object.keys(data.models).length;
    const npm = data.npm ? '<span class="provider-npm">' + data.npm + "</span>" : "";
    html += '<div class="provider" data-prov="' + prov + '">';
    html += '<div class="provider-header">';
      html += '<span class="provider-chevron open">&#x25B6;</span>';
      html += '<span class="provider-name">' + prov + "</span>";

      html += npm;
      html += '<span class="provider-badge">' + total + " model" + (total !== 1 ? "s" : "") + "</span>";
      html += '<div class="provider-actions">';
    html += '<button class="add-model-btn" data-prov="' + prov + '" title="Add model">+</button>';
    html += '<button class="del-prov-btn" data-prov="' + prov + '" title="Delete provider">&#x2715;</button>';
    html += "</div></div>";
    html += '<div class="provider-models open"><div class="model-grid">';
    if (total === 0) {
      html += '<div class="empty-models">No models. Click + to add one.</div>';
    } else {
      for (const [key, val] of Object.entries(data.models)) {
        const fullId = prov + "/" + key;
        const active = fullId === cfg.current;
        html += '<div class="model-card' + (active ? " active" : "") + '" data-model="' + fullId + '">';
        html += '<span class="model-card-indicator"></span>';
        html += '<span class="model-card-name" title="' + (val.name || key) + '">' + (val.name || key) + "</span>";
        html += '<span class="model-card-actions">';
        html += '<button class="edit-action" data-action="edit" data-model="' + fullId + '" title="Edit">&#x270E;</button>';
        html += '<button class="del-action" data-action="del" data-model="' + fullId + '" title="Delete">&#x2715;</button>';
        html += '</span></div>';
      }
    }
    html += "</div></div></div>";
  }
  $("providers").innerHTML = html;
  filterModels();
}

async function loadUsage() {
  try {
    const r = await fetch("/api/usage");
    if (!r.ok) { $("usageContent").innerHTML = '<div class="loading">Usage data unavailable</div>'; return; }
    const d = await r.json();
    const s = d.summary;
    let html = '<div class="usage-grid">';
    html += '<div class="usage-card"><div class="usage-card-label">Total Requests</div><div class="usage-card-value">' + fmtNum(s.requests) + '</div></div>';
    html += '<div class="usage-card"><div class="usage-card-label">Input Tokens</div><div class="usage-card-value">' + fmtNum(s.tokens_in) + '</div></div>';
    html += '<div class="usage-card"><div class="usage-card-label">Output Tokens</div><div class="usage-card-value">' + fmtNum(s.tokens_out) + '</div></div>';
    html += '<div class="usage-card"><div class="usage-card-label">Est. Cost</div><div class="usage-card-value">$' + Number(s.cost).toFixed(4) + '</div><div class="usage-card-note">From DB, not actual billing</div></div>';
    html += '</div>';

    if (d.recent.length) {
      html += '<div class="usage-section-title">Recent Requests</div>';
      html += '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Model</th><th class="num-cell">In</th><th class="num-cell">Out</th><th>When</th></tr></thead><tbody>';
      for (const r of d.recent) {
        html += '<tr><td class="model-cell">' + r.model + '</td><td class="num-cell">' + fmtNum(r.tokens_input) + '&#8593;</td><td class="num-cell">' + fmtNum(r.tokens_output) + '&#8595;</td><td class="when-cell">' + fmtTime(r.time_created) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (d.byModel.length) {
      html += '<div class="usage-section-title">Usage by Model</div>';
      html += '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Model</th><th class="num-cell">Requests</th><th class="num-cell">Input</th><th class="num-cell">Output</th><th class="cost-cell">Cost</th><th>Last Used</th></tr></thead><tbody>';
      for (const m of d.byModel) {
        html += '<tr><td class="model-cell">' + m.model + '</td><td class="num-cell">' + fmtNum(m.requests) + '</td><td class="num-cell">' + fmtNum(m.tokens_in) + '</td><td class="num-cell">' + fmtNum(m.tokens_out) + '</td><td class="cost-cell">$' + Number(m.cost).toFixed(4) + '</td><td class="when-cell">' + fmtTime(m.last_used) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    $("usageContent").innerHTML = html;
  } catch(e) {
    $("usageContent").innerHTML = '<div class="loading">Error loading usage data</div>';
  }
}

async function loadPlugins() {
  const r = await fetch("/api/plugins");
  const d = await r.json();
  let html = '<div class="section-title">Plugins</div>';
  html += '<div class="toolbar" style="margin-bottom:10px"><button class="btn btn-primary" id="btnAddPlugin">+ Add Plugin</button></div>';
  html += '<div class="plugin-list">';
  if (!d.plugins?.length) {
    html += '<div class="empty-models">No plugins installed.</div>';
  } else {
    for (const p of d.plugins) {
      html += '<div class="plugin-item"><span class="plugin-url">' + p + '</span><button class="btn btn-sm del-plugin-btn" data-url="' + p.replace(/"/g, '&quot;') + '">&#x2715;</button></div>';
    }
  }
  html += '</div>';

  html += '<div class="section-title" style="margin-top:24px">Agents</div>';
  html += '<div class="toolbar" style="margin-bottom:10px"><button class="btn btn-primary" id="btnAddAgent">+ Add Agent</button></div>';
  html += '<div class="agent-list">';
  const agents = d.agents || {};
  const keys = Object.keys(agents);
  if (!keys.length) {
    html += '<div class="empty-models">No agents configured.</div>';
  } else {
    for (const name of keys) {
      const a = agents[name];
      html += '<div class="agent-card" data-agent="' + name + '">';
      html += '<span class="agent-name">' + name + '</span>';
      html += '<span class="agent-meta">' + (a.mode || "subagent") + ' &middot; ' + (a.model || "-") + '</span>';
      html += '<button class="btn btn-sm edit-agent-btn" data-agent="' + name + '">&#x270E;</button>';
      html += '<button class="btn btn-sm del-agent-btn" data-agent="' + name + '">&#x2715;</button>';
      if (a.description) html += '<div class="agent-desc">' + a.description + '</div>';
      html += '</div>';
    }
  }
  html += '</div>';
  $("pluginsContent").innerHTML = html;
}

function showAddPluginModal() {
  openModal("Add Plugin",
    '<label>Plugin URL</label><input id="fPluginUrl" placeholder="e.g. my-plugin@git+https://github.com/user/repo.git" autofocus>',
    async () => {
      const url = $("fPluginUrl").value.trim();
      if (!url) return toast("Plugin URL is required", true);
      const r = await fetch("/api/plugins", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }) });
      const d = await r.json();
      if (d.ok) { toast("Plugin added"); closeModal(); loadPlugins(); } else toast(d.error || "Error", true);
    });
}

function showAddAgentModal(editName) {
  const isEdit = !!editName;
  fetch("/api/plugins").then(r => r.json()).then(d => {
    const modelOpts = [];
    const cfg = d.config?.provider || {};
    for (const [prov, data] of Object.entries(cfg)) {
      for (const key of Object.keys(data.models || {})) {
        modelOpts.push('<option value="' + prov + '/' + key + '">' + prov + '/' + key + '</option>');
      }
    }
    const curr = isEdit ? (d.agents?.[editName] || {}) : {};
    openModal(isEdit ? "Edit Agent" : "Add Agent",
      '<label>Name</label><input id="fAgentName" value="' + (isEdit ? editName : '') + '"' + (isEdit ? ' readonly' : '') + ' placeholder="e.g. my-agent" autofocus>' +
      '<label>Mode</label><select id="fAgentMode"><option value="subagent"' + (curr.mode === "subagent" ? " selected" : "") + '>subagent</option></select>' +
      '<label>Model</label><select id="fAgentModel"><option value="">Default</option>' + modelOpts.join("") + '</select>' +
      '<label>Description</label><textarea id="fAgentDesc" placeholder="Brief description">' + (curr.description || "") + '</textarea>',
      async () => {
        const name = $("fAgentName").value.trim();
        if (!name) return toast("Name is required", true);
        const mode = $("fAgentMode").value;
        const model = $("fAgentModel").value || undefined;
        const description = $("fAgentDesc").value.trim() || undefined;
        const r = await fetch("/api/agents", { method: isEdit ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, mode, model, description }) });
        const res = await r.json();
        if (res.ok) { toast(isEdit ? "Agent updated" : "Agent added"); closeModal(); loadPlugins(); } else toast(res.error || "Error", true);
      });
    if (curr.model) $("fAgentModel").value = curr.model;
  });
}

function showAddModelModal(provider) {
  fetch("/api/config").then(r => r.json()).then(cfg => {
    const opts = Object.keys(cfg.providers).map(p =>
      '<option value="' + p + '"' + (p === provider ? " selected" : "") + ">" + p + "</option>"
    ).join("");
    openModal("Add Model",
      '<label>Provider</label><select id="fProvider">' + opts + "</select>" +
      '<label>Model Key</label><input id="fKey" placeholder="e.g. merlin/gpt-5.5" autofocus>' +
      '<label>Display Name</label><input id="fName" placeholder="Optional display name">',
      async () => {
        const p = $("fProvider").value;
        const key = $("fKey").value.trim();
        if (!key) return toast("Model key is required", true);
        const r = await fetch("/api/models", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: p, key, name: $("fName").value.trim() || undefined }) });
        const d = await r.json();
        if (d.ok) { toast("Model added"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
      });
  });
}

function showEditModelModal(fullId) {
  const [provider, ...rest] = fullId.split("/");
  const key = rest.join("/");
  openModal("Edit Model",
    '<label>Provider</label><input value="' + provider + '" readonly>' +
    '<label>Model Key</label><input id="fKey" value="' + key + '">' +
    '<label>Display Name</label><input id="fName" placeholder="Display name">',
    async () => {
      const newKey = $("fKey").value.trim();
      if (!newKey) return toast("Model key is required", true);
      const r = await fetch("/api/models", { method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key, newKey, name: $("fName").value.trim() || undefined }) });
      const d = await r.json();
      if (d.ok) { toast("Model updated"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
    });
  fetch("/api/config").then(r => r.json()).then(cfg => {
    const m = cfg.providers?.[provider]?.models?.[key];
    if (m) $("fName").value = m.name || "";
  });
}

async function loadSessions() {
  const list = $("sessionsList");
  const detail = $("sessionDetail");
  if (!list) return;
  detail.style.display = "none";
  list.style.display = "block";
  list.innerHTML = '<div class="loading">Loading sessions...</div>';
  try {
    const r = await fetch("/api/sessions");
    if (!r.ok) { list.innerHTML = '<div class="loading">Error: ' + r.status + '</div>'; return; }
    const d = await r.json();
    if (!d.sessions?.length) {
      list.innerHTML = '<div class="session-empty">No sessions found.</div>';
      return;
    }
    let html = "";
    for (const s of d.sessions) {
      let model = s.model || "";
      try { const p = JSON.parse(model); model = p.id || model; } catch {}
      const title = (s.title || s.slug || "Untitled").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
      html += '<div class="session-card" data-sid="' + s.id + '">';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">';
      html += '<div class="session-card-title">' + title + '</div>';
      html += '<button class="btn btn-sm del-session-btn" data-sid="' + s.id + '" title="Delete">&#x2715;</button>';
      html += '</div><div class="session-card-meta">';
      html += '<span class="model-tag">' + model.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</span>';
      html += '<span>' + s.msg_count + ' msgs</span>';
      html += '<span>&#x25B3; ' + fmtNum(s.tokens_input) + '</span>';
      if (s.tokens_output) html += '<span>&#x25BD; ' + fmtNum(s.tokens_output) + '</span>';
      html += '<span>' + fmtTime(s.time_created) + '</span>';
      if (s.directory) html += '<span>' + escHtml(s.directory.split("/").pop()) + '</span>';
      html += '</div></div>';
    }
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<div class="loading">Error: ' + e.message + '</div>';
  }
}

async function showSessionDetail(id) {
  const list = $("sessionsList");
  const detail = $("sessionDetail");
  if (!detail) return;
  list.style.display = "none";
  detail.style.display = "block";
  detail.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const r = await fetch("/api/sessions/" + id);
    if (!r.ok) { detail.innerHTML = '<div class="loading">Error: ' + r.status + '</div>'; return; }
    const d = await r.json();
    if (!d.session) { detail.innerHTML = '<div class="session-empty">Session not found.</div>'; return; }
    const s = d.session;
    let model = s.model || "";
    try { const p = JSON.parse(model); model = p.id || model; } catch {}
    const safeTitle = escHtml(s.title || s.slug || "Untitled");
    let html = '<div class="detail-header">';
    html += '<button class="btn btn-sm" onclick="loadSessions()">&#x2190; Back</button>';
    html += '<h2>' + safeTitle + '</h2></div>';
    html += '<div class="session-card-meta" style="margin-bottom:14px;padding:0 0 12px;border-bottom:1px solid #d0d7de">';
    html += '<span class="model-tag">' + escHtml(model) + '</span>';
    html += '<span>' + s.msg_count + ' messages</span>';
    html += '<span>&#x25B3; ' + fmtNum(s.tokens_input) + '</span>';
    if (s.tokens_output) html += '<span>&#x25BD; ' + fmtNum(s.tokens_output) + '</span>';
    if (s.cost) html += '<span>$' + Number(s.cost).toFixed(4) + '</span>';
    html += '<span>' + new Date(s.time_created).toLocaleString() + '</span>';
    html += '</div>';

    if (!d.messages?.length) {
      html += '<div class="session-empty">No messages in this session.</div>';
    } else {
      for (const m of d.messages) {
        const parts = m.parts;
        if (parts) {
          // SDK format: has role, parts array with text
          const role = m.role || "unknown";
          const tokensIn = m.tokens?.input || m.tokens?.total || "";
          const tokensOut = m.tokens?.output || "";
          const time = new Date(m.time_created).toLocaleTimeString();
          html += '<div class="msg-row">';
          html += '<div class="msg-role ' + role + '">' + role + '</div>';
          html += '<div style="flex:1;min-width:0">';
          for (const p of parts) {
            if (p.type === "text" && p.text) {
              const txt = p.text.length > 500 ? p.text.slice(0, 500) + "..." : p.text;
              html += '<div style="font-size:12px;color:#24292f;word-break:break-word;margin-bottom:2px">' + renderMd(txt) + '</div>';
            } else if (p.type === "tool" || p.tool) {
              html += '<div style="font-size:11px;color:#9a6700;font-style:italic">&#x2699; tool: ' + escHtml(p.tool || p.type) + '</div>';
            }
          }
          if (tokensIn) html += '<div class="msg-info" style="margin-top:2px">in: ' + fmtNum(tokensIn) + ' | out: ' + fmtNum(tokensOut) + ' | ' + time + '</div>';
          else html += '<div class="msg-info" style="margin-top:2px">' + time + '</div>';
          html += '</div></div>';
        } else {
          // SQLite format: data is JSON string
          let data = {};
          try { data = JSON.parse(m.data); } catch { data = { role: "unknown" }; }
          const role = data.role || "unknown";
          const tokensIn = data.tokens?.input || data.tokens?.total || "";
          const tokensOut = data.tokens?.output || "";
          const time = new Date(m.time_created).toLocaleTimeString();
          const summaryTitle = data.summary?.title || "";
          html += '<div class="msg-row">';
          html += '<div class="msg-role ' + role + '">' + role + '</div>';
          html += '<div style="flex:1">';
          if (summaryTitle) html += '<div style="font-size:12px;color:#24292f">' + escHtml(summaryTitle) + '</div>';
          if (tokensIn) html += '<div class="msg-info">in: ' + fmtNum(tokensIn) + ' | out: ' + fmtNum(tokensOut) + ' | ' + time + '</div>';
          else html += '<div class="msg-info">' + time + '</div>';
          html += '</div></div>';
        }
      }
    }
    detail.innerHTML = html;
  } catch (e) {
    detail.innerHTML = '<div class="loading">Error: ' + e.message + '</div>';
  }
}

// --- Chat ---
let _chatSessionId = null;
let _chatLoading = false;

async function loadChat() {
  const sidebar = $("chatSessionList");
  const main = $("chatMain");
  if (!sidebar) return;
  try {
    const r = await fetch("/api/sessions");
    const d = await r.json();
    let html = '<div style="padding:8px 10px;font-size:11px;font-weight:600;color:#656d76;text-transform:uppercase">Sessions</div>';
    if (d.sessions?.length) {
      for (const s of d.sessions) {
        let model = s.model || "";
        try { const p = JSON.parse(model); model = p.id || model; } catch {}
        const title = escHtml(s.title || s.slug || "Untitled").slice(0, 40);
        const active = s.id === _chatSessionId ? ' active' : '';
        html += '<div class="chat-sidebar-item' + active + '" data-csid="' + s.id + '">';
        html += '<div class="chat-sidebar-title">' + title + '</div>';
        html += '<div class="chat-sidebar-meta" style="display:flex;align-items:center;gap:6px">';
        html += '<span>' + fmtTime(s.time_created) + '</span>';
        html += '<button class="btn btn-sm del-chat-btn" data-csid="' + s.id + '" title="Delete" style="color:#8c959f;padding:1px 4px">&#x2715;</button>';
        html += '</div></div>';
      }
    }
    html += '<div style="padding:8px 10px"><button class="btn btn-sm" id="chatNewBtn" style="width:100%">+ New Chat</button></div>';
    sidebar.innerHTML = html;
    if (!_chatSessionId) showChatWelcome();
  } catch {}
}

function showChatWelcome() {
  $("chatMessages").innerHTML = '<div class="chat-welcome">Select a session or start a new chat<div class="new-session-btn"><button class="btn btn-sm btn-primary" id="chatNewBtn2">+ New Chat</button></div></div>';
}

async function selectChatSession(id) {
  _chatSessionId = id;
  _chatLoading = false;
  document.querySelectorAll(".chat-sidebar-item").forEach(el => el.classList.toggle("active", el.dataset.csid === id));
  $("chatMessages").innerHTML = '<div class="chat-loading">Loading messages...</div>';
  try {
    const r = await fetch("/api/sessions/" + id);
    const d = await r.json();
    if (!d.messages?.length) {
      $("chatMessages").innerHTML = '<div class="chat-welcome">No messages yet. Start chatting!</div>';
      return;
    }
    let html = "";
    for (const m of d.messages) {
      let role = m.role;
      let text = "";
      let time = "";
      if (m.parts) {
        // SDK format
        role = m.role || "assistant";
        for (const p of m.parts) {
          if (p.type === "text" && p.text) text += p.text;
        }
        time = m.time_created ? new Date(m.time_created).toLocaleTimeString() : "";
      } else {
        // SQLite format
        let data = {};
        try { data = JSON.parse(m.data); } catch { data = { role: "unknown" }; }
        role = data.role || "unknown";
        time = new Date(m.time_created).toLocaleTimeString();
        text = data.summary?.title || "";
      }
      html += '<div class="chat-bubble ' + role + '">';
      html += '<div class="chat-bubble-inner">' + renderMd(text || "(no content)") + '</div>';
      if (time) html += '<div class="chat-bubble-time">' + time + '</div>';
      html += '</div>';
    }
    $("chatMessages").innerHTML = html;
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  } catch {
    $("chatMessages").innerHTML = '<div class="chat-welcome">Error loading session.</div>';
  }
}

async function sendChatMessage() {
  const input = $("chatInput");
  const msg = input.value.trim();
  if (!msg || _chatLoading) return;
  input.value = "";
  _chatLoading = true;
  $("chatSendBtn").disabled = true;
  $("chatSendBtn").textContent = "Sending...";

  // Add user bubble
  $("chatMessages").insertAdjacentHTML("beforeend",
    '<div class="chat-bubble user"><div class="chat-bubble-inner">' + escHtml(msg) + '</div><div class="chat-bubble-time">just now</div></div>');
  $("chatMessages").insertAdjacentHTML("beforeend",
    '<div class="chat-bubble assistant" id="chatPending"><div class="chat-bubble-inner" style="color:#8c959f">Thinking...</div></div>');
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;

  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: _chatSessionId, message: msg }),
    });
    const d = await r.json();
    const pending = $("chatPending");
    if (!d.ok) {
      if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:#cf222e">' + escHtml(d.error || "Error") + '</div></div>';
      if (d.error?.includes("server not available") || d.error?.includes("not available")) {
        showChatNoServer();
      }
      return;
    }
    if (pending) {
      pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner">' + renderMd(d.response || "(empty)") + '</div><div class="chat-bubble-time">just now</div></div>';
    }
    if (d.sessionId && d.sessionId !== _chatSessionId) {
      _chatSessionId = d.sessionId;
      loadChat();
    }
  } catch (e) {
    const pending = $("chatPending");
    if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:#cf222e">Error: connection failed</div></div>';
  }
  _chatLoading = false;
  $("chatSendBtn").disabled = false;
  $("chatSendBtn").textContent = "Send";
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function showChatNoServer() {
  $("chatMessages").innerHTML = '<div class="chat-welcome">OpenCode server is not running.<br><br>' +
    '<button class="btn btn-sm btn-primary" id="startServerBtn">Start opencode serve</button>' +
    '<br><br><small style="color:#8c959f">Or run <code style="background:#f3f4f6;padding:2px 4px;border-radius:3px">opencode serve</code> in a terminal.</small></div>';
}

async function startServerAndRetry() {
  $("chatMessages").innerHTML = '<div class="chat-loading">Starting OpenCode server...</div>';
  try {
    const r = await fetch("/api/chat/start-server", { method: "POST" });
    const d = await r.json();
    if (d.ok) { toast("Server started on port " + d.port); loadChat(); }
    else toast(d.error || "Failed", true);
  } catch { toast("Failed to start server", true); }
}

function showAddProviderModal() {
  openModal("Add Provider",
    '<label>Name</label><input id="fProvName" placeholder="e.g. my-provider" autofocus>' +
    '<label>SDK Package</label><select id="fNpm">' +
    '<option value="@ai-sdk/openai-compatible">@ai-sdk/openai-compatible</option>' +
    '<option value="@ai-sdk/anthropic">@ai-sdk/anthropic</option>' +
    '<option value="@ai-sdk/google">@ai-sdk/google</option>' +
    '<option value="@ai-sdk/openai">@ai-sdk/openai</option>' +
    "</select>" +
    '<label>Base URL</label><input id="fBaseURL" placeholder="https://api.example.com/v1">' +
    '<label>API Key</label><input id="fApiKey" placeholder="sk-... (leave empty for env)">',
    async () => {
      const name = $("fProvName").value.trim();
      if (!name) return toast("Provider name is required", true);
      const npm = $("fNpm").value;
      const baseURL = $("fBaseURL").value.trim() || undefined;
      const apiKey = $("fApiKey").value.trim() || undefined;
      const r = await fetch("/api/providers", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, npm, baseURL, apiKey }) });
      const d = await r.json();
      if (d.ok) { toast("Provider added"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
    });
}

$("providers").addEventListener("click", async (e) => {
  const card = e.target.closest(".model-card");
  if (card && !e.target.closest("button")) {
    const model = card.dataset.model;
    const r = await fetch("/api/set-model", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }) });
    const d = await r.json();
    if (d.ok) { toast("Switched to " + d.model); loadModels(); }
    return;
  }
  const header = e.target.closest(".provider-header");
  if (header && !e.target.closest("button")) {
    const body = header.nextElementSibling;
    const chevron = header.querySelector(".provider-chevron");
    if (body) { body.classList.toggle("open"); chevron?.classList.toggle("open"); }
    return;
  }
  const addBtn = e.target.closest(".add-model-btn");
  if (addBtn) { showAddModelModal(addBtn.dataset.prov); return; }
  const delProv = e.target.closest(".del-prov-btn");
  if (delProv) {
    const prov = delProv.dataset.prov;
    showConfirmModal('Delete "' + prov + '" and all its models?', "Delete", async () => {
      closeModal();
      const r = await fetch("/api/providers", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: prov }) });
      const d = await r.json();
      if (d.ok) { toast("Deleted " + prov); loadModels(); } else toast(d.error || "Error", true);
    });
    return;
  }
  const action = e.target.closest("[data-action]");
  if (!action) return;
  const model = action.dataset.model;
  if (action.dataset.action === "edit") { showEditModelModal(model); return; }
  if (action.dataset.action === "del") {
    const model = action.dataset.model;
    showConfirmModal('Delete "' + model + '"?', "Delete", async () => {
      closeModal();
      const [provider, ...rest] = model.split("/");
      const key = rest.join("/");
      const r = await fetch("/api/models", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key }) });
      const d = await r.json();
      if (d.ok) { toast("Deleted"); loadModels(); } else toast(d.error || "Error", true);
    });
    return;
  }
});

$("btnRefresh").addEventListener("click", () => {
  const active = document.querySelector(".sidebar-item.active");
  const tab = active?.dataset.tab;
  if (tab === "usage") loadUsage();
  else if (tab === "plugins") loadPlugins();
  else if (tab === "sessions") loadSessions();
  else if (tab === "chat") loadChat();
  else loadModels();
});
$("btnAddModel").addEventListener("click", () => showAddModelModal(""));
$("btnAddProvider").addEventListener("click", showAddProviderModal);

// --- Plugins & Agents events (delegated) ---
document.addEventListener("click", function(e) {
  if (e.target.id === "btnAddPlugin") { showAddPluginModal(); return; }
  if (e.target.id === "btnAddAgent") { showAddAgentModal(""); return; }
  const delPlugin = e.target.closest(".del-plugin-btn");
  if (delPlugin) {
    const url = delPlugin.dataset.url;
    showConfirmModal('Remove plugin "' + url + '"?', "Remove", () => {
      closeModal();
      fetch("/api/plugins", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }) })
        .then(r => r.json()).then(d => {
          if (d.ok) { toast("Plugin removed"); loadPlugins(); } else toast(d.error || "Error", true);
        });
    });
    return;
  }
  const editAgent = e.target.closest(".edit-agent-btn");
  if (editAgent) { showAddAgentModal(editAgent.dataset.agent); return; }
  const delAgent = e.target.closest(".del-agent-btn");
  if (delAgent) {
    const name = delAgent.dataset.agent;
    showConfirmModal('Delete agent "' + name + '"?', "Delete", () => {
      closeModal();
      fetch("/api/agents", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }) })
        .then(r => r.json()).then(d => {
          if (d.ok) { toast("Agent deleted"); loadPlugins(); } else toast(d.error || "Error", true);
        });
    });
    return;
  }
  const delSession = e.target.closest(".del-session-btn");
  if (delSession) {
    const sid = delSession.dataset.sid;
    showConfirmModal("Delete this session?", "Delete", async () => {
      closeModal();
      const r = await fetch("/api/sessions", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sid }) });
      const d = await r.json();
      if (d.ok) { toast("Session deleted"); loadSessions(); } else toast(d.error || "Error", true);
    });
    return;
  }
  const delChatSession = e.target.closest(".del-chat-btn");
  if (delChatSession) {
    const sid = delChatSession.dataset.csid;
    showConfirmModal("Delete this session?", "Delete", async () => {
      closeModal();
      const r = await fetch("/api/sessions", { method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sid }) });
      const d = await r.json();
      if (d.ok) {
        toast("Session deleted");
        if (_chatSessionId === sid) { _chatSessionId = null; showChatWelcome(); }
        loadChat();
      } else toast(d.error || "Error", true);
    });
    return;
  }
  const sessionCard = e.target.closest(".session-card");
  if (sessionCard && !e.target.closest("button")) { showSessionDetail(sessionCard.dataset.sid); return; }
  // Chat sidebar sessions
  const chatItem = e.target.closest(".chat-sidebar-item");
  if (chatItem && chatItem.dataset.csid && !e.target.closest("button")) { selectChatSession(chatItem.dataset.csid); return; }
  // Chat new buttons
  if (e.target.id === "startServerBtn") { startServerAndRetry(); return; }
  if (e.target.id === "chatNewBtn" || e.target.id === "chatNewBtn2") {
    _chatSessionId = null;
    $("chatMessages").innerHTML = '<div class="chat-welcome">Type a message to start a new chat!</div>';
    document.querySelectorAll(".chat-sidebar-item").forEach(el => el.classList.remove("active"));
    $("chatInput").focus();
    return;
  }
});
document.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey && document.activeElement === $("chatInput")) {
    e.preventDefault();
    sendChatMessage();
  }
});
$("chatSendBtn")?.addEventListener("click", sendChatMessage);
loadModels();
</script>
</body>
</html>`;

function extractResponseText(data: any): string {
  if (typeof data === "string") return data;
  if (data?.text) return data.text;
  if (data?.content) return data.content;
  if (data?.message?.content) return data.message.content;
  if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content;
  if (Array.isArray(data)) return data.map(extractResponseText).join("");
  return JSON.stringify(data);
}

function createServer(opts?: { port?: number }) {
  const p = opts?.port ?? PORT;
  const server = Bun.serve({
    port: p,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") return html(PAGE);

      if (url.pathname === "/api/config") {
        const cfg = await readConfig();
        return json({ current: cfg.current, providers: cfg.providers });
      }

      if (url.pathname === "/api/set-model" && req.method === "POST") {
        const { model } = await req.json();
        if (!model) return json({ ok: false, error: "model required" }, 400);
        try {
          await writeConfig((cfg: any) => { cfg.model = model; return cfg; });
          return json({ ok: true, model });
        } catch (e: any) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // --- CRUD: models ---
      if (url.pathname === "/api/models") {
        if (req.method === "POST") {
          const { provider, key, name } = await req.json();
          if (!provider || !key) return json({ ok: false, error: "provider & key required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              const prov = cfg.provider?.[provider] || cfg.providers?.[provider];
              if (!prov) throw new Error("provider not found");
              if (!prov.models) prov.models = {};
              prov.models[key] = { name: name || key };
              return cfg;
            }, provider);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        if (req.method === "PUT") {
          const { provider, key, newKey, name } = await req.json();
          if (!provider || !key || !newKey) return json({ ok: false, error: "provider, key, newKey required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              const prov = cfg.provider?.[provider] || cfg.providers?.[provider];
              if (!prov?.models?.[key]) throw new Error("model not found");
              const val = prov.models[key];
              val.name = name ?? val.name;
              if (newKey !== key) {
                delete prov.models[key];
                prov.models[newKey] = val;
              } else {
                prov.models[key] = val;
              }
              return cfg;
            }, provider);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        if (req.method === "DELETE") {
          const { provider, key } = await req.json();
          if (!provider || !key) return json({ ok: false, error: "provider & key required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              const prov = cfg.provider?.[provider] || cfg.providers?.[provider];
              if (!prov?.models?.[key]) throw new Error("model not found");
              delete prov.models[key];
              return cfg;
            }, provider);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      // --- CRUD: providers ---
      if (url.pathname === "/api/providers") {
        if (req.method === "POST") {
          const { name, npm, baseURL, apiKey } = await req.json();
          if (!name) return json({ ok: false, error: "name required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              const provTarget = cfg.provider || cfg.providers || {};
              if (provTarget[name]) throw new Error("provider already exists");
              provTarget[name] = { options: {} as any, models: {} };
              if (npm) provTarget[name].npm = npm;
              if (baseURL) provTarget[name].options.baseURL = baseURL;
              if (apiKey) provTarget[name].options.apiKey = apiKey;
              if (!cfg.provider && cfg.providers) cfg.providers = provTarget;
              else cfg.provider = provTarget;
              return cfg;
            });
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        if (req.method === "DELETE") {
          const { name } = await req.json();
          if (!name) return json({ ok: false, error: "name required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              delete cfg.provider?.[name];
              delete cfg.providers?.[name];
              return cfg;
            }, name);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      // --- Usage ---
      if (url.pathname === "/api/usage") {
        const db = getDB();
        if (!db) return json({ summary: { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0 }, recent: [], byModel: [] });

        const summary = db.query(`
          SELECT
            COUNT(*) AS requests,
            COALESCE(SUM(tokens_input),0) AS tokens_in,
            COALESCE(SUM(tokens_output),0) AS tokens_out,
            COALESCE(ROUND(SUM(cost),6),0) AS cost
          FROM session WHERE model IS NOT NULL AND model != ''
        `).get() as any;

        const recent = db.query(`
          SELECT COALESCE(json_extract(model, '$.id'), model) AS model, tokens_input, tokens_output, time_created
          FROM session WHERE model IS NOT NULL AND model != ''
          ORDER BY time_created DESC LIMIT 50
        `).all() as any[];

        const byModel = db.query(`
          SELECT
            COALESCE(json_extract(model, '$.id'), model) AS model,
            COUNT(*) AS requests,
            COALESCE(SUM(tokens_input),0) AS tokens_in,
            COALESCE(SUM(tokens_output),0) AS tokens_out,
            COALESCE(ROUND(SUM(cost),6),0) AS cost,
            MAX(time_created) AS last_used
          FROM session WHERE model IS NOT NULL AND model != ''
          GROUP BY model ORDER BY last_used DESC
        `).all() as any[];

        return json({ summary, recent, byModel });
      }

      // --- Sessions ---
      if (url.pathname === "/api/sessions") {
        if (req.method === "DELETE") {
          const { id } = await req.json();
          if (!id) return json({ ok: false, error: "session id required" }, 400);
          const db = getDB();
          if (!db) return json({ ok: false, error: "database not available" }, 500);
          db.run("DELETE FROM message WHERE session_id = ?", [id]);
          db.run("DELETE FROM session WHERE id = ?", [id]);
          return json({ ok: true });
        }
        const db = getDB();
        if (!db) return json({ sessions: [] });
        const sessions = db.query(`
          SELECT s.id, s.slug, s.title, s.directory, s.agent, s.model, s.time_created, s.time_updated, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.cost,
            (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
          FROM session s ORDER BY s.time_created DESC LIMIT 100
        `).all() as any[];
        return json({ sessions });
      }

      if (url.pathname.startsWith("/api/sessions/")) {
        const sessionId = url.pathname.replace("/api/sessions/", "");
        if (!sessionId) return json({ error: "session id required" }, 400);

        // Try SDK first (full content via parts)
        if (_sdkClient) {
          try {
            const [sessionRes, messagesRes] = await Promise.all([
              _sdkClient.session.get({ path: { id: sessionId } }),
              _sdkClient.session.messages({ path: { id: sessionId } }),
            ]);
            const sessionData = (sessionRes as any)?.data || sessionRes;
            const rawMsgs = (messagesRes as any)?.data || messagesRes || [];
            const msgs = (rawMsgs as any)?.all || (Array.isArray(rawMsgs) ? rawMsgs : []);
            const messages = msgs.map((m: any) => ({
              id: m.info?.id,
              session_id: m.info?.sessionID,
              role: m.info?.role,
              time_created: m.info?.time?.created,
              time_updated: m.info?.time?.completed,
              tokens: m.info?.tokens,
              model: m.info?.modelID,
              provider: m.info?.providerID,
              parts: (m.parts || []).map((p: any) => ({
                type: p.type,
                text: p.text,
                tool: p.toolCall?.name,
              })),
            }));
            return json({ session: sessionData, messages, source: "sdk" });
          } catch {}
        }

        // Fallback: SQLite (metadata only)
        const db = getDB();
        if (!db) return json({ session: null, messages: [], source: "db" });
        const session = db.query(`
          SELECT *, (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
          FROM session s WHERE id = ?
        `).get(sessionId) as any;
        if (!session) return json({ error: "not found" }, 404);
        const messages = db.query(`
          SELECT id, session_id, time_created, time_updated, data
          FROM message WHERE session_id = ?
          ORDER BY time_created ASC
        `).all(sessionId) as any[];
        return json({ session, messages, source: "db" });
      }

      if (url.pathname === "/api/debug-sdk") {
        const sdkPath = join(homedir(), ".opencode/node_modules/@opencode-ai/sdk/dist/client.js");
        return json({
          sdkLoaded: !!_sdkClient,
          pathExists: existsSync(sdkPath),
          path: sdkPath,
          serverUrl: process.env.OPENCODE_SERVER || "http://127.0.0.1:17497",
        });
      }
      // --- Chat ---
      if (url.pathname === "/api/chat/start-server" && req.method === "POST") {
        try {
          const opencodeBin = process.env.OPENCODE_BIN || `${homedir()}/.opencode/bin/opencode`;
          const proc = Bun.spawn([opencodeBin, "serve", "--print-logs"], {
            env: { ...process.env, NO_COLOR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          // Read port from output
          const reader = proc.stdout?.getReader();
          let port = 0;
          if (reader) {
            const { value } = await reader.read();
            const text = new TextDecoder().decode(value);
            const m = text.match(/:(\d+)/);
            if (m) port = parseInt(m[1]);
          }
          // Try SDK connection
          if (port) {
            try {
              const sdkPath = join(homedir(), ".opencode/node_modules/@opencode-ai/sdk/dist/client.js");
              if (existsSync(sdkPath)) {
                const { createOpencodeClient } = await import(sdkPath);
                _sdkClient = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
              }
            } catch {}
          }
          return json({ ok: true, port });
        } catch (e: any) {
          return json({ ok: false, error: e.message }, 500);
        }
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const { sessionId, message } = await req.json();
        if (!message) return json({ ok: false, error: "message required" }, 400);
        if (!_sdkClient) return json({ ok: false, error: "OpenCode server not available. Run 'opencode serve' in another terminal, or use this UI as an OpenCode plugin." }, 400);

        try {
          let sid = sessionId;
          if (!sid) {
            const created = await _sdkClient.session.create({ body: { title: message.slice(0, 80) } });
            sid = (created as any)?.data?.id;
          }
          const result = await _sdkClient.session.prompt({
            path: { id: sid },
            body: { parts: [{ type: "text", text: message }] },
          });
          const data = (result as any)?.data || result;
          const parts = data?.parts || [];
          const textParts = parts.filter((p: any) => p.type === "text").map((p: any) => p.text);
          const responseText = textParts.join("") || extractResponseText(data);
          return json({ ok: true, sessionId: sid, response: responseText || "(no response)" });
        } catch (e: any) {
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // --- Plugins & Agents ---
      if (url.pathname === "/api/plugins") {
        if (req.method === "GET") {
          const cfg = await readConfig();
          return json({ plugins: cfg.raw?.plugin || cfg.raw?.plugins || [], agents: cfg.raw?.agent || cfg.raw?.agents || {}, config: cfg.raw });
        }
        if (req.method === "POST") {
          const { url: pluginUrl } = await req.json();
          if (!pluginUrl) return json({ ok: false, error: "url required" }, 400);
          try {
          await writeConfig((cfg: any) => {
            if (!cfg.plugin) cfg.plugin = [];
            if (cfg.plugin.includes(pluginUrl)) throw new Error("plugin already exists");
            cfg.plugin.push(pluginUrl);
            return cfg;
          }, undefined, pluginUrl);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 409);
          }
        }
        if (req.method === "DELETE") {
          const { url: pluginUrl } = await req.json();
          if (!pluginUrl) return json({ ok: false, error: "url required" }, 400);
          try {
          await writeConfig((cfg: any) => {
            if (!cfg.plugin?.includes(pluginUrl)) throw new Error("plugin not found");
            cfg.plugin = cfg.plugin.filter((p: string) => p !== pluginUrl);
            return cfg;
          }, undefined, pluginUrl);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 404);
          }
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      if (url.pathname === "/api/agents") {
        if (req.method === "POST" || req.method === "PUT") {
          const { name, mode, model, description } = await req.json();
          if (!name) return json({ ok: false, error: "name required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              if (req.method === "POST" && cfg.agent?.[name]) throw new Error("agent already exists");
              if (!cfg.agent) cfg.agent = {};
              cfg.agent[name] = { mode: mode || "subagent", model: model || undefined, description: description || undefined };
              return cfg;
            }, undefined, name);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 409);
          }
        }
        if (req.method === "DELETE") {
          const { name } = await req.json();
          if (!name) return json({ ok: false, error: "name required" }, 400);
          try {
            await writeConfig((cfg: any) => {
              if (!cfg.agent?.[name]) throw new Error("agent not found");
              delete cfg.agent[name];
              return cfg;
            }, undefined, name);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 404);
          }
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      return json({ error: "not found" }, 404);
    },
  });

  console.log(`\n  OpenCode Manager @ http://localhost:${p}`);
  console.log(`  Configs: ${_paths.configPaths.length ? _paths.configPaths.join(", ") : "(not found)"}`);
  console.log(`  DB:      ${_paths.dbPath || "(not found)"}\n`);
  return server;
}

// OpenCode Plugin export
const pluginModule = {
  id: "opencode-manager",
  name: "OpenCode Manager",
  description: "Web UI for managing models, providers, plugins, and usage",
  server: async (input: any) => {
    if (input?.client) {
      // Use SDK client if available (running inside OpenCode)
      _sdkClient = input.client;
      try {
        const pathInfo = await _sdkClient.path.get();
        if (pathInfo?.config) {
          _paths.primaryConfig = pathInfo.config;
          if (!_paths.configPaths.includes(pathInfo.config)) _paths.configPaths.unshift(pathInfo.config);
        }
        if (pathInfo?.state) { _paths.dataDir = pathInfo.state; _paths.dbPath = join(pathInfo.state, "opencode.db"); }
      } catch {}
    }
    createServer();
    return {};
  },
};

// Standalone entry point
if (import.meta.main) {
  createServer();
}

export { createServer, pluginModule };
export default pluginModule;
