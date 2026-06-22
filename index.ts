#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { join } from "path";
import { execSync } from "child_process";

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
    join(home, ".opencode/opencode.json"),
    join(home, ".opencode/config.json"),
    join(home, ".config/opencode/manager.json"),
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
      // Merge plugins, agents, integrations etc.
      if (raw.plugin || raw.plugins) merged.plugins = [...new Set([...(merged.plugins || []), ...(raw.plugin || []), ...(raw.plugins || [])])];
      if (raw.agent || raw.agents) merged.agents = { ...(merged.agents || {}), ...(raw.agent || {}), ...(raw.agents || {}) };
      if (raw.integrations) merged.integrations = { ...(merged.integrations || {}), ...raw.integrations };
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

  if (!targetFile) {
    if (_paths.configPaths.length === 0) {
      targetFile = join(homedir(), ".opencode/opencode.json");
      if (!existsSync(join(homedir(), ".opencode"))) Bun.spawnSync(["mkdir", "-p", join(homedir(), ".opencode")]);
      writeFileSync(targetFile, JSON.stringify({ provider: {} }, null, 2));
      _paths.configPaths.push(targetFile);
      _paths.primaryConfig = targetFile;
    } else {
      throw new Error("No config file found");
    }
  }
  const raw = JSON.parse(readFileSync(targetFile, "utf-8"));
  let updated = updater(raw);
  
  // Clean up opencode.json by fixing plural keys
  if (updated.plugins) {
    if (!updated.plugin) updated.plugin = [];
    updated.plugin = [...new Set([...updated.plugin, ...updated.plugins])];
    delete updated.plugins;
  }
  if (updated.agents) {
    updated.agent = { ...(updated.agent || {}), ...updated.agents };
    delete updated.agents;
  }
  
  // Clean up opencode.json by moving opencode-manager specific keys to manager.json
  const managerKeys = ["integrations"];
  let hasManagerKeys = false;
  let managerData: any = {};
  const managerFile = join(homedir(), ".config/opencode/manager.json");
  
  if (existsSync(managerFile)) {
    try { managerData = JSON.parse(readFileSync(managerFile, "utf-8")); } catch {}
  }
  
  for (const k of managerKeys) {
    if (updated[k] !== undefined) {
      managerData[k] = updated[k];
      delete updated[k];
      hasManagerKeys = true;
    }
  }
  
  if (hasManagerKeys) {
    if (!existsSync(join(homedir(), ".config/opencode"))) Bun.spawnSync(["mkdir", "-p", join(homedir(), ".config/opencode")]);
    writeFileSync(managerFile, JSON.stringify(managerData, null, 2));
  }

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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; -webkit-font-smoothing: antialiased; }
  .layout { display: flex; height: 100vh; background: var(--bg); }
  .sidebar { width: 220px; background: #fff; border-right: 1px solid #d0d7de; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-brand { height: 56px; padding: 0 20px; font-size: 15px; font-weight: 600; color: #1f2328; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d0d7de; cursor: pointer; flex-shrink: 0; }
  .sidebar-brand svg { width: 18px; height: 18px; color: #656d76; }
  .sidebar-nav { padding: 8px; flex: 1; }
  .sidebar-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; color: #656d76; cursor: pointer; transition: all .1s; }
  .sidebar-item:hover { background: #f3f4f6; color: #1f2328; }
  .sidebar-item.active { background: #e8f0fe; color: #0969da; font-weight: 600; }
  .sidebar-item svg { width: 16px; height: 16px; flex-shrink: 0; }
  .sidebar-footer { padding: 12px 16px; border-top: 1px solid #d0d7de; font-size: 11px; color: #8c959f; }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar { height: 56px; display: flex; align-items: center; gap: 8px; padding: 0 20px; border-bottom: 1px solid #d0d7de; background: #fff; flex-shrink: 0; }
  .topbar h1 { font-size: 15px; font-weight: 600; color: #1f2328; }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  .active-model-badge { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #f0f6ff; border: 1px solid #cce5ff; border-radius: 6px; font-size: 11px; color: #0969da; max-width: 200px; }
  .active-model-badge span { font-weight: 600; text-transform: uppercase; font-size: 9px; color: #656d76; flex-shrink: 0; }
  .active-model-badge code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .content { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .tab-content { display: none; flex: 1; min-height: 0; flex-direction: column; }
  .tab-content.active { display: flex; }
  .tab-content:not(#tabChat) { padding: 16px 20px 24px; overflow-y: auto; }
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
  .model-card-actions { display: none; gap: 4px; flex-shrink: 0; }
  .model-card:hover .model-card-actions { display: flex; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: none; border: 1px solid transparent; border-radius: 4px; color: #656d76; cursor: pointer; transition: all .1s; flex-shrink: 0; }
  .icon-btn:hover { background: #e8eaed; color: #24292f; }
  .icon-btn.danger:hover { color: #cf222e; background: #ffebe9; border-color: rgba(207,34,46,.1); }
  .icon-btn.edit:hover { color: #9a6700; background: #fff8c5; border-color: rgba(154,103,0,.1); }
  .empty-models, .session-empty { padding: 32px 16px; text-align: center; color: #656d76; font-size: 13px; }
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
  .integration-section { margin-bottom: 24px; }
  .integration-section-title { font-size: 13px; font-weight: 500; color: #656d76; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.02em; }
  .integration-list { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  .integration-item { display: flex; align-items: center; gap: 16px; padding: 16px; border-bottom: 1px solid #d0d7de; }
  .integration-item:last-child { border-bottom: none; }
  .integration-icon { width: 32px; height: 32px; border-radius: 6px; background: #f6f8fa; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #24292f; }
  .integration-info { flex: 1; }
  .integration-name { font-size: 14px; font-weight: 600; color: #24292f; }
  .integration-desc { font-size: 12px; color: #656d76; margin-top: 2px; }
  .modal-body input, .modal-body select, .modal-body textarea { width: 100%; padding: 8px 12px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; color: #24292f; font-family: inherit; font-size: 13px; margin-bottom: 14px; outline: none; transition: border-color .1s; }
  .modal-body input:focus, .modal-body select:focus, .modal-body textarea:focus { border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.15); }
  .modal-body select { cursor: pointer; appearance: none; -webkit-appearance: none; padding-right: 32px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23656d76' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; background-size: 12px; }
  .modal-body select:hover { border-color: #8c959f; }
  .modal-body input[readonly] { opacity: .5; cursor: not-allowed; }
  .modal-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  /* Device flow modal */
  .df-box { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin-bottom: 16px; text-align: center; }
  .df-label { font-size: 11px; font-weight: 600; color: #656d76; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .df-value { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 18px; font-weight: 600; color: #24292f; letter-spacing: 0.1em; display: flex; align-items: center; justify-content: center; gap: 12px; }
  .df-url { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 13px; color: #24292f; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(9,105,218,0.2); border-radius: 50%; border-top-color: #0969da; animation: spin 1s linear infinite; margin-right: 8px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .usage-card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; }
  .usage-card-label { font-size: 11px; color: #656d76; text-transform: uppercase; letter-spacing: .05em; }
  .usage-card-value { font-size: 22px; font-weight: 600; color: #1f2328; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .usage-card-note { font-size: 11px; color: #656d76; margin-top: 2px; }
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
  .chat-header { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--border); background:var(--bg-card); flex-wrap:wrap; }
  .chat-header select { padding:4px 8px; border:1px solid var(--border); border-radius:6px; font-size:12px; background:var(--bg-card); color:var(--text); cursor:pointer; }
  .chat-header .badge { padding:2px 8px; border-radius:10px; font-size:11px; background:var(--bg-code); color:var(--text-secondary); cursor:pointer; }
  .chat-header .badge:hover { background:var(--border); }
  .chat-stop-btn { padding:4px 12px; border-radius:6px; border:1px solid var(--danger); background:transparent; color:var(--danger); font-size:12px; cursor:pointer; font-weight:600; }
  .chat-stop-btn:hover { background:#ffebe9; }
  .file-explorer { border-bottom:1px solid var(--border); background:var(--bg-card); }
  .file-explorer-header { padding:8px 12px; font-size:12px; font-weight:600; color:var(--text-secondary); cursor:pointer; display:flex; align-items:center; gap:4px; user-select:none; }
  .file-explorer-header:hover { background:var(--bg-code); }
  .file-explorer-tree { padding:4px 0; max-height:200px; overflow-y:auto; font-size:12px; }
  .file-item { padding:3px 12px 3px 20px; cursor:pointer; display:flex; align-items:center; gap:4px; color:var(--text); }
  .file-item:hover { background:var(--bg-code); color:var(--primary); }
  .file-item .fname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .file-item.dir { font-weight:500; }
  .context-drawer { position:fixed; right:0; top:0; bottom:0; width:320px; max-width:85vw; background:var(--bg-card); border-left:1px solid var(--border); z-index:250; display:none; flex-direction:column; box-shadow:-4px 0 12px rgba(0,0,0,0.1); }
  .context-drawer.open { display:flex; }
  .context-drawer-header { padding:12px 16px; border-bottom:1px solid var(--border); font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .context-drawer-body { flex:1; overflow-y:auto; padding:12px 16px; }
  .context-section { margin-bottom:16px; }
  .context-section-title { font-size:11px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px; }
  .context-file-row { display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:4px; font-size:12px; cursor:pointer; }
  .context-file-row:hover { background:var(--bg-code); }
  .context-file-row .remove-btn { margin-left:auto; color:var(--danger); cursor:pointer; opacity:0; }
  .context-file-row:hover .remove-btn { opacity:1; }
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
    .topbar { padding: 0 16px; }
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
  .chat-layout { display: flex; flex: 1; min-height: 0; background: #fff; }
  .chat-sidebar { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid #d0d7de; background: #f9f9f9; }
  .chat-sidebar-header { padding: 12px; border-bottom: 1px solid #d0d7de; }
  .chat-sidebar-list { flex: 1; overflow-y: auto; padding: 8px; }
  .chat-sidebar-item { padding: 10px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; color: #656d76; margin-bottom: 2px; border: 1px solid transparent; }
  .chat-sidebar-item:hover { background: #f0f2f5; }
  .chat-sidebar-item.active { background: #e8f0fe; color: #0969da; border-color: #cce5ff; font-weight: 600; }
  .chat-sidebar-item .chat-sidebar-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-sidebar-item .chat-sidebar-meta { font-size: 11px; color: #8c959f; margin-top: 2px; }
  .chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #fff; }
  .chat-msgs-wrapper { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center; }
  .chat-msgs { width: 100%; max-width: 800px; padding: 24px; flex: 1; display: flex; flex-direction: column; }
  .chat-bubble { margin-bottom: 16px; display: flex; flex-direction: column; }
  .chat-bubble.user { align-items: flex-end; }
  .chat-bubble.assistant { align-items: flex-start; }
  .chat-bubble-label { font-size: 11px; font-weight: 600; color: #656d76; margin-bottom: 4px; padding: 0 4px; text-transform: uppercase; letter-spacing: 0.02em; }
  .chat-bubble-inner { padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.5; word-break: break-word; max-width: 85%; }
  .chat-bubble-inner p { margin-bottom: 12px; }
  .chat-bubble-inner p:last-child, .chat-bubble-inner ul:last-child, .chat-bubble-inner ol:last-child { margin-bottom: 0; }
  .chat-bubble-inner ul, .chat-bubble-inner ol { padding-left: 24px; margin-bottom: 12px; }
  .chat-bubble-inner li { margin-bottom: 4px; }
  .chat-bubble-inner pre { margin-bottom: 12px; }
  .chat-bubble.user .chat-bubble-inner { background: #0969da; color: #fff; border-bottom-right-radius: 4px; }
  .chat-bubble.assistant .chat-bubble-inner { background: #f3f4f6; color: #24292f; border-bottom-left-radius: 4px; }
  .chat-bubble .chat-bubble-time { font-size: 10px; color: #8c959f; margin-top: 4px; padding: 0 4px; }
  .chat-input-wrapper { border-top: 1px solid transparent; background: linear-gradient(180deg, rgba(255,255,255,0) 0%, #fff 20%); padding: 10px 0 24px; display: flex; justify-content: center; }
  .chat-input-bar { display: flex; align-items: flex-end; gap: 8px; width: 100%; max-width: 800px; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 12px; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.05); transition: border-color 0.2s, box-shadow 0.2s; margin: 0 24px; }
  .chat-input-bar:focus-within { border-color: #0969da; box-shadow: 0 4px 12px rgba(9,105,218,0.1); }
  .chat-input-bar textarea { flex: 1; resize: none; padding: 6px; border: none; font-family: inherit; font-size: 14px; outline: none; background: transparent; max-height: 200px; }
  .chat-input-bar button { align-self: flex-end; padding: 8px 16px; border-radius: 8px; font-weight: 600; }
  .chat-welcome { text-align: center; padding: 48px 16px; color: #656d76; font-size: 14px; margin: auto; }
  .chat-loading { text-align: center; padding: 24px; color: #8c959f; font-size: 12px; margin: auto; }
  @media (max-width: 767px) {
    .chat-sidebar { display: none; }
    .chat-bubble { max-width: 95%; }
  }
  :root { --bg: #f5f6f8; --bg-card: #fff; --text: #24292f; --text-secondary: #656d76; --border: #d0d7de; --primary: #0969da; --success: #1a7f37; --danger: #cf222e; --bg-code: #f3f4f6; }
  body.dark { --bg: #0d1117; --bg-card: #161b22; --text: #e6edf3; --text-secondary: #8b949e; --border: #30363d; --primary: #58a6ff; --success: #3fb950; --danger: #f85149; --bg-code: #1c2128; }
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
      <div class="sidebar-item" data-tab="integrations" onclick="switchTab('integrations')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 8a3 3 0 0 0-2.83-2H6.83A3 3 0 1 0 4 8h2.17A3 3 0 0 0 9 10h2.17A3 3 0 0 0 12 8Z"/></svg>
        Integrations
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
        <div class="active-model-badge" id="activeModelBadge">
          <span style="display:flex;align-items:center;gap:4px"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm1.062 4.312a.75.75 0 00-1.062 0l-3.25 3.25a.75.75 0 000 1.062l3.25 3.25a.75.75 0 101.062-1.062L6.81 8l2.25-2.25a.75.75 0 000-1.062z"/></svg>Model</span>
          <code id="currentModel">&mdash;</code>
        </div>
        <button class="btn btn-sm" id="btnRefresh" style="font-size:13px">&#x21bb;</button>
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
        <div class="toolbar">
          <div style="flex:1"></div>
          <button class="btn btn-primary" id="btnAddPlugin">+ Add Plugin</button>
          <button class="btn" id="btnAddAgent">+ Add Agent</button>
        </div>
        <div id="pluginsContent"><div class="loading">Loading...</div></div>
      </div>
      <div class="tab-content" id="tabIntegrations">
        <div style="max-width:800px;margin:0 auto">
          <div style="margin-bottom:32px">
            <h2 style="font-size:20px;font-weight:600;color:#1f2328;margin-bottom:8px">Integrations</h2>
            <p style="color:#656d76;font-size:14px">Connect external tools to extend your workspace.</p>
          </div>
          <div id="integrationsContent"><div class="loading">Loading...</div></div>
        </div>
      </div>
      <div class="tab-content" id="tabSessions">
        <div id="sessionsList"></div>
        <div id="sessionDetail" style="display:none"></div>
      </div>
      <div class="tab-content" id="tabChat">
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
        <div class="chat-layout">
          <div class="chat-sidebar" id="chatSidebar">
            <div class="file-explorer">
              <div class="file-explorer-header" onclick="toggleFileExplorer()">
                <span id="feChevron">▼</span> Workspace
              </div>
              <div class="file-explorer-tree" id="fileTree"><div style="padding:8px 12px;font-size:11px;color:var(--text-secondary)">Loading...</div></div>
            </div>
            <div id="chatSessionList" style="flex:1;overflow:hidden;display:flex;flex-direction:column"></div>
          </div>
          <div class="chat-main" id="chatMain">
            <div class="chat-msgs-wrapper" id="chatMessagesWrapper">
              <div id="chatMessages" class="chat-msgs"></div>
            </div>
            <div id="chatPendingTools"></div>
            <div class="chat-input-wrapper" style="flex-direction: column; align-items: center;">
              <div style="width: 100%; max-width: 800px; padding: 0 24px; display: flex; flex-direction: column; align-items: flex-start;">
                <div id="chatRepoDropdown" style="margin-bottom:4px;position:relative;display:inline-block">
                  <button class="btn btn-sm" id="chatRepoSelectBtn" style="background:transparent;border:none;color:#656d76;padding:4px 8px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;border-radius:6px">
                    Select repository <span style="font-size:10px">&#x25BC;</span>
                  </button>
                  <div id="chatRepoMenu" style="display:none;position:absolute;bottom:100%;left:0;margin-bottom:4px;background:#fff;border:1px solid #d0d7de;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:260px;max-height:300px;overflow-y:auto;z-index:50">
                    <div style="padding:8px;border-bottom:1px solid #d0d7de">
                      <input type="text" id="chatRepoSearch" placeholder="Search repositories..." style="width:100%;padding:4px 8px;border:1px solid #d0d7de;border-radius:4px;font-size:12px;outline:none" autocomplete="off">
                    </div>
                    <div id="chatRepoList" style="padding:4px 0"></div>
                  </div>
                </div>
                <div class="chat-input-bar" style="margin: 0; width: 100%;">
                  <textarea id="chatInput" rows="2" placeholder="Type a message..." autocomplete="off"></textarea>
                  <button class="btn btn-primary" id="chatSendBtn">Send</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
  <!-- Device Flow Modal -->
  <div class="modal-overlay" id="deviceFlowModalOverlay">
    <div class="modal" style="text-align:center;width:480px">
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px">
        <span style="font-size:24px">&#x1F431;</span>
        <h2 style="font-size:18px;font-weight:600;margin:0">Connect GitHub</h2>
      </div>
      <p style="font-size:13px;color:#656d76;margin-bottom:24px">Visit the login URL below and authorize:</p>
      
      <div class="df-box">
        <div class="df-label">Login URL</div>
        <div class="df-url">
          <span id="dfUrlTxt">https://github.com/login/device</span>
          <button class="icon-btn" onclick="copyText('https://github.com/login/device')" title="Copy URL"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"></path></svg></button>
          <button class="btn btn-sm" onclick="window.open('https://github.com/login/device', '_blank')">Open &#x2197;</button>
        </div>
      </div>
      
      <div class="df-box" style="background:#fff4eb;border-color:#ffd8b3">
        <div class="df-label" style="color:#d95b00">Your Code</div>
        <div class="df-value" style="color:#d95b00">
          <span id="dfCodeTxt">ABCD-1234</span>
          <button class="icon-btn" style="color:#d95b00" onclick="copyText(document.getElementById('dfCodeTxt').textContent)" title="Copy Code"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"></path></svg></button>
        </div>
      </div>
      
      <div style="margin-top:24px;font-size:13px;color:#656d76">
        <span class="spinner"></span> Waiting for authorization...
      </div>
      <div style="margin-top:20px">
        <button class="btn" onclick="cancelDeviceFlow()">Cancel</button>
      </div>
    </div>
  </div>

<div class="context-drawer" id="contextDrawer">
  <div class="context-drawer-header">
    <span>📎 Context</span>
    <button class="icon-btn" onclick="closeContextDrawer()">✕</button>
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
const iconX = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>';
const iconPen = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/></svg>';
let _chatMode = "autonomous";
let _chatPendingTools = [];
let _chatAbortController = null;
let _chatContextFiles = [];
let _chatDarkMode = false;

function toast(msg, err) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " error" : "");
  setTimeout(() => t.classList.remove("show"), 2500);
}
const showToast = toast;

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
  else if (name === "integrations") loadIntegrations();
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
  function updateModelUI() {
  const m = _config?.current;
  $("currentModel").textContent = m ? (m.provider + "/" + m.id) : "None";
  $("activeModelBadge").style.display = m ? "flex" : "none";
}
  const r = await fetch("/api/config");
  const cfg = await r.json();
  $("currentModel").textContent = cfg.current || "(none)";

  let html = "";
  for (const [prov, data] of Object.entries(cfg.providers)) {
    const total = Object.keys(data.models).length;
    const npm = data.npm ? '<span class="provider-npm">' + escHtml(data.npm) + "</span>" : "";
    html += '<div class="provider" data-prov="' + escHtml(prov) + '">';
    html += '<div class="provider-header">';
      html += '<span class="provider-chevron open">&#x25B6;</span>';
      html += '<span class="provider-name">' + escHtml(prov) + "</span>";

      html += npm;
      html += '<span class="provider-badge">' + total + " model" + (total !== 1 ? "s" : "") + "</span>";
      html += '<div class="provider-actions">';
    html += '<button class="add-model-btn" data-prov="' + escHtml(prov) + '" title="Add model">+</button>';
    html += '<button class="icon-btn danger del-prov-btn" data-prov="' + escHtml(prov) + '" title="Delete provider">' + iconX + '</button>';
    html += "</div></div>";
    html += '<div class="provider-models open"><div class="model-grid">';
    if (total === 0) {
      html += '<div class="empty-models">No models. Click + to add one.</div>';
    } else {
      for (const [key, val] of Object.entries(data.models)) {
        const fullId = prov + "/" + key;
        const active = fullId === cfg.current;
        html += '<div class="model-card' + (active ? " active" : "") + '" data-model="' + escHtml(fullId) + '">';
        html += '<span class="model-card-indicator"></span>';
        html += '<span class="model-card-name" title="' + escHtml(val.name || key) + '">' + escHtml(val.name || key) + "</span>";
        html += '<span class="model-card-actions">';
        html += '<button class="icon-btn edit edit-action" data-action="edit" data-model="' + escHtml(fullId) + '" title="Edit">' + iconPen + '</button>';
        html += '<button class="icon-btn danger del-action" data-action="del" data-model="' + escHtml(fullId) + '" title="Delete">' + iconX + '</button>';
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
      html += '<div class="section-title">Recent Requests</div>';
      html += '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Model</th><th class="num-cell">In</th><th class="num-cell">Out</th><th>When</th></tr></thead><tbody>';
      for (const r of d.recent) {
        html += '<tr><td class="model-cell">' + escHtml(r.model) + '</td><td class="num-cell">' + fmtNum(r.tokens_input) + '&#8593;</td><td class="num-cell">' + fmtNum(r.tokens_output) + '&#8595;</td><td class="when-cell">' + fmtTime(r.time_created) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (d.byModel.length) {
      html += '<div class="section-title">Usage by Model</div>';
      html += '<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Model</th><th class="num-cell">Requests</th><th class="num-cell">Input</th><th class="num-cell">Output</th><th class="cost-cell">Cost</th><th>Last Used</th></tr></thead><tbody>';
      for (const m of d.byModel) {
        html += '<tr><td class="model-cell">' + escHtml(m.model) + '</td><td class="num-cell">' + fmtNum(m.requests) + '</td><td class="num-cell">' + fmtNum(m.tokens_in) + '</td><td class="num-cell">' + fmtNum(m.tokens_out) + '</td><td class="cost-cell">$' + Number(m.cost).toFixed(4) + '</td><td class="when-cell">' + fmtTime(m.last_used) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    $("usageContent").innerHTML = html;
  } catch(e) {
    $("usageContent").innerHTML = '<div class="loading">Error loading usage data</div>';
  }
}

let _integrations = {};
async function loadIntegrations() {
  const r = await fetch("/api/integrations");
  _integrations = await r.json();
  const ghUser = _integrations.github ? _integrations.github.username : null;
  const content = $("integrationsContent");
  if (!content) return;
  let html = '<div class="integration-section"><div class="integration-section-title">Source Control</div><div class="integration-list">';
  
  html += '<div class="integration-item"><div class="integration-icon">&#x1F431;</div><div class="integration-info"><div class="integration-name">GitHub</div><div class="integration-desc">';
  if (ghUser) html += 'Connected as ' + escHtml(ghUser) + ' to repositories';
  else html += 'Connect GitHub for Cloud Agents and codebase context';
  html += '</div></div><div class="integration-action">';
  if (ghUser) html += '<button class="btn" onclick="disconnectGithub()">Disconnect</button>';
  else html += '<button class="btn" onclick="connectGithub()">Connect &#x2197;</button>';
  html += '</div></div>';

  html += '<div class="integration-item"><div class="integration-icon" style="color:#e24329">&#x1F98A;</div><div class="integration-info"><div class="integration-name">GitLab</div><div class="integration-desc">Connect GitLab for enhanced codebase context</div></div><div class="integration-action"><button class="btn" disabled>Connect &#x2197;</button></div></div>';
  html += '<div class="integration-item"><div class="integration-icon" style="color:#0078d7">&#x2699;</div><div class="integration-info"><div class="integration-name">Azure DevOps</div><div class="integration-desc">Connect Azure DevOps for enhanced codebase context</div></div><div class="integration-action"><button class="btn" disabled>Connect &#x2197;</button></div></div>';
  
  html += '</div></div>';
  
  if (ghUser) {
    html += '<div class="integration-section" style="margin-top:24px"><div class="integration-section-title">Your Repositories</div>';
    html += '<div id="ghReposContainer"><div class="loading" style="font-size:12px">Loading repositories...</div></div></div>';
  }
  
  content.innerHTML = html;
  
  if (ghUser) {
    fetch("/api/integrations/github/repos").then(r => r.json()).then(data => {
      const container = $("ghReposContainer");
      if (!container) return;
      if (!data.ok) {
        container.innerHTML = '<div style="color:#d22424;font-size:13px">Error loading repositories: ' + escHtml(data.error) + '</div>';
        return;
      }
      
      let rhtml = '<div class="integration-list">';
      for (const repo of data.repos) {
        rhtml += '<div class="integration-item"><div class="integration-icon" style="color:#656d76">&#x1F4D2;</div><div class="integration-info"><div class="integration-name">' + escHtml(repo.full_name) + '</div><div class="integration-desc">' + (repo.private ? "Private" : "Public") + ' &middot; Updated ' + new Date(repo.updated_at).toLocaleDateString() + '</div></div><div class="integration-action"><button class="btn btn-sm" onclick="cloneRepo(\\'' + repo.full_name + '\\', \\'' + repo.clone_url + '\\')">Clone & Work</button></div></div>';
      }
      rhtml += '</div>';
      container.innerHTML = rhtml;
    }).catch(e => {
      const container = $("ghReposContainer");
      if (container) container.innerHTML = '<div style="color:#d22424;font-size:13px">Failed to load repositories.</div>';
    });
  }
}

async function cloneRepo(fullName, cloneUrl) {
  showToast("Cloning " + fullName + "...");
  $("deviceFlowModalOverlay").classList.add("open");
  $("deviceFlowModalOverlay").innerHTML = '<div class="modal" style="text-align:center"><div class="spinner" style="margin-bottom:16px"></div><h3>Cloning Workspace</h3><p style="color:#656d76;font-size:13px">Please wait while we clone ' + escHtml(fullName) + ' to your local machine...</p></div>';
  
  try {
    const r = await fetch("/api/integrations/github/clone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName: fullName, cloneUrl })
    });
    const data = await r.json();
    $("deviceFlowModalOverlay").classList.remove("open");
    
    if (data.ok) {
      showToast("Workspace ready! Opening Chat context...");
      // Switch to Chat tab
      document.querySelectorAll(".sidebar-item").forEach(el => el.classList.toggle("active", el.dataset.tab === "chat"));
      document.querySelectorAll(".content-section").forEach(el => el.classList.remove("active"));
      $("tabChat").classList.add("active");
      
      _chatSessionId = null; // Start a new session
      loadChat();
      
      // Auto-send context setup message to the AI
      setTimeout(() => {
        sendChatMessage("I have cloned the repository '" + fullName + "' to '" + data.path + "'. Please set this directory as your working directory context. I want you to act as a GitHub Automation Agent for this repo.");
      }, 500);
      
    } else {
      showToast("Error cloning: " + data.error, true);
    }
  } catch(e) {
    $("deviceFlowModalOverlay").classList.remove("open");
    showToast("Error cloning repository", true);
  }
}

let _dfPollInterval = null;

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    showToast("Copied to clipboard");
  } catch(e) {
    showToast("Failed to copy", true);
  }
}

async function connectGithub() {
  // Buka tab secara sinkron di sini untuk menghindari Popup Blocker browser
  window.open("https://github.com/login/device", "_blank");
  
  const r = await fetch("/api/integrations/github/device-code", { method: "POST" });
  const data = await r.json();
  if (!data.ok) { showToast("Error: " + data.error, true); return; }
  
  $("dfCodeTxt").textContent = data.user_code;
  $("deviceFlowModalOverlay").classList.add("open");
  
  // auto copy code
  try { await navigator.clipboard.writeText(data.user_code); showToast("Code copied to clipboard! Please paste it in the opened tab."); } catch(e) {}
  
  if (_dfPollInterval) { clearTimeout(_dfPollInterval); _dfPollInterval = null; }
  
  let currentInterval = (data.interval || 5) * 1000 + 100; // Add 100ms padding to avoid slow_down
  
  const poll = async () => {
    try {
      const p = await fetch("/api/integrations/github/poll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: data.device_code })
      });
      const res = await p.json();
      if (res.status === "success") {
        $("deviceFlowModalOverlay").classList.remove("open");
        showToast("GitHub connected successfully as " + res.username);
        loadIntegrations();
        return; // stop polling
      } else if (res.status === "error") {
        $("deviceFlowModalOverlay").classList.remove("open");
        showToast("Authorization failed: " + res.error, true);
        return; // stop polling
      } else if (res.status === "slow_down") {
        currentInterval += 5000; // Increase interval by 5s
      }
    } catch(e) { console.error(e); }
    
    _dfPollInterval = setTimeout(poll, currentInterval);
  };
  
  _dfPollInterval = setTimeout(poll, currentInterval);
}

function cancelDeviceFlow() {
  if (_dfPollInterval) { clearTimeout(_dfPollInterval); _dfPollInterval = null; }
  $("deviceFlowModalOverlay").classList.remove("open");
}

function disconnectGithub() {
  if (!confirm("Disconnect GitHub?")) return;
  fetch("/api/integrations/github", { method: "DELETE" })
    .then(r => r.json()).then(res => {
      if (res.ok) { showToast("GitHub disconnected"); loadIntegrations(); }
    });
}

async function loadPlugins() {
  const r = await fetch("/api/plugins");
  const d = await r.json();
  let html = '<div class="section-title" style="margin-bottom:12px">Plugins</div><div class="plugin-list">';
  if (!d.plugins?.length) {
    html += '<div class="empty-models">No plugins installed.</div>';
  } else {
    for (const p of d.plugins) {
      html += '<div class="plugin-item"><span class="plugin-url">' + escHtml(p) + '</span><button class="icon-btn danger del-plugin-btn" data-url="' + escHtml(p) + '">' + iconX + '</button></div>';
    }
  }
  html += '</div>';

  html += '<div class="section-title" style="margin-top:24px">Agents</div>';
  html += '<div class="agent-list">';
  const agents = d.agents || {};
  const keys = Object.keys(agents);
  if (!keys.length) {
    html += '<div class="empty-models">No agents configured.</div>';
  } else {
    for (const name of keys) {
      const a = agents[name];
      html += '<div class="agent-card" data-agent="' + escHtml(name) + '">';
      html += '<span class="agent-name">' + escHtml(name) + '</span>';
      html += '<span class="agent-meta">' + escHtml(a.mode || "subagent") + ' &middot; ' + escHtml(a.model || "-") + '</span>';
      html += '<button class="icon-btn edit edit-agent-btn" data-agent="' + escHtml(name) + '">' + iconPen + '</button>';
      html += '<button class="icon-btn danger del-agent-btn" data-agent="' + escHtml(name) + '">' + iconX + '</button>';
      if (a.description) html += '<div class="agent-desc">' + escHtml(a.description) + '</div>';
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
      try {
        const r = await fetch("/api/plugins", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }) });
        const d = await r.json();
        if (d.ok) { toast("Plugin added"); closeModal(); loadPlugins(); } else toast(d.error || "Error", true);
      } catch (e) { toast("Network error", true); }
    });
}

function showAddAgentModal(editName) {
  const isEdit = !!editName;
  fetch("/api/plugins").then(r => r.json()).then(d => {
    const modelOpts = [];
    const cfg = d.config?.provider || {};
    for (const [prov, data] of Object.entries(cfg)) {
      for (const key of Object.keys(data.models || {})) {
        const val = escHtml(prov + '/' + key);
        modelOpts.push('<option value="' + val + '">' + val + '</option>');
      }
    }
    const curr = isEdit ? (d.agents?.[editName] || {}) : {};
    openModal(isEdit ? "Edit Agent" : "Add Agent",
      '<label>Name</label><input id="fAgentName" value="' + escHtml(isEdit ? editName : '') + '"' + (isEdit ? ' readonly' : '') + ' placeholder="e.g. my-agent" autofocus>' +
      '<label>Mode</label><select id="fAgentMode"><option value="subagent"' + (curr.mode === "subagent" ? " selected" : "") + '>subagent</option></select>' +
      '<label>Model</label><select id="fAgentModel"><option value="">Default</option>' + modelOpts.join("") + '</select>' +
      '<label>Description</label><textarea id="fAgentDesc" placeholder="Brief description">' + escHtml(curr.description || "") + '</textarea>',
      async () => {
        const name = $("fAgentName").value.trim();
        if (!name) return toast("Name is required", true);
        const mode = $("fAgentMode").value;
        const model = $("fAgentModel").value || undefined;
        const description = $("fAgentDesc").value.trim() || undefined;
        try {
          const r = await fetch("/api/agents", { method: isEdit ? "PUT" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, mode, model, description }) });
          const res = await r.json();
          if (res.ok) { toast(isEdit ? "Agent updated" : "Agent added"); closeModal(); loadPlugins(); } else toast(res.error || "Error", true);
        } catch (e) { toast("Network error", true); }
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
        try {
          const r = await fetch("/api/models", { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: p, key, name: $("fName").value.trim() || undefined }) });
          const d = await r.json();
          if (d.ok) { toast("Model added"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
        } catch (e) { toast("Network error", true); }
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
      try {
        const r = await fetch("/api/models", { method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, key, newKey, name: $("fName").value.trim() || undefined }) });
        const d = await r.json();
        if (d.ok) { toast("Model updated"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
      } catch (e) { toast("Network error", true); }
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
      html += '<button class="icon-btn danger del-session-btn" data-sid="' + s.id + '" title="Delete">' + iconX + '</button>';
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
    let html = '<div class="chat-sidebar-header"><button class="btn btn-primary" id="chatNewBtn" style="width:100%;justify-content:center">+ New Chat</button></div><div class="chat-sidebar-list">';
    if (d.sessions?.length) {
      for (const s of d.sessions) {
        let model = s.model || "";
        try { const p = JSON.parse(model); model = p.id || model; } catch {}
        const title = escHtml(s.title || s.slug || "Untitled").slice(0, 40);
        const active = s.id === _chatSessionId ? ' active' : '';
        html += '<div class="chat-sidebar-item' + active + '" data-csid="' + s.id + '">';
        html += '<div class="chat-sidebar-title">' + title + '</div>';
        html += '<div class="chat-sidebar-meta" style="display:flex;align-items:center;gap:6px">';
        html += '<span style="flex:1">' + fmtTime(s.time_created) + '</span>';
        html += '<button class="icon-btn danger del-chat-btn" data-csid="' + s.id + '" title="Delete">' + iconX + '</button>';
        html += '</div></div>';
      }
    }
    html += '</div>';
    sidebar.innerHTML = html;
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
    loadFileTree(".");
    if (!_chatSessionId) showChatWelcome();
  } catch {}
}

function showChatWelcome() {
  $("chatMessages").innerHTML = '<div class="chat-welcome">Select a session from the sidebar or start a new chat<div class="new-session-btn"><button class="btn btn-primary" id="chatNewBtn2" style="font-size:14px;padding:10px 20px;border-radius:24px;margin-top:16px">+ New Chat</button></div></div>';
}

async function selectChatSession(id) {
  $("chatHeader").style.display = "flex";
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
      html += '<div class="chat-bubble-label">' + (role === "user" ? "You" : (role === "tool" ? "Tool" : "Assistant")) + '</div>';
      html += '<div class="chat-bubble-inner">' + renderMd(text || "(no content)") + '</div>';
      if (time) html += '<div class="chat-bubble-time">' + time + '</div>';
      html += '</div>';
    }
    $("chatMessages").innerHTML = html;
    $("chatMessagesWrapper").scrollTop = $("chatMessagesWrapper").scrollHeight;
  } catch {
    $("chatMessages").innerHTML = '<div class="chat-welcome">Error loading session.</div>';
  }
}

let _chatSelectedRepo = null;
let _chatRepos = [];

function toggleChatRepoMenu() {
  const menu = $("chatRepoMenu");
  if (menu.style.display === "none") {
    menu.style.display = "block";
    if (_chatRepos.length === 0) fetchChatRepos();
    $("chatRepoSearch").focus();
  } else {
    menu.style.display = "none";
  }
}

async function fetchChatRepos() {
  const list = $("chatRepoList");
  list.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#656d76">Loading repositories...</div>';
  try {
    const r = await fetch("/api/integrations/github/repos");
    const d = await r.json();
    if (d.ok && d.repos) {
      _chatRepos = d.repos;
      renderChatRepoList();
    } else {
      list.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#cf222e">Failed to load repos</div>';
    }
  } catch (e) {
    list.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#cf222e">Error loading repos</div>';
  }
}

function renderChatRepoList() {
  const q = $("chatRepoSearch").value.toLowerCase();
  const list = $("chatRepoList");
  const filtered = _chatRepos.filter(r => r.full_name.toLowerCase().includes(q));
  
  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#656d76">No repositories found</div>';
    return;
  }
  
  let html = '';
  // Add a "None" option
  html += '<div class="chat-repo-item" style="padding:6px 12px;font-size:12px;cursor:pointer;color:#24292f" onclick="selectChatRepo(null)"><em>Clear selection</em></div>';
  
  for (const r of filtered) {
    html += '<div class="chat-repo-item" style="padding:6px 12px;font-size:12px;cursor:pointer;color:#24292f;display:flex;align-items:center;gap:6px" onclick="selectChatRepo(\\'' + r.full_name + '\\')">';
    html += '<span>&#x1F4D2;</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(r.full_name) + '</span>';
    html += '</div>';
  }
  list.innerHTML = html;
}

function selectChatRepo(fullName) {
  _chatSelectedRepo = fullName;
  const btn = $("chatRepoSelectBtn");
  if (fullName) {
    btn.innerHTML = '&#x1F4D2; ' + escHtml(fullName) + ' <span style="font-size:10px;margin-left:4px">&#x25BC;</span>';
  } else {
    btn.innerHTML = 'Select repository <span style="font-size:10px;margin-left:4px">&#x25BC;</span>';
  }
  $("chatRepoMenu").style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
  $("chatRepoSelectBtn").addEventListener("click", toggleChatRepoMenu);
  $("chatRepoSearch").addEventListener("input", renderChatRepoList);
  document.addEventListener("click", (e) => {
    const dropdown = $("chatRepoDropdown");
    if (dropdown && !dropdown.contains(e.target)) {
      $("chatRepoMenu").style.display = "none";
    }
  });
  $("chatModeSelect")?.addEventListener("change", (e) => { _chatMode = e.target.value; });
  $("chatDarkToggle")?.addEventListener("click", () => {
    _chatDarkMode = !_chatDarkMode;
    document.body.classList.toggle("dark", _chatDarkMode);
    $("chatDarkToggle").textContent = _chatDarkMode ? "☀️" : "🌙";
  });
  $("chatContextBadge")?.addEventListener("click", openContextDrawer);
});

let _currentStreamText = "";
async function sendChatMessage(overrideText) {
  const input = $("chatInput");
  const msg = typeof overrideText === "string" ? overrideText : input.value.trim();
  if (!msg || _chatLoading) return;
  input.value = "";
  _chatLoading = true;
  $("chatSendBtn").disabled = true;
  $("chatSendBtn").textContent = "Sending...";

  // Add user bubble
  $("chatMessages").insertAdjacentHTML("beforeend",
    '<div class="chat-bubble user"><div class="chat-bubble-label">You</div><div class="chat-bubble-inner">' + escHtml(msg) + '</div><div class="chat-bubble-time">just now</div></div>');
  $("chatMessages").insertAdjacentHTML("beforeend",
    '<div class="chat-bubble assistant" id="chatPending"><div class="chat-bubble-label">Assistant</div><div class="chat-bubble-inner" id="chatStreamingText" style="color:#8c959f">Thinking...</div><div id="chatStreamingTools" style="width:100%;margin-top:8px;"></div></div>');
  $("chatMessagesWrapper").scrollTop = $("chatMessagesWrapper").scrollHeight;

  try {
    _chatAbortController = new AbortController();
    const signal = _chatAbortController.signal;
    $("chatStopBtn").style.display = "";
    const payload = { sessionId: _chatSessionId, message: msg };
    payload.mode = _chatMode;
    if (_chatSelectedRepo) {
      payload.context = "GitHub Repository Context: " + _chatSelectedRepo;
    }
    const r = await fetch("/api/chat", {
      signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    const pending = $("chatPending");

    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:#cf222e">' + escHtml(d.error || "Error") + '</div></div>';
      if (d.error?.includes("server not available") || d.error?.includes("not available")) {
        showChatNoServer();
      }
      _chatLoading = false;
      $("chatSendBtn").disabled = false;
      $("chatSendBtn").textContent = "Send";
      $("chatStopBtn").style.display = "none";
      return;
    }

    const sid = r.headers.get("X-Session-Id");
    if (sid && sid !== _chatSessionId) {
      _chatSessionId = sid;
      setTimeout(loadChat, 500);
    }

    _currentStreamText = "";
    if (pending) {
      $("chatStreamingText").style.color = "inherit";
      $("chatStreamingText").innerHTML = "";
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const event = JSON.parse(dataStr);
            handleChatEvent(event);
          } catch (e) {
            console.error("Parse error", e);
          }
        }
      }
    }
    // Estimate cost from response length
    try {
      const estTokensOut = Math.ceil(_currentStreamText.length / 4);
      const estTokensIn = Math.ceil(msg.length / 4);
      const cost = (estTokensIn * 0.000003 + estTokensOut * 0.000015);
      $("chatCostBadge").textContent = "\uD83D\uDCB0 $" + cost.toFixed(4);
    } catch(e) {}
    $("chatStopBtn").style.display = "none";
  } catch (e) {
    if (e.name === "AbortError") {
      const pending = $("chatPending");
      if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:var(--text-secondary)">⏹ Stopped</div></div>';
    } else {
      const pending = $("chatPending");
      if (pending) pending.outerHTML = '<div class="chat-bubble assistant"><div class="chat-bubble-inner" style="color:#cf222e">Error: connection failed</div></div>';
    }
  }
  
  const pending = $("chatPending");
  if (pending) {
    pending.removeAttribute("id");
    if (!$("chatStreamingText").innerHTML && !$("chatStreamingTools").innerHTML) {
      $("chatStreamingText").innerHTML = "(empty response)";
    }
    $("chatStreamingText").removeAttribute("id");
    $("chatStreamingTools").removeAttribute("id");
  }

  _chatLoading = false;
  $("chatSendBtn").disabled = false;
  $("chatSendBtn").textContent = "Send";
  $("chatMessagesWrapper").scrollTop = $("chatMessagesWrapper").scrollHeight;
}

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
    if (textEl) textEl.innerHTML = '<div style="font-style:italic;color:var(--text-secondary)">\uD83E\uDD14 ' + escHtml(thought || "Analyzing...") + '</div>';
    return;
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
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--primary);display:flex;align-items:center;gap:6px">\uD83D\uDCD6 Reading ' + escHtml(path) + '</div>');
  } else if (event.type === "tool_call:edit_file" || event.type === "edit_file" || event.tool === "edit_file" || event.tool === "replace_file_content" || event.tool === "multi_replace_file_content") {
    const args = event.args || event.arguments || {};
    const target = args.targetFile || args.TargetFile || args.target || "";
    addPendingTool(event, "edit_file", target);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:#f0f6ff;border:1px solid #cce5ff;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--primary);display:flex;align-items:center;gap:6px">\uD83D\uDCDD Editing ' + escHtml(target) + '</div>');
  } else if (event.type === "tool_call:search" || event.type === "search" || event.tool === "search" || event.tool === "grep") {
    const args = event.args || event.arguments || {};
    const query = args.query || args.pattern || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);display:flex;align-items:center;gap:6px">\uD83D\uDD0D Searching: <code style="font-size:11px">' + escHtml(query) + '</code></div>');
  } else if (event.type === "tool_call:glob" || event.tool === "glob") {
    const args = event.args || event.arguments || {};
    const pattern = args.pattern || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">\uD83D\uDCC1 Glob: <code style="font-size:11px">' + escHtml(pattern) + '</code></div>');
  } else if (event.type === "tool_call:web_search" || event.tool === "web_search") {
    const args = event.args || event.arguments || {};
    const q = args.query || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">\uD83C\uDF10 Searching web: ' + escHtml(q) + '</div>');
  } else if (event.type === "tool_call:web_fetch" || event.tool === "web_fetch") {
    const args = event.args || event.arguments || {};
    const url = args.url || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:10px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:6px">\uD83C\uDF0D Fetching: <code style="font-size:11px">' + escHtml(url) + '</code></div>');
  } else if (event.type === "tool_call:ask_user" || event.tool === "ask_user") {
    const args = event.args || event.arguments || {};
    const question = args.question || args.message || "";
    addPendingTool(event, "ask_user", question);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:12px;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;font-size:13px">' +
      '\u2753 ' + escHtml(question) +
      '<div style="margin-top:8px;display:flex;gap:6px"><input id="askInput" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" placeholder="Type your answer...">' +
      '<button class="btn btn-primary btn-sm" onclick="submitAskResponse()">Send</button></div></div>');
  } else if (event.tool === "git" || event.tool === "git_diff" || event.tool === "git_commit") {
    const args = event.args || event.arguments || {};
    const cmd = args.command || args.action || "";
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:8px 0;padding:8px 12px;background:var(--bg-code);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">\uD83D\uDD00 git: ' + escHtml(cmd) + '</div>');
  } else if (event.type === "tool_result") {
    const toolName = event.tool || event.name || "";
    const output = (event.result || event.output || event.text || "").slice(0, 500);
    toolsEl.insertAdjacentHTML("beforeend",
      '<div style="margin:0 0 10px;padding:8px 12px;font-size:11px;color:var(--success);background:#f0fff4;border:1px solid #b7e1c0;border-radius:6px;display:flex;align-items:flex-start;gap:6px">' +
      '<span style="flex-shrink:0">\u2705</span><span>' + (output || "Execution complete") + '</span></div>');
  }

  $("chatMessagesWrapper").scrollTop = $("chatMessagesWrapper").scrollHeight;
}

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
  html += '<div style="font-size:12px;font-weight:600;color:#9a6700;margin-bottom:8px">\u23F3 Pending Tools (' + _chatPendingTools.length + ')</div>';
  for (const t of _chatPendingTools) {
    if (t.approved !== null) continue;
    html += '<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg-card)">';
    html += '<div style="font-size:12px;color:var(--text);margin-bottom:6px">\uD83D\uDD27 ' + escHtml(t.type) + ': ' + escHtml(t.summary) + '</div>';
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
  fetch("/api/chat/approve-tool", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolId: "ask", approved: true, response: input.value.trim() })
  });
  input.disabled = true;
  input.value = "";
}

let _fileExplorerOpen = true;
function toggleFileExplorer() {
  _fileExplorerOpen = !_fileExplorerOpen;
  const tree = $("fileTree");
  if (tree) tree.style.display = _fileExplorerOpen ? "" : "none";
  const chevron = $("feChevron");
  if (chevron) chevron.textContent = _fileExplorerOpen ? "\u25BC" : "\u25B6";
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
      const clickHandler = e.type === "directory"
        ? "loadFileTree('" + escHtml(dir + "/" + e.name) + "')"
        : "previewFile('" + escHtml(dir + "/" + e.name) + "')";
      html += '<div class="' + cls + '" onclick="' + clickHandler + '">';
      html += '<span class="fname">' + escHtml(e.name) + '</span></div>';
    }
    container.innerHTML = html;
  } catch (e) { container.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--danger)">Error loading files</div>'; }
}

function previewFile(path) {
  let panel = $("filePreview");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "filePreview";
    panel.style.cssText = "position:fixed;right:0;top:0;bottom:0;width:400px;max-width:80vw;background:var(--bg-card);border-left:1px solid var(--border);z-index:300;display:flex;flex-direction:column;box-shadow:-4px 0 12px rgba(0,0,0,0.1)";
    document.body.appendChild(panel);
  }
  panel.innerHTML = '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0">' +
    '<span style="font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(path) + '</span>' +
    '<button class="icon-btn" onclick="closePreview()">' + iconX + '</button></div>' +
    '<div style="flex:1;overflow:auto;padding:16px"><div class="loading" style="padding:0">Loading...</div></div>';
  panel.style.display = "flex";

  fetch("/api/files/read?path=" + encodeURIComponent(path)).then(r => r.json()).then(d => {
    const contentDiv = panel.querySelector("div:last-child");
    if (d.ok) {
      contentDiv.innerHTML = '<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;color:var(--text);overflow-x:auto;white-space:pre-wrap;word-break:break-all">' + escHtml(d.content) + '</pre>';
    } else {
      contentDiv.innerHTML = '<div style="color:var(--danger);font-size:13px">' + escHtml(d.error) + '</div>';
    }
  }).catch(() => {
    const contentDiv = panel.querySelector("div:last-child");
    if (contentDiv) contentDiv.innerHTML = '<div style="color:var(--danger);font-size:13px">Failed to load file</div>';
  });
}

function closePreview() {
  const panel = $("filePreview");
  if (panel) panel.style.display = "none";
}

function openContextDrawer() {
  $("contextDrawer").classList.add("open");
  loadContextDrawer();
}
function closeContextDrawer() { $("contextDrawer").classList.remove("open"); }

function loadContextDrawer() {
  const list = $("ctxFileList");
  if (!list) return;
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
  fetch("/api/git/status").then(r => r.json()).then(d => {
    const gi = $("ctxGitInfo");
    if (!gi) return;
    if (d.ok) {
      const count = d.output.trim() ? d.output.trim().split("\n").filter(Boolean).length : 0;
      gi.innerHTML = '<div style="font-size:12px;color:var(--text)"><span style="font-family:monospace">main</span><br>' + (count > 0 ? '<span style="color:var(--danger)">● ' + count + ' uncommitted</span>' : '<span style="color:var(--success)">✔ Clean</span>') + '</div>';
    } else {
      gi.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">Not a git repo</div>';
    }
  }).catch(() => { const gi = $("ctxGitInfo"); if (gi) gi.innerHTML = '<div style="font-size:12px;color:var(--text-secondary)">Not a git repo</div>'; });
}

function addContextFile() {
  const path = prompt("Enter file path:");
  if (path && path.trim()) {
    _chatContextFiles.push(path.trim());
    loadContextDrawer();
  }
}

function removeContextFile(path) {
  _chatContextFiles = _chatContextFiles.filter(function(f) { return f !== path; });
  loadContextDrawer();
}

function copyContext() {
  const text = _chatContextFiles.join("\n");
  navigator.clipboard.writeText(text).then(function() { showToast("Context copied!"); }).catch(function() { showToast("Failed to copy", true); });
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
      try {
        const r = await fetch("/api/providers", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, npm, baseURL, apiKey }) });
        const d = await r.json();
        if (d.ok) { toast("Provider added"); closeModal(); loadModels(); } else toast(d.error || "Error", true);
      } catch (e) { toast("Network error", true); }
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
$("chatStopBtn")?.addEventListener("click", () => {
  if (_chatAbortController) { _chatAbortController.abort(); }
  fetch("/api/chat/stop", { method: "POST" }).catch(() => {});
  $("chatStopBtn").style.display = "none";
});
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

      // --- Integrations ---
      if (url.pathname === "/api/integrations") {
        const cfg = await readConfig();
        const integrations = cfg.raw?.integrations || {};
        return json(integrations);
      }
      if (url.pathname === "/api/integrations/github/device-code" && req.method === "POST") {
        try {
          const cid = "178c6fc778ccc68e1d6a"; // GitHub CLI Client ID
          const r = await fetch("https://github.com/login/device/code", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: cid, scope: "repo,user" })
          });
          const data = await r.json();
          if (data.error) return json({ ok: false, error: data.error_description || data.error }, 400);
          return json({ ok: true, device_code: data.device_code, user_code: data.user_code, verification_uri: data.verification_uri, interval: data.interval });
        } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
      }
      
      if (url.pathname === "/api/integrations/github/poll" && req.method === "POST") {
        try {
          const { device_code } = await req.json();
          const cid = "178c6fc778ccc68e1d6a";
          const r = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: cid, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
          });
          const data = await r.json();
          console.log("[GitHub Device Poll] Response:", data);
          try { require("fs").writeFileSync("/Users/aaa/Documents/Developer/opencode-manager/debug-poll.log", "[Poll] " + JSON.stringify(data) + "\n", {flag: "a"}); } catch(e){}
          
          if (data.error) {
            if (data.error === "authorization_pending") return json({ status: "pending" });
            if (data.error === "slow_down") return json({ status: "slow_down" });
            return json({ status: "error", error: data.error_description || data.error });
          }
          
          if (data.access_token) {
            const token = data.access_token;
            console.log("[GitHub Device Poll] Fetching user info with Bearer token...");
            const u = await fetch("https://api.github.com/user", { headers: { "Authorization": `Bearer ${token}`, "User-Agent": "OpenCode-Manager" } });
            const user = await u.json();
            console.log("[GitHub Device Poll] User response:", user);
            try { require("fs").writeFileSync("/Users/aaa/Documents/Developer/opencode-manager/debug-poll.log", "[User] " + JSON.stringify(user) + "\n", {flag: "a"}); } catch(e){}
            
            await writeConfig((cfg: any) => {
              if (!cfg.integrations) cfg.integrations = {};
              cfg.integrations.github = { token, username: user.login };
              return cfg;
            });
            
            return json({ status: "success", username: user.login });
          }
          return json({ status: "error", error: "Unknown response" });
        } catch(e: any) { return json({ status: "error", error: e.message }); }
      }
      
      if (url.pathname === "/api/integrations/github/repos" && req.method === "GET") {
        try {
          const cfg = await readConfig();
          const token = cfg.raw?.integrations?.github?.token;
          if (!token) return json({ ok: false, error: "Not connected to GitHub" }, 401);
          
          const r = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
            headers: { "Authorization": `Bearer ${token}`, "User-Agent": "OpenCode-Manager", "Accept": "application/vnd.github.v3+json" }
          });
          const data = await r.json();
          if (data.message) return json({ ok: false, error: data.message }, 400);
          
          return json({ ok: true, repos: data });
        } catch(e: any) { return json({ ok: false, error: e.message }, 500); }
      }
      
      if (url.pathname === "/api/integrations/github/clone" && req.method === "POST") {
        try {
          const { repoFullName, cloneUrl } = await req.json();
          if (!repoFullName || !cloneUrl) return json({ ok: false, error: "Missing parameters" }, 400);
          
          const cfg = await readConfig();
          const token = cfg.raw?.integrations?.github?.token;
          if (!token) return json({ ok: false, error: "Not connected to GitHub" }, 401);
          
          const workspacesDir = join(homedir(), "Documents", "OpenCodeWorkspaces");
          if (!existsSync(workspacesDir)) {
            execSync(`mkdir -p "${workspacesDir}"`);
          }
          
          const targetDir = join(workspacesDir, repoFullName.split("/").pop() || "repo");
          if (existsSync(targetDir)) {
            return json({ ok: true, path: targetDir, message: "Workspace already exists" });
          }
          
          const authUrl = cloneUrl.replace("https://", `https://oauth2:${token}@`);
          const util = await import("util");
          const cp = await import("child_process");
          const execAsync = util.promisify(cp.exec);
          await execAsync(`git clone "${authUrl}" "${targetDir}"`);
          
          return json({ ok: true, path: targetDir });
        } catch(e: any) { return json({ ok: false, error: e.message }, 500); }
      }

      if (url.pathname === "/api/integrations/github") {
        if (req.method === "DELETE") {
          await writeConfig((cfg: any) => {
            if (cfg.integrations && cfg.integrations.github) delete cfg.integrations.github;
            return cfg;
          });
          return json({ ok: true });
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
        try {
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
        } catch (e: any) {
          return json({ summary: { requests: 0, tokens_in: 0, tokens_out: 0, cost: 0 }, recent: [], byModel: [] });
        }
      }

      // --- Sessions ---
      if (url.pathname === "/api/sessions") {
        if (req.method === "DELETE") {
          const { id } = await req.json();
          if (!id) return json({ ok: false, error: "session id required" }, 400);
          try {
            const db = getDB();
            if (!db) return json({ ok: false, error: "database not available" }, 500);
            db.run("DELETE FROM message WHERE session_id = ?", [id]);
            db.run("DELETE FROM session WHERE id = ?", [id]);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 500);
          }
        }
        try {
          const db = getDB();
          if (!db) return json({ sessions: [] });
          const sessions = db.query(`
            SELECT s.id, s.slug, s.title, s.directory, s.agent, s.model, s.time_created, s.time_updated, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.cost,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
            FROM session s ORDER BY s.time_created DESC LIMIT 100
          `).all() as any[];
          return json({ sessions });
        } catch (e: any) {
          return json({ sessions: [] });
        }
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
        try {
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
        } catch (e: any) {
          return json({ session: null, messages: [], source: "db", error: e.message });
        }
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
        const { sessionId, message, context } = await req.json();
        if (!message) return json({ ok: false, error: "message required" }, 400);
        if (!_sdkClient) return json({ ok: false, error: "OpenCode server not available. Run 'opencode serve' in another terminal, or use this UI as an OpenCode plugin." }, 400);

        try {
          let sid = sessionId;
          if (!sid) {
            const created = await _sdkClient.session.create({ body: { title: message.slice(0, 80) } });
            sid = (created as any)?.data?.id || (created as any)?.id;
          }
          
          const cfg = await readConfig();
          const activeModel = cfg.current;
          
          const parts = [];
          let targetDir: string | undefined = undefined;
          
          if (context) {
            parts.push({ type: "text", text: context + "\n\n" });
            const match = context.match(/GitHub Repository Context: (.*)/);
            if (match) {
              const repoFullName = match[1].trim();
              const workspacesDir = join(homedir(), "Documents", "OpenCodeWorkspaces");
              targetDir = join(workspacesDir, repoFullName.split("/").pop() || "repo");
            }
          }
          parts.push({ type: "text", text: message });
          
          let modelObj = undefined;
          if (activeModel) {
            const splitIdx = activeModel.indexOf("/");
            if (splitIdx !== -1) {
              modelObj = { providerID: activeModel.slice(0, splitIdx), modelID: activeModel.slice(splitIdx + 1) };
            }
          }

          let baseUrl = process.env.OPENCODE_SERVER || "http://127.0.0.1:17497";
          if (_sdkClient && _sdkClient.client && typeof _sdkClient.client.getConfig === "function") {
            const sdkConfig = _sdkClient.client.getConfig();
            if (sdkConfig && sdkConfig.baseUrl) {
              baseUrl = sdkConfig.baseUrl;
            }
          }
          console.log("[DEBUG] /api/chat baseUrl:", baseUrl);
          const query = targetDir ? `?directory=${encodeURIComponent(targetDir)}&stream=true` : `?stream=true`;
          
          const upstream = await fetch(`${baseUrl}/session/${sid}/prompt${query}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "text/event-stream"
            },
            body: JSON.stringify({
              parts,
              model: modelObj,
              stream: true
            })
          });

          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
              "X-Session-Id": sid
            }
          });
        } catch (e: any) {
          const errMsg = e.message || "";
          if (errMsg.includes("connect") || errMsg.includes("fetch failed") || errMsg.includes("refused")) {
            return json({ ok: false, error: "OpenCode server not available. Run 'opencode serve' in another terminal." }, 500);
          }
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // --- Plugins & Agents ---
      if (url.pathname === "/api/plugins") {
        if (req.method === "GET") {
          const cfg = await readConfig();
          return json({ plugins: cfg.raw?.plugins || cfg.raw?.plugin || [], agents: cfg.raw?.agents || cfg.raw?.agent || {}, config: cfg.raw });
        }
        if (req.method === "POST") {
          const { url: pluginUrl } = await req.json();
          if (!pluginUrl) return json({ ok: false, error: "url required" }, 400);
          try {
          await writeConfig((cfg: any) => {
            if (!cfg.plugin) cfg.plugin = cfg.plugins || [];
            if (cfg.plugin.includes(pluginUrl)) throw new Error("plugin already exists");
            cfg.plugin.push(pluginUrl);
            delete cfg.plugins;
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
            const plugins = cfg.plugin || cfg.plugins || [];
            if (!plugins.includes(pluginUrl)) throw new Error("plugin not found");
            cfg.plugin = plugins.filter((p: string) => p !== pluginUrl);
            delete cfg.plugins;
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
              if (req.method === "POST" && (cfg.agents?.[name] || cfg.agent?.[name])) throw new Error("agent already exists");
              if (!cfg.agents) cfg.agents = cfg.agent || {};
              cfg.agents[name] = { mode: mode || "subagent", model: model || undefined, description: description || undefined };
              delete cfg.agent;
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
              if (!cfg.agents?.[name] && !cfg.agent?.[name]) throw new Error("agent not found");
              if (cfg.agents) delete cfg.agents[name];
              if (cfg.agent) delete cfg.agent[name];
              return cfg;
            }, undefined, name);
            return json({ ok: true });
          } catch (e: any) {
            return json({ ok: false, error: e.message }, 404);
          }
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }

      // --- Chat agent endpoints ---

      if (url.pathname === "/api/chat/stop" && req.method === "POST") {
        return json({ ok: true });
      }

      if (url.pathname === "/api/chat/approve-tool" && req.method === "POST") {
        const { toolId, approved, modifiedArgs } = await req.json();
        return json({ ok: true, toolId, approved });
      }

      // --- File endpoints ---

      if (url.pathname === "/api/files/tree" && req.method === "GET") {
        const dir = url.searchParams.get("dir") || homedir();
        try {
          const { readdirSync, statSync } = await import("fs");
          const { join } = await import("path");
          const entries = readdirSync(dir);
          const tree = entries.filter((e: string) => !e.startsWith(".")).map((e: string) => {
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

      // --- Git endpoints ---

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
