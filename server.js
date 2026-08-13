// AIcost Radar —— 扫描本地 AI 编程工具的会话记录，聚合模型/成本/命令数据
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
  // 统一小写：同一模型有时大小写不一致（GLM-5.2 / glm-5.2），否则会拆成两行
  return (idx >= 0 ? model.slice(idx + 2) : model).toLowerCase();
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
  // 子代理转录位于 <project>/<父会话id>/subagents/agent-*.jsonl，父会话 id 就是上上级目录名
  const inSub = path.basename(path.dirname(fp)) === 'subagents';
  const data = {
    app: 'claude', id: path.basename(fp, '.jsonl'),
    agent: path.basename(fp).startsWith('agent-'),
    parent: inSub ? path.basename(path.dirname(path.dirname(fp))) : null,
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [], errors: [], errCount: 0,
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
      // 工具报错(sniffly 式错误分析);子代理内部的报错记在 agent 文件里，主会话不重复计
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b || b.type !== 'tool_result' || !b.is_error) continue;
          data.errCount++;
          if (data.errors.length < 200) {
            let t = typeof b.content === 'string' ? b.content
              : Array.isArray(b.content) ? b.content.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '';
            t = String(t || '').replace(/\s+/g, ' ').trim();
            if (t) data.errors.push({ ts, text: t.slice(0, 240) });
          }
        }
      }
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

// ---------- 数据源: DeepSeek Harness (dsh) ----------
// 日志是多个 zstd frame 拼接的 session.jsonl.zstd,需按 frame magic 逐段解压
const DSH_DIR = path.join(HOME, '.dsh', 'sessions');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let zstdDecompressSync = null;
try { ({ zstdDecompressSync } = require('node:zlib')); } catch {} // Node < 22.15 无内置 zstd

function readDshText(fp) {
  const raw = fs.readFileSync(fp);
  if (!fp.endsWith('.zstd')) return raw.toString('utf8');
  if (!zstdDecompressSync) return '';
  const parts = [];
  let i = 0;
  while ((i = raw.indexOf(ZSTD_MAGIC, i)) !== -1) {
    // 尾部截断或 payload 内的假 magic 会解压失败,跳过即可
    try { parts.push(zstdDecompressSync(raw.subarray(i)).toString('utf8')); } catch {}
    i += 1;
  }
  return parts.join('');
}

function parseDshFile(fp) {
  const data = {
    app: 'dsh', id: path.basename(path.dirname(fp)), agent: false,
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [],
  };
  let title = null;
  for (const line of readDshText(fp).split('\n')) {
    if (!line || line[0] !== '{') continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.time || null;
    if (ts) {
      if (!data.firstTs || ts < data.firstTs) data.firstTs = ts;
      if (!data.lastTs || ts > data.lastTs) data.lastTs = ts;
    }
    const d = e.data;
    if (e.type === 'session') {
      data.id = e.id || data.id;
      data.cwd = e.cwd || null;
      if (e.createdAt) data.firstTs = e.createdAt;
    } else if (e.type === 'session/title' && d && d.title) {
      title = String(d.title);
    } else if (e.type === 'assistant/message' && d && d.usage) {
      const u = d.usage;
      const src = (d.message && d.message.source) || {};
      // outputTokens 已含 reasoningTokens（DeepSeek 计费口径），不重复累加
      data.usageEntries.push({
        mid: (d.message && d.message.id) || null, rid: null,
        model: src.model || 'deepseek', ts,
        u: {
          in: u.inputTokens || 0,
          cw: u.cacheWriteTokens || 0,
          cr: u.cacheReadTokens || 0,
          out: u.outputTokens || 0,
        },
      });
      if (!data.source && src.provider) data.source = src.provider;
    } else if (e.type === 'user/message' && d && d.source && d.source.kind === 'user') {
      // 只要真人输入,插件注入的运行时快照/提醒不算
      const t = (d.content || []).filter(c => c && c.type === 'text' && c.text).map(c => c.text).join('\n').trim();
      if (t && data.events.length < MAX_EVENTS_PER_SESSION) {
        data.events.push({ ts, kind: 'prompt', text: t.slice(0, 300) });
      }
    }
  }
  if (!data.events.length && title) data.events.push({ ts: data.firstTs, kind: 'prompt', text: title.slice(0, 300) });
  return data;
}

