// AI Usage Monitor —— 扫描本地 AI 编程工具的会话记录，聚合模型/成本/命令数据
// 数据源插件化：每个源实现 list()+parse() 或 load()，详见 SOURCES 注册表
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 38765;
const HOME = os.homedir();
const PRICING_PATH = path.join(__dirname, 'pricing.json');
const MAX_EVENTS_PER_SESSION = 800;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// ---------- 定价（支持面板内热更新） ----------
let PRICING = loadPricing();
function loadPricing() {
  try { return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8')); }
  catch (e) { console.error('pricing.json 读取失败:', e.message); return { default: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } }; }
}
function priceFor(model) {
  const m = (model || '').toLowerCase();
  let best = null, bestLen = -1;
  for (const key of Object.keys(PRICING)) {
    if (key.startsWith('_') || key === 'default') continue;
    if (m.includes(key.toLowerCase()) && key.length > bestLen) { best = PRICING[key]; bestLen = key.length; }
  }
  return best || PRICING.default;
}
function costOf(model, u) {
  const p = priceFor(model);
  return (u.in * p.input + u.cw * p.cacheWrite + u.cr * p.cacheRead + u.out * p.output) / 1e6;
}
function cleanModel(model) {
  if (!model) return 'unknown';
  const idx = model.indexOf('::');
  return idx >= 0 ? model.slice(idx + 2) : model;
}

// ---------- 通用工具 ----------
const fileCache = new Map(); // path -> {mtime, size, data}

function walkFiles(root, maxDepth, filter) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p, depth + 1);
      else if (filter(it.name, p)) out.push(p);
    }
  }
  walk(root, 0);
  return out;
}

// 分块逐行读取，支持超大文件（避免 512MB 字符串上限）
const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
function eachLine(fp, cb) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    let skipping = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const chunk = buf.toString('utf8', 0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', start);
        if (nl === -1) break;
        if (!skipping) cb(carry + chunk.slice(start, nl));
        else skipping = false;
        carry = '';
        start = nl + 1;
      }
      carry += chunk.slice(start);
      if (carry.length > MAX_LINE) { carry = ''; skipping = true; } // 超长行直接丢弃
    }
    if (carry && !skipping) cb(carry);
  } finally { fs.closeSync(fd); }
}

function fixMs(t) { return t && t < 1e12 ? t * 1000 : t; } // 秒级时间戳转毫秒

// ---------- 数据源: Claude Code ----------
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');

function extractClaudeUserEvent(content) {
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const texts = content.filter(b => b && b.type === 'text' && b.text).map(b => b.text);
    if (!texts.length) return null; // 纯 tool_result
    text = texts.join('\n');
  }
  if (!text) return null;
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    return { kind: 'command', text: (cmd[1].trim() + ' ' + (args ? args[1].trim() : '')).trim() };
  }
  if (text.includes('<local-command-stdout>')) return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
             .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();
  if (!text || text.startsWith('[Request interrupted')) return null;
  return { kind: 'prompt', text: text.slice(0, 300) };
}

function parseClaudeFile(fp) {
  const data = {
    app: 'claude', id: path.basename(fp, '.jsonl'),
    agent: path.basename(fp).startsWith('agent-'),
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [],
  };
  eachLine(fp, (line) => {
    if (!line || line[0] !== '{') return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) {
      if (!data.firstTs || ts < data.firstTs) data.firstTs = ts;
      if (!data.lastTs || ts > data.lastTs) data.lastTs = ts;
    }
    if (!data.cwd && e.cwd) data.cwd = e.cwd;
    const msg = e.message;
    if (e.type === 'assistant' && msg && msg.usage && msg.model && msg.model !== '<synthetic>') {
      const u = msg.usage;
      data.usageEntries.push({
        mid: msg.id || null, rid: e.requestId || null, model: msg.model, ts,
        u: {
          in: u.input_tokens || 0,
          cw: u.cache_creation_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
          out: u.output_tokens || 0,
        },
      });
    } else if (e.type === 'user' && msg && msg.content && !e.isSidechain && !e.isMeta) {
      if (data.events.length < MAX_EVENTS_PER_SESSION) {
        const ev = extractClaudeUserEvent(msg.content);
        if (ev) data.events.push({ ts, kind: ev.kind, text: ev.text });
      }
    }
  });
  return data;
}