// ---------- 数据源: Reasonix ----------
// 每个会话一个 <时间戳>-<模型>.jsonl.telemetry.json，里面是整段用量汇总
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const REASONIX_DIR = path.join(APPDATA, 'reasonix', 'projects');

// 把 Claude 风格的目录别名还原成路径：C--Users-PY-foo → C:\Users\PY\foo
function unslug(slug) {
  return String(slug).replace(/^([A-Za-z])--/, '$1:\\').replace(/-/g, '\\');
}

function parseReasonixFile(fp) {
  const base = path.basename(fp).replace(/\.jsonl\.telemetry\.json$/, '');
  const m = base.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})[.\d]*-(.+)$/);
  let ts = null, model = 'unknown';
  if (m) {
    ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    // 文件名里 provider 和 model 可能重复：deepseek-deepseek-v4-flash
    model = m[7].replace(/^([a-z0-9]+)-\1-/i, '$1-');
  }
  if (!ts) { try { ts = fs.statSync(fp).mtimeMs; } catch { ts = Date.now(); } }
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const u = j.usage || {};
  const sessDir = path.dirname(fp);
  const data = {
    app: 'reasonix', id: base, agent: false,
    cwd: unslug(path.basename(path.dirname(sessDir))), source: null,
    firstTs: ts, lastTs: ts + (u.elapsedMs || 0),
    usageEntries: [], events: [],
  };
  const cr = u.cacheHitTokens || 0;
  if (u.promptTokens || u.completionTokens) {
    data.usageEntries.push({
      mid: base, rid: null, model, ts,
      u: {
        in: u.cacheMissTokens != null ? u.cacheMissTokens : Math.max(0, (u.promptTokens || 0) - cr),
        cw: 0, cr,
        out: u.completionTokens || 0, // 已含 reasoningTokens
      },
    });
  }
  try { // 同名 goal-state 里是这次会话的目标，拿来当标题
    const goal = JSON.parse(fs.readFileSync(path.join(sessDir, base + '.goal-state.json'), 'utf8')).goal;
    if (goal) data.events.push({ ts, kind: 'prompt', text: String(goal).slice(0, 300) });
  } catch {}
  return data;
}

// ---------- 数据源: ZCode CLI ----------
// rollout/model-io-*.jsonl：一行一次模型往返，行可能有数 MB
const ZCODE_DIR = path.join(HOME, '.zcode', 'cli', 'rollout');

function parseZcodeFile(fp) {
  const data = {
    app: 'zcode', id: path.basename(fp, '.jsonl').replace(/^model-io-/, ''), agent: false,
    cwd: null, source: null, firstTs: null, lastTs: null,
    usageEntries: [], events: [],
  };
  eachLine(fp, (line) => {
    if (!line || line[0] !== '{') return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const ts = e.completedAt ? Date.parse(e.completedAt) : (e.startedAt ? Date.parse(e.startedAt) : null);
    if (ts) {
      if (!data.firstTs || ts < data.firstTs) data.firstTs = ts;
      if (!data.lastTs || ts > data.lastTs) data.lastTs = ts;
    }
    if (e.sessionId) data.id = e.sessionId;
    const u = e.response && e.response.usage;
    if (!u) return; // 出错的往返没有 usage
    data.usageEntries.push({
      mid: e.requestId || null, rid: null,
      model: (e.model && e.model.modelId) || (e.response && e.response.modelId) || 'unknown', ts,
      u: {
        in: Math.max(0, (u.inputTokens || 0) - (u.cacheReadTokens || 0)),
        cw: u.cacheWriteTokens || 0,
        cr: u.cacheReadTokens || 0,
        out: u.outputTokens || 0,
      },
    });
  });
  return data;
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
    id: 'dsh', name: 'DeepSeek Harness', kind: 'files', root: DSH_DIR,
    list: () => walkFiles(DSH_DIR, 3, n => n === 'session.jsonl.zstd'),
    parse: parseDshFile,
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
  {
    id: 'reasonix', name: 'Reasonix', kind: 'files', root: REASONIX_DIR,
    list: () => walkFiles(REASONIX_DIR, 3, n => n.endsWith('.telemetry.json')),
    parse: parseReasonixFile,
  },
  {
    id: 'zcode', name: 'ZCode', kind: 'files', root: ZCODE_DIR,
    list: () => walkFiles(ZCODE_DIR, 1, n => n.startsWith('model-io-') && n.endsWith('.jsonl')),
    parse: parseZcodeFile,
  },
];

// ---------- 本机 AI 工具探测 ----------
// 只看目录是否存在，不读内容：装了但没有用量日志的工具也如实列出来
const P = { home: d => path.join(HOME, d), app: d => path.join(APPDATA, d), local: d => path.join(LOCALAPPDATA, d) };
const vscodeExt = (host, ext) => path.join(APPDATA, host, 'User', 'globalStorage', ext);

const TOOLBOX = [
  // 已接入的（status 由 SOURCES 是否产出数据决定）
  { id: 'claude', name: 'Claude Code', kind: 'CLI', paths: [P.home('.claude')] },
  { id: 'codex', name: 'Codex', kind: 'CLI', paths: [P.home('.codex')] },
  { id: 'gemini', name: 'Gemini CLI', kind: 'CLI', paths: [P.home('.gemini')] },
  { id: 'dsh', name: 'DeepSeek Harness', kind: 'CLI', paths: [P.home('.dsh')] },
  { id: 'opencode', name: 'OpenCode', kind: 'CLI', paths: [path.join(HOME, '.local', 'share', 'opencode'), P.app('ai.opencode.desktop')] },
  { id: 'continue', name: 'Continue', kind: 'IDE 插件', paths: [P.home('.continue'), vscodeExt('Code', 'continue.continue')] },
  { id: 'reasonix', name: 'Reasonix', kind: 'CLI', paths: [P.app('reasonix'), P.home('.reasonix')] },
  { id: 'zcode', name: 'ZCode', kind: 'CLI', paths: [P.home('.zcode'), P.app('ZCode')] },
  // 装了但本机日志里没有用量数据
  { id: 'kiro', name: 'Kiro', kind: 'IDE', paths: [P.home('.kiro'), P.app('Kiro')], note: '会话日志不含 token 用量' },
  { id: 'copilot', name: 'GitHub Copilot', kind: 'IDE 插件', paths: [P.home('.copilot'), vscodeExt('Code', 'github.copilot-chat')], note: '不落本地用量日志' },
  { id: 'antigravity', name: 'Antigravity', kind: 'IDE', paths: [P.home('.antigravity'), P.app('Antigravity')], note: '会话是未公开的 protobuf 格式' },
  { id: 'cagent', name: 'cagent', kind: 'CLI', paths: [P.home('.cagent')] },
  { id: 'zagent', name: 'zagent', kind: 'CLI', paths: [P.home('.zagent')] },
  { id: 'securecoder', name: 'SecureCoder', kind: 'CLI', paths: [P.home('.securecoder')] },
  { id: 'workbuddy', name: 'WorkBuddy', kind: '桌面端', paths: [P.home('.workbuddy')] },
  { id: 'hyperframes', name: 'Hyperframes', kind: 'CLI', paths: [P.home('.hyperframes')] },
  { id: 'kimi', name: 'Kimi', kind: '桌面端', paths: [P.home('.kimi-work'), P.app('kimi-desktop')] },
  { id: 'ccr', name: 'Claude Code Router', kind: '路由器', paths: [P.home('.claude-code-router')] },
  { id: 'ccswitch', name: 'CC Switch', kind: '路由器', paths: [P.home('.cc-switch'), P.app('com.ccswitch.desktop')] },
  { id: 'cliproxy', name: 'CLI Proxy API', kind: '路由器', paths: [P.home('.cli-proxy-api')] },
  { id: 'codexpp', name: 'Codex++', kind: 'CLI', paths: [P.home('.codex-plusplus'), P.app('codex-plusplus')] },
  { id: 'ollama', name: 'Ollama', kind: '本地模型', paths: [P.home('.ollama'), P.app('ollama app.exe')] },
  { id: 'vscode', name: 'VS Code', kind: 'IDE', paths: [P.home('.vscode'), P.app('Code')] },
  // 本机没装也保留，换台机器就能自动认出来
  { id: 'cline', name: 'Cline', kind: 'IDE 插件', paths: [vscodeExt('Code', 'saoudrizwan.claude-dev'), vscodeExt('Cursor', 'saoudrizwan.claude-dev')] },
  { id: 'roo', name: 'Roo Code', kind: 'IDE 插件', paths: [vscodeExt('Code', 'rooveterinaryinc.roo-cline')] },
  { id: 'kilo', name: 'Kilo Code', kind: 'IDE 插件', paths: [vscodeExt('Code', 'kilocode.kilo-code')] },
  { id: 'cursor', name: 'Cursor', kind: 'IDE', paths: [P.home('.cursor'), P.app('Cursor')] },
  { id: 'windsurf', name: 'Windsurf', kind: 'IDE', paths: [P.home('.windsurf'), P.home('.codeium'), P.app('Windsurf')] },
  { id: 'trae', name: 'Trae', kind: 'IDE', paths: [P.home('.trae'), P.app('Trae')] },
  { id: 'zed', name: 'Zed', kind: 'IDE', paths: [P.home('.zed'), P.local('Zed')] },
  { id: 'aider', name: 'Aider', kind: 'CLI', paths: [P.home('.aider'), P.home('.aider.conf.yml')] },
  { id: 'goose', name: 'Goose', kind: 'CLI', paths: [path.join(HOME, '.local', 'share', 'goose'), P.home('.goose')] },
  { id: 'crush', name: 'Crush', kind: 'CLI', paths: [path.join(HOME, '.local', 'share', 'crush'), P.home('.crush')] },
  { id: 'amp', name: 'Amp', kind: 'CLI', paths: [P.home('.amp')] },
  { id: 'factory', name: 'Factory Droid', kind: 'CLI', paths: [P.home('.factory')] },
  { id: 'qwen', name: 'Qwen Code', kind: 'CLI', paths: [P.home('.qwen')] },
  { id: 'iflow', name: 'iFlow', kind: 'CLI', paths: [P.home('.iflow')] },
  { id: 'cody', name: 'Sourcegraph Cody', kind: 'IDE 插件', paths: [vscodeExt('Code', 'sourcegraph.cody-ai')] },
  { id: 'augment', name: 'Augment', kind: 'IDE 插件', paths: [vscodeExt('Code', 'augment.vscode-augment')] },
];