// ---------- 数据源: Codex ----------
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');

function parseCodexFile(fp) {
  const data = {
    app: 'codex', id: path.basename(fp, '.jsonl'), agent: false,
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [],
  };
  let model = null, lastUsage = null;
  eachLine(fp, (line) => {
    if (!line || line[0] !== '{') return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) {
      if (!data.firstTs || ts < data.firstTs) data.firstTs = ts;
      if (!data.lastTs || ts > data.lastTs) data.lastTs = ts;
    }
    const p = e.payload;
    if (!p) return;
    if (e.type === 'session_meta') {
      data.cwd = p.cwd || null;
      data.source = p.originator || p.source || null;
      if (p.model) model = p.model;
    } else if (e.type === 'turn_context' && p.model) {
      model = p.model;
    } else if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
      lastUsage = { u: p.info.total_token_usage, ts };
    } else if (p.type === 'user_message' && typeof p.message === 'string') {
      const t = p.message.trim();
      if (t && !t.startsWith('<') && !t.startsWith('#') && data.events.length < MAX_EVENTS_PER_SESSION) {
        data.events.push({ ts, kind: 'prompt', text: t.slice(0, 300) });
      }
    } else if (e.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      const t = p.content.filter(c => c && (c.type === 'input_text' || c.type === 'text') && c.text)
                         .map(c => c.text).join('\n').trim();
      if (t && !t.startsWith('<') && !t.startsWith('#') && data.events.length < MAX_EVENTS_PER_SESSION) {
        data.events.push({ ts, kind: 'prompt', text: t.slice(0, 300) });
      }
    }
  });
  if (lastUsage) {
    const u = lastUsage.u;
    const cached = u.cached_input_tokens || 0;
    data.usageEntries.push({
      mid: data.id, rid: null, model: cleanModel(model || 'gpt-5'), ts: lastUsage.ts,
      u: {
        in: Math.max(0, (u.input_tokens || 0) - cached),
        cw: u.cache_write_input_tokens || 0,
        cr: cached,
        out: u.output_tokens || 0,
      },
    });
  }
  return data;
}

// ---------- 数据源: Gemini CLI ----------
const GEMINI_DIR = path.join(HOME, '.gemini', 'tmp');

function parseGeminiFile(fp) {
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const data = {
    app: 'gemini', id: j.sessionId || path.basename(fp, '.json'), agent: false,
    cwd: null, source: null,
    firstTs: j.startTime ? Date.parse(j.startTime) : null,
    lastTs: j.lastUpdated ? Date.parse(j.lastUpdated) : null,
    usageEntries: [], events: [],
  };
  for (const m of j.messages || []) {
    const ts = m.timestamp ? Date.parse(m.timestamp) : null;
    if (m.type === 'user' && typeof m.content === 'string') {
      const t = m.content.trim();
      if (t && !t.startsWith('<') && data.events.length < MAX_EVENTS_PER_SESSION) {
        data.events.push({ ts, kind: 'prompt', text: t.slice(0, 300) });
      }
    } else if (m.type !== 'user' && m.tokens) {
      const t = m.tokens;
      const input = t.input ?? t.promptTokens ?? t.prompt ?? 0;
      const cached = t.cached ?? t.cachedContentTokens ?? 0;
      data.usageEntries.push({
        mid: m.id || null, rid: null, model: m.model || 'gemini', ts,
        u: {
          in: Math.max(0, input - cached), cw: 0, cr: cached,
          out: (t.output ?? t.candidates ?? 0) + (t.thoughts ?? 0) + (t.tool ?? 0),
        },
      });
    }
  }
  return data;
}

// ---------- 数据源: OpenCode (SQLite) ----------
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
let ocCache = { mtime: 0, sessions: [] };