let toolCache = { at: 0, list: [] };
function detectTools(activeApps) {
  const now = Date.now();
  if (now - toolCache.at > 60000) { // 目录探测便宜，但没必要每次请求都做
    toolCache = {
      at: now,
      list: TOOLBOX.filter(t => t.paths.some(p => fs.existsSync(p)))
        .map(t => ({ id: t.id, name: t.name, kind: t.kind, note: t.note || null })),
    };
  }
  const parsed = new Set(SOURCES.map(s => s.id));
  return toolCache.list.map(t => ({
    ...t,
    status: activeApps.has(t.id) ? 'tracked' : parsed.has(t.id) ? 'idle' : 'detected',
  }));
}

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

// ---------- 历史归档 ----------
// 工具会滚动清理自己的日志，清掉之后统计就永远缺一块。这里把每天的 token 量落盘，
// 只存 token 不存成本（成本随定价随时重算）。
const ARCHIVE_PATH = path.join(__dirname, 'data', 'archive.json');
let archive = {}; // date -> app -> model -> {in,cw,cr,out}
try {
  archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
} catch { archive = {}; }
let archiveDirty = false;

function mergeArchive(daily, todayStr) {
  for (const [date, byApp] of daily) {
    if (date >= todayStr) continue; // 今天还在变，等它过去
    if (!archive[date]) archive[date] = {};
    for (const [app, models] of Object.entries(byApp)) {
      if (!archive[date][app]) archive[date][app] = {};
      for (const [model, u] of Object.entries(models)) {
        const old = archive[date][app][model];
        const tok = u.in + u.cw + u.cr + u.out;
        // 日志被裁剪后重算可能变小，保留更大的那份
        if (old && (old.in + old.cw + old.cr + old.out) >= tok) continue;
        archive[date][app][model] = { in: u.in, cw: u.cw, cr: u.cr, out: u.out };
        archiveDirty = true;
      }
    }
  }
  if (archiveDirty) saveArchive();
}
function saveArchive() {
  try {
    fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
    const tmp = ARCHIVE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(archive));
    fs.renameSync(tmp, ARCHIVE_PATH); // 原子写，避免半截文件
    archiveDirty = false;
  } catch (e) { console.error('archive:', e.message); }
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