function loadOpencodeSessions() {
  let st;
  try { st = fs.statSync(OPENCODE_DB); } catch { return []; }
  if (st.mtimeMs === ocCache.mtime) return ocCache.sessions;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return []; } // Node < 22.5 无内置 sqlite
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    const rows = db.prepare(`SELECT id, directory, title, model, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session`).all();
    db.close();
    ocCache = {
      mtime: st.mtimeMs,
      sessions: rows.map(r => {
        let model = 'unknown';
        if (r.model) {
          try { const m = JSON.parse(r.model); model = m.modelID || m.id || m.model || String(r.model); }
          catch { model = String(r.model); }
        }
        const created = fixMs(r.time_created), updated = fixMs(r.time_updated) || created;
        return {
          app: 'opencode', id: 'oc-' + r.id, agent: false, cwd: r.directory || null, source: null,
          firstTs: created, lastTs: updated,
          usageEntries: [{
            mid: 'oc-' + r.id, rid: null, model, ts: updated,
            u: {
              in: r.tokens_input || 0, cw: r.tokens_cache_write || 0,
              cr: r.tokens_cache_read || 0,
              out: (r.tokens_output || 0) + (r.tokens_reasoning || 0),
            },
          }],
          events: r.title ? [{ ts: created, kind: 'prompt', text: String(r.title).slice(0, 300) }] : [],
        };
      }),
    };
  } catch (e) { console.error('opencode db:', e.message); }
  return ocCache.sessions;
}

// ---------- 数据源: Continue (VSCode 扩展) ----------
const CONTINUE_DIR = path.join(HOME, '.continue', 'dev_data');

function parseContinueFile(fp) {
  const data = {
    app: 'continue', id: 'continue-' + path.basename(path.dirname(fp)), agent: false,
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [],
  };
  eachLine(fp, (line) => {
    if (!line || line[0] !== '{') return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) {
      if (!data.firstTs || ts < data.firstTs) data.firstTs = ts;
      if (!data.lastTs || ts > data.lastTs) data.lastTs = ts;
    }
    data.usageEntries.push({
      mid: null, rid: null, model: e.model || 'unknown', ts,
      u: { in: e.promptTokens || 0, cw: 0, cr: 0, out: e.generatedTokens || 0 },
    });
  });
  return data;
}

// ---------- 数据源注册表 ----------
// 新增工具只需加一项：kind 'files' 提供 root/list/parse；kind 'custom' 提供 load()
const SOURCES = [
  {
    id: 'claude', name: 'Claude Code', kind: 'files', root: CLAUDE_DIR,
    list: () => walkFiles(CLAUDE_DIR, 3, n => n.endsWith('.jsonl')),
    parse: parseClaudeFile,
  },
  {
    id: 'codex', name: 'Codex', kind: 'files', root: CODEX_DIR,
    list: () => walkFiles(CODEX_DIR, 4, n => n.endsWith('.jsonl')),
    parse: parseCodexFile,
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'files', root: GEMINI_DIR,
    list: () => walkFiles(GEMINI_DIR, 3, (n, p) => n.endsWith('.json') && p.includes('chats')),
    parse: parseGeminiFile,
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'custom', root: path.dirname(OPENCODE_DB),
    load: loadOpencodeSessions,
  },
  {
    id: 'continue', name: 'Continue', kind: 'files', root: CONTINUE_DIR,
    list: () => walkFiles(CONTINUE_DIR, 2, n => n === 'tokensGenerated.jsonl'),
    parse: parseContinueFile,
  },
];

function getParsed(fp, parseFn, cutoffMs) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  if (st.mtimeMs < cutoffMs) return null; // 太旧，跳过
  const hit = fileCache.get(fp);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try { data = parseFn(fp); } catch (err) {
    console.error('parse fail', fp, err.message);
    return null;
  }
  fileCache.set(fp, { mtime: st.mtimeMs, size: st.size, data });
  return data;
}

// ---------- 聚合 ----------
let aggCache = { at: 0, days: 0, body: null };

function localDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function zero() { return { in: 0, cw: 0, cr: 0, out: 0, cost: 0 }; }
function addU(t, u, cost) { t.in += u.in; t.cw += u.cw; t.cr += u.cr; t.out += u.out; t.cost += cost; }