// 工具报错分类（顺序即优先级，第一条命中即归类）
const ERR_TYPES = [
  ['用户拒绝/中断', /doesn't want to proceed|user rejected|interrupted|已中断/i],
  ['编辑串不匹配', /string to replace|old_string|not unique|has been modified since read/i],
  ['文件/内容未找到', /not found|no such file|does not exist|cannot find|ENOENT|no matches|找不到|不存在/i],
  ['权限被拒', /permission|denied|EACCES|EPERM|not allowed|requires approval/i],
  ['超时', /timed? ?out|ETIMEDOUT/i],
  ['命令失败', /exit code|exited with|command failed|non-zero|fatal:|error:/i],
];
function classifyErr(t) {
  for (const [name, re] of ERR_TYPES) if (re.test(t)) return name;
  return '其他';
}

// ccusage 式 5 小时计费窗口：起点=静默期后首次活动所在整点（UTC 对齐），窗口长 5h
function computeBlocks(entriesByApp) {
  const HOUR = 3600000, LEN = 5 * HOUR;
  const out = {};
  for (const [app, list] of entriesByApp) {
    list.sort((a, b) => a.ts - b.ts);
    const arr = [];
    let cur = null, lastTs = 0;
    for (const e of list) {
      if (!cur || e.ts >= cur.start + LEN || e.ts - lastTs >= LEN) {
        cur = { start: Math.floor(e.ts / HOUR) * HOUR, tok: 0, cost: 0, last: e.ts };
        arr.push(cur);
      }
      cur.tok += e.tok; cur.cost += e.cost; cur.last = e.ts;
      lastTs = e.ts;
    }
    for (const b of arr) b.end = b.start + LEN;
    out[app] = arr.slice(-150);
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
  const blockEntries = new Map(); // app -> [{ts, tok, cost}] 用于 5 小时窗口
  const errTypes = new Map();     // 错误类型 -> {n, samples}
  let errTotal = 0, claudeMsgs = 0;
  let nightCost = 0, promptTotal = 0, cmdTotal = 0, savedByCache = 0;
  const rangeMs = now - days * 86400000;

  for (const d of collectSessionData(cutoffMs)) {
    if (!d.lastTs || d.lastTs < rangeMs) continue;
    const app = d.app;
    const sess = {
      app, id: d.id, agent: d.agent, parent: d.parent || null, cwd: d.cwd, source: d.source || null,
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
      if (en.ts) {
        if (!blockEntries.has(app)) blockEntries.set(app, []);
        blockEntries.get(app).push({ ts: en.ts, tok: en.u.in + en.u.cw + en.u.cr + en.u.out, cost });
      }
    }
    if (app === 'claude') {
      claudeMsgs += d.usageEntries.length;
      if (d.errCount) {
        let sampled = 0;
        for (const er of (d.errors || [])) {
          if (er.ts && er.ts < rangeMs) continue;
          sampled++;
          const ty = classifyErr(er.text);
          if (!errTypes.has(ty)) errTypes.set(ty, { n: 0, samples: [] });
          const t = errTypes.get(ty);
          t.n++;
          if (t.samples.length < 3) t.samples.push(er.text.slice(0, 170));
        }
        errTotal += sampled;
        // 超出单文件采样上限(200)的部分只计数，归入「其他」
        const overflow = d.errCount - (d.errors || []).length;
        if (overflow > 0 && sampled > 0) {
          errTotal += overflow;
          if (!errTypes.has('其他')) errTypes.set('其他', { n: 0, samples: [] });
          errTypes.get('其他').n += overflow;
        }
      }
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

  // 落盘归档，再把日志里已经消失、只有归档才有的天数补回来
  mergeArchive(daily, todayStr);
  const archivedDates = [];
  const rangeStart = localDate(now - days * 86400000);
  for (const [date, archByApp] of Object.entries(archive)) {
    if (date < rangeStart || date >= todayStr || daily.has(date)) continue;
    archivedDates.push(date);
    const rebuilt = {};
    for (const [app, archModels] of Object.entries(archByApp)) {
      rebuilt[app] = {};
      for (const [model, t] of Object.entries(archModels)) {
        const cost = costOf(model, t);
        rebuilt[app][model] = { ...t, cost };
        if (!models.has(model)) models.set(model, {});
        const mm = models.get(model);
        if (!mm[app]) mm[app] = zero();
        addU(mm[app], t, cost);
        addU(totals.all, t, cost);
      }
    }
    daily.set(date, rebuilt);
  }

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
    detected: detectTools(appsSeen),
    archivedDates, // 这些天的数据来自归档（原始日志已被工具清理）
    archiveDays: Object.keys(archive).length,
    blocks: computeBlocks(blockEntries), // app -> 5 小时计费窗口序列
    errors: {
      total: errTotal, msgs: claudeMsgs,
      types: [...errTypes.entries()].map(([type, t]) => ({ type, n: t.n, samples: t.samples }))
        .sort((a, b) => b.n - a.n),
    },
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

// ---------- 跨工具历史搜索 ----------
// 所有数据源的用户输入/命令都在解析缓存里，直接全量扫一遍即可（词全部命中才算）
function searchEvents(q, days, limit) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const cutoffMs = Date.now() - (days + 1) * 86400000;
  const hits = [];
  for (const d of collectSessionData(cutoffMs)) {
    let sessCost = 0, sessTok = 0;
    const modelSet = new Set();
    for (const en of d.usageEntries) {
      const m = cleanModel(en.model);
      modelSet.add(m);
      sessCost += costOf(m, en.u);
      sessTok += en.u.in + en.u.cw + en.u.cr + en.u.out;
    }
    for (const ev of d.events) {
      const low = ev.text.toLowerCase();
      if (!terms.every(t => low.includes(t))) continue;
      const at = low.indexOf(terms[0]);
      hits.push({
        app: d.app, id: d.id, cwd: d.cwd, agent: d.agent, parent: d.parent || null,
        ts: ev.ts || d.lastTs, kind: ev.kind,
        snippet: (at > 60 ? '…' : '') + ev.text.slice(Math.max(0, at - 60), at + 180),
        sessionCost: sessCost, sessionTokens: sessTok, models: [...modelSet],
      });
    }
  }
  hits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return hits.slice(0, limit);
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
    } else if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      const sdays = Math.min(365, Math.max(1, parseInt(u.searchParams.get('days') || '90', 10)));
      const limit = Math.min(200, Math.max(1, parseInt(u.searchParams.get('limit') || '60', 10)));
      json(200, { q, results: q.trim() ? searchEvents(q, sdays, limit) : [] });
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
    } else if (u.pathname === '/api/pricing/sync' && req.method === 'POST') {
      // 全项目唯一的可选联网点：只在用户于设置里显式点击「同步最新价格」时请求 LiteLLM 官方价格表。
      // 只返回“建议值”，不落盘——用户在表格里确认后走原有 POST /api/pricing 保存。
      const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
      let remote;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(LITELLM_URL, { signal: ctl.signal });
        clearTimeout(timer);
        if (!r.ok) return json(502, { error: 'LiteLLM 返回 HTTP ' + r.status });
        remote = await r.json();
      } catch (e) {
        return json(502, { error: '拉取失败（离线或被墙？）: ' + e.message });
      }
      const index = new Map();
      for (const [k, v] of Object.entries(remote)) {
        if (!v || typeof v !== 'object' || !v.input_cost_per_token) continue;
        const lk = k.toLowerCase();
        if (!index.has(lk)) index.set(lk, v);
        const short = lk.slice(lk.lastIndexOf('/') + 1);
        if (!index.has(short)) index.set(short, v);
      }
      const per1M = x => x ? +(x * 1e6).toFixed(4) : 0;
      const proposed = {}, changes = [];
      for (const [k, v] of Object.entries(PRICING)) {
        proposed[k] = typeof v === 'object' ? { ...v } : v;
        if (k.startsWith('_') || k === 'default') continue;
        const hit = index.get(k.toLowerCase());
        if (!hit) continue;
        const nv = {
          input: per1M(hit.input_cost_per_token),
          output: per1M(hit.output_cost_per_token),
          cacheWrite: hit.cache_creation_input_token_cost != null ? per1M(hit.cache_creation_input_token_cost) : (v.cacheWrite || 0),
          cacheRead: hit.cache_read_input_token_cost != null ? per1M(hit.cache_read_input_token_cost) : (v.cacheRead || 0),
        };
        for (const f of ['input', 'output', 'cacheWrite', 'cacheRead']) {
          if (Math.abs((v[f] || 0) - nv[f]) > 1e-9) changes.push({ key: k, field: f, from: v[f] || 0, to: nv[f] });
        }
        proposed[k] = nv;
      }
      json(200, { ok: true, matched: [...new Set(changes.map(c => c.key))], changes, proposed });
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