function collectSessionData(cutoffMs) {
  const out = [];
  for (const s of SOURCES) {
    if (!fs.existsSync(s.root)) continue;
    if (s.kind === 'files') {
      for (const fp of s.list()) {
        const d = getParsed(fp, s.parse, cutoffMs);
        if (d) out.push(d);
      }
    } else {
      for (const d of s.load()) out.push(d);
    }
  }
  return out;
}

function aggregate(days) {
  const now = Date.now();
  if (aggCache.body && aggCache.days === days && now - aggCache.at < 15000) return aggCache.body;
  const cutoffMs = now - (days + 1) * 86400000;

  const sessions = [];
  const daily = new Map();   // date -> app -> model -> totals
  const models = new Map();  // model -> {byApp}
  const seen = new Set();    // 全局去重 messageId:requestId
  const totals = { all: zero(), today: zero() };
  const todayStr = localDate(now);
  const hourly = new Map();  // date -> Array(24) 成本
  const projects = new Map();// 项目目录 -> 汇总
  const commands = new Map();// 斜杠命令 -> 次数
  const appsSeen = new Set();
  let nightCost = 0, promptTotal = 0, cmdTotal = 0, savedByCache = 0;

  for (const d of collectSessionData(cutoffMs)) {
    if (!d.lastTs || d.lastTs < now - days * 86400000) continue;
    const app = d.app;
    const sess = {
      app, id: d.id, agent: d.agent, cwd: d.cwd, source: d.source || null,
      start: d.firstTs, end: d.lastTs,
      models: [], u: zero(), msgCount: d.usageEntries.length,
      cmdCount: d.events.filter(ev => ev.kind === 'command').length,
      promptCount: d.events.filter(ev => ev.kind === 'prompt').length,
      title: (d.events.find(ev => ev.kind === 'prompt') || d.events[0] || {}).text || '(无输入记录)',
      active: now - d.lastTs < ACTIVE_WINDOW_MS,
    };
    const sessModels = new Set();
    for (const en of d.usageEntries) {
      if (en.mid) {
        const key = en.mid + ':' + (en.rid || '');
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const model = cleanModel(en.model);
      const cost = costOf(model, en.u);
      sessModels.add(model);
      addU(sess.u, en.u, cost);
      const dateStr = localDate(en.ts || d.lastTs);
      if (!daily.has(dateStr)) daily.set(dateStr, {});
      const dApp = daily.get(dateStr);
      if (!dApp[app]) dApp[app] = {};
      if (!dApp[app][model]) dApp[app][model] = zero();
      addU(dApp[app][model], en.u, cost);
      if (!models.has(model)) models.set(model, {});
      const mm = models.get(model);
      if (!mm[app]) mm[app] = zero();
      addU(mm[app], en.u, cost);
      addU(totals.all, en.u, cost);
      if (dateStr === todayStr) addU(totals.today, en.u, cost);
      if (!hourly.has(dateStr)) hourly.set(dateStr, new Array(24).fill(0));
      const hr = new Date(en.ts || d.lastTs).getHours();
      hourly.get(dateStr)[hr] += cost;
      if (hr < 6) nightCost += cost;
      const pm = priceFor(model);
      savedByCache += en.u.cr * Math.max(0, pm.input - pm.cacheRead) / 1e6;
    }
    sess.models = [...sessModels];
    if (sess.msgCount || sess.cmdCount || sess.promptCount) {
      appsSeen.add(app);
      sessions.push(sess);
      const proj = d.cwd ? String(d.cwd).split(/[\\/]/).filter(Boolean).pop() : '(未知目录)';
      if (!projects.has(proj)) projects.set(proj, { cost: 0, tokens: 0, sessions: 0 });
      const pr = projects.get(proj);
      pr.cost += sess.u.cost;
      pr.tokens += sess.u.in + sess.u.cw + sess.u.cr + sess.u.out;
      pr.sessions++;
      promptTotal += sess.promptCount;
      cmdTotal += sess.cmdCount;
      for (const ev of d.events) if (ev.kind === 'command') {
        const name = ev.text.split(/\s+/)[0];
        if (name) commands.set(name, (commands.get(name) || 0) + 1);
      }
    }
  }
  sessions.sort((a, b) => b.end - a.end);

  // 连续活跃天数（从今天往回数）
  let streak = 0;
  for (let i = 0; i <= days; i++) {
    const ds = localDate(now - i * 86400000);
    const dm = daily.get(ds);
    const has = dm && Object.values(dm).some(app => Object.values(app).some(u => u.cost > 0 || u.out > 0));
    if (has) streak++;
    else if (i > 0) break; // 今天还没用不算断
  }
  let maxDay = null;
  for (const [date, byApp] of daily) {
    let c = 0;
    for (const ms of Object.values(byApp)) for (const u of Object.values(ms)) c += u.cost;
    if (!maxDay || c > maxDay.cost) maxDay = { date, cost: c };
  }
  const maxSession = sessions.reduce((a, s) => (!a || s.u.cost > a.u.cost) ? s : a, null);

  const body = {
    generatedAt: now, days, todayStr,
    apps: SOURCES.filter(s => appsSeen.has(s.id)).map(s => ({ id: s.id, name: s.name })),
    daily: [...daily.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([date, byApp]) => ({ date, byApp })),
    models: [...models.entries()].map(([model, byApp]) => {
      let cost = 0, tokens = 0;
      for (const u of Object.values(byApp)) { cost += u.cost; tokens += u.in + u.cw + u.cr + u.out; }
      return { model, byApp, cost, tokens };
    }).sort((a, b) => b.cost - a.cost),
    sessions: sessions.slice(0, 400),
    totals,
    activeCount: sessions.filter(s => s.active).length,
    hourly: Object.fromEntries(hourly),
    projects: [...projects.entries()].map(([name, p]) => ({ name, ...p }))
      .sort((a, b) => b.cost - a.cost).slice(0, 12),
    commands: [...commands.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    stats: {
      streak,
      maxDay,
      maxSession: maxSession ? {
        title: maxSession.title, cost: maxSession.u.cost,
        cwd: maxSession.cwd, app: maxSession.app, end: maxSession.end,
      } : null,
      nightShare: totals.all.cost > 0 ? nightCost / totals.all.cost : 0,
      promptTotal, cmdTotal,
      savedByCache,
    },
  };
  aggCache = { at: now, days, body };
  return body;
}

function sessionDetail(app, id) {
  for (const [, entry] of fileCache) {
    if (entry.data && entry.data.app === app && entry.data.id === id) {
      return { id, app, cwd: entry.data.cwd, events: entry.data.events };
    }
  }
  for (const d of ocCache.sessions) {
    if (d.app === app && d.id === id) return { id, app, cwd: d.cwd, events: d.events };
  }
  return null;
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function validatePricing(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '定价必须是对象';
  if (!obj.default) return '必须包含 default 条目';
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    for (const f of ['input', 'output', 'cacheWrite', 'cacheRead']) {
      if (typeof v[f] !== 'number' || v[f] < 0 || !isFinite(v[f])) return `"${k}" 的 ${f} 必须是非负数字`;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (u.pathname === '/api/data') {
      const days = Math.min(90, Math.max(1, parseInt(u.searchParams.get('days') || '7', 10)));
      json(200, aggregate(days));
    } else if (u.pathname === '/api/session') {
      const detail = sessionDetail(u.searchParams.get('app'), u.searchParams.get('id'));
      json(detail ? 200 : 404, detail || { error: 'not found' });
    } else if (u.pathname === '/api/pricing' && req.method === 'GET') {
      json(200, PRICING);
    } else if (u.pathname === '/api/pricing' && req.method === 'POST') {
      let obj;
      try { obj = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'JSON 格式错误' }); }
      const err = validatePricing(obj);
      if (err) return json(400, { error: err });
      fs.writeFileSync(PRICING_PATH, JSON.stringify(obj, null, 2));
      PRICING = obj;
      aggCache = { at: 0, days: 0, body: null }; // 重算成本
      json(200, { ok: true });
    } else if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (err) {
    console.error(err);
    json(500, { error: err.message });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('已有实例在运行，退出'); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => console.log(`AI usage monitor: http://127.0.0.1:${PORT}`));
process.on('uncaughtException', (err) => console.error('uncaught:', err));
process.on('unhandledRejection', (err) => console.error('unhandled:', err));
