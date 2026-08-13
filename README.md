# AIcost Radar 📟

本地 AI 编程工具用量雷达 —— 零依赖、纯本地、单文件前端。自动扫描 Claude Code、Codex、Gemini CLI、DeepSeek Harness、OpenCode、Continue、Reasonix、ZCode 留在本机的会话日志，聚合出模型、成本、token、缓存命中率、会话记录，用一个暗色发光风格的面板展示。还能**跨工具搜历史**、算**订阅回本**、出**省钱诊断**。数据不出本机。

**A local usage & cost radar for AI coding tools.** Zero dependencies, fully offline, single-file frontend. It scans the session logs that eight AI coding tools already write to your machine and aggregates models, costs, tokens, cache hit rate and per-session history into a dark glow dashboard — plus cross-tool history search, subscription break-even tracking, and savings diagnostics. Nothing leaves your machine. *(English notes inline below.)*

## 支持的数据源 / Supported sources

| 工具 | 日志位置 | 说明 |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | 含子代理（subagent）转录 |
| **Codex** | `~/.codex/sessions/**/*.jsonl` | 自动剥离 relay 前缀（`xxx::model`） |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/*.json` | 逐消息 token 记录 |
| **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (dsh) | `~/.dsh/sessions/**/session.jsonl.zstd` | 多 zstd frame 拼接，逐段解压（需内置 `node:zlib` zstd） |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | SQLite，内置 `node:sqlite` |
| **Continue** (VSCode) | `~/.continue/dev_data/*/tokensGenerated.jsonl` | 逐请求 token 记录 |
| **Reasonix** | `%APPDATA%/reasonix/projects/*/sessions/*.telemetry.json` | 整段会话用量汇总，模型名从文件名解析 |
| **ZCode** | `~/.zcode/cli/rollout/model-io-*.jsonl` | 一行一次模型往返（单行可达数 MB） |

### 本机 AI 工具探测 / Machine-wide tool detection

除了上面这些「能读到用量」的数据源，面板还会扫描本机装了哪些 AI 工具，在「🔎 本机 AI 工具」卡片里分三档如实列出：

| 状态 | 含义 |
|---|---|
| **已接入** | 有解析器且当前时间范围内有用量 |
| **无近期用量** | 有解析器，但这段时间没用过 |
| **未接入** | 装了但读不到用量，卡片上会写明原因（如 Kiro 的会话日志不含 token、Antigravity 是未公开的 protobuf、Copilot 不落本地用量日志） |

探测表 `TOOLBOX`（在 `server.js` 里）目前覆盖 **39 个工具**：Claude Code、Codex、Gemini CLI、DeepSeek Harness、OpenCode、Continue、Reasonix、ZCode、Kiro、GitHub Copilot、Antigravity、Cline、Roo Code、Kilo Code、Cursor、Windsurf、Trae、Zed、Aider、Goose、Crush、Amp、Factory Droid、Qwen Code、iFlow、Cody、Augment、Ollama、VS Code、Claude Code Router、CC Switch、CLI Proxy API 等。加一个工具只要在 `TOOLBOX` 里加一行（工具名 + 候选目录），不需要写解析器。

Beyond the parsed sources above, the dashboard scans for AI tools installed on your machine and lists them honestly in three states: **tracked** (parser + recent usage), **idle** (parser, no usage in range), **detected** (installed but no readable usage — the card states why). The `TOOLBOX` registry in `server.js` covers 39 tools; adding one is a single line (name + candidate paths), no parser needed.

不存在的目录会自动跳过；面板上的数据源筛选按钮只显示实际有数据的工具。任何新模型（DeepSeek、Grok、本地模型……）只要出现在这些日志里就会自动显示，未配置定价时按 `default` 条目估算。

Sources that don't exist on your machine are skipped automatically. Any new model appearing in the logs shows up automatically; unknown models are priced using the `default` entry.

## 快速开始 / Quick start

```bash
git clone https://github.com/ypyik0669/aicost-radar.git
cd aicost-radar
node server.js        # 或 npm start
# 打开 http://127.0.0.1:38765
```

Windows 用户可以双击 `启动监控.vbs`：后台启动服务（无黑窗）并用 Edge 应用模式打开一个独立小窗口。服务是单实例的——重复启动会自动退出。

Windows users can double-click `启动监控.vbs` to start the server hidden and open an Edge app-mode window. The server is single-instance.

**要求 / Requirements**: Node.js ≥ 22.15（OpenCode 需要内置 `node:sqlite`，DeepSeek Harness 需要内置 zstd 解压；其他数据源任何近代 Node 均可，缺失能力会自动跳过该源而不报错）。无任何 npm 依赖。

Node.js ≥ 22.15 (built-in `node:sqlite` for OpenCode, built-in zstd for DeepSeek Harness). Sources whose runtime capability is missing are skipped silently. No npm dependencies.

## 功能 / Features

- 💰 今日 / 区间成本、日均、月度预估、缓存节省金额
- 📊 每日成本堆叠柱状图（按模型着色，悬停看明细）
- 🕐 24 小时 × 14 天活动热力图
- 🧊 缓存命中率 Halo 仪表盘（总体 + 按工具）
- 🤖 模型排行 / 📁 项目分布 / ⌨️ 常用命令
- 💬 会话记录：每个终端窗口一行，点击展开该会话的全部输入和命令
- 🎯 趣味统计：连续活跃天数、最烧钱的一天、夜猫指数……
- ⚙️ **面板内自定义定价**：点右上角齿轮直接编辑，保存后立即重算全部成本
- 🔄 自动刷新（间隔可调）；数据源与天数筛选
- 🎛️ **个性化设置**：美元/人民币显示（汇率可调）、咖啡单价、刷新间隔、问候昵称
- 💰 **预算燃烧条**：设月度/日度预算，80% 变黄、超支变红警告
- 🚕 **实时烧钱计价器**：有活跃会话时显示 $/分钟 跳表，今日成本实时外推跳动
- 🏆 **成就徽章**：夜猫王 / 缓存大师 / 千刀万刃…12 枚徽章按 90 天数据解锁
- 🎨 **Wrapped 分享海报**：一键生成 90 天用量总结 PNG
- 🎉 **破纪录彩带**：单日成本 / 连续天数破纪录时全屏 confetti
- 🧩 **卡片自由布局**：拖 ☰ 排序、设置里勾选显隐，记住你的布局
- 📤 **数据导出**：每日成本 CSV / 会话 CSV / 原始 JSON
- 📅 **90 天贡献图**：GitHub 风格活动格子
- ⏱️ **近 5 小时窗口**：粗粒度参考订阅限额节奏

## 四件别处没有的事 / Four things you won't find elsewhere

这四项针对的是同类工具普遍留下的空白：Cherry Studio 之类的客户端到今天仍没有内置费用统计（[CherryHQ/cherry-studio#5890](https://github.com/CherryHQ/cherry-studio/issues/5890)），跨工具找历史要靠人肉回忆，订阅到底回没回本全靠感觉。

### 🔍 跨工具历史搜索

顶栏搜索框（`Ctrl/⌘+K` 聚焦）一次搜遍**所有已接入工具**的历史输入与命令，90 天范围内。结果里除了来源、时间、工作目录和高亮片段，还带**这次会话花了多少钱**——这是纯搜索工具给不了的维度。点任意结果直接展开该会话全文。

One search box across every tool's history, with the cost of each matching session attached. `Ctrl/⌘+K` to focus.

### 💳 订阅回本卡

在 ⚙️ 设置 → 订阅里登记多条订阅（`名称 + 月费 + 覆盖哪些工具`，比如 Claude Max 20x $200 覆盖 Claude Code、中转包月覆盖 Codex）。卡片按**自然月**统计这些工具的 API 等价成本，画出回本进度条：

- 未回本 → 「还差 $Z，日均需 $W」
- 已回本 → 「多赚 $Y」
- 底部合计净赚 / 净亏，并单列没被任何订阅覆盖的**按量付费**部分

Register multiple stacked subscriptions and see, per calendar month, whether each one has paid for itself in API-equivalent cost.

### 🩺 省钱诊断

基于已解析的会话数据给出**可执行**建议，每条附估算可省金额，按金额排序，可点进具体会话核查：

| 检查 | 判定 |
|---|---|
| 🧊 缓存命中异常低 | 命中率低于该工具中位数一半且成本 > $0.5 |
| 🎈 上下文膨胀 | 平均每轮输入 > 80k token（建议 `/compact` 或新开会话） |
| 💸 小任务用了贵模型 | 1–2 条输入、输出 < 2k token 却用了最贵档模型 |
| 🛸 高成本无人值守 | 成本 > $5 但没有人工输入且消息数 ≥ 20 |

阈值全部写在卡片文案里，不做黑箱建议。

Actionable savings diagnostics with an estimated dollar figure per finding; every threshold is stated in the card rather than hidden.

### 📦 历史归档 + 失控告警

各家工具都会自己轮转、裁剪甚至删除日志，历史统计因此会凭空缩水。面板把每天的 token 明细写进 `data/archive.json`（只存 token，成本随定价实时重算），日志消失后仍能补回图表，这些天在图上以半透明区分。

告警走浏览器通知（需在设置里手动开启）+ 面板内 toast：烧钱速率异常（> 近 7 天日均分钟成本的 3 倍）、预算 80% / 100% 触线，同类告警 30 分钟内只提醒一次。

Daily token history is archived locally so rotated-away logs don't shrink your stats; burn-rate spikes and budget thresholds raise a desktop notification (opt-in) plus an in-page toast.

## 自定义定价 / Custom pricing

定价存在 `pricing.json`，单位是**美元 / 百万 token**，按**模型名子串匹配**（多条命中取最长）。可以直接改文件，也可以在面板里点 ⚙️ 编辑，两种方式等价：

```json
{
  "claude-fable-5": { "input": 10, "output": 50, "cacheWrite": 12.5, "cacheRead": 1 },
  "deepseek":       { "input": 0.28, "output": 0.42, "cacheWrite": 0, "cacheRead": 0.028 },
  "my-local-model": { "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0 },
  "default":        { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5 }
}
```

Pricing lives in `pricing.json` (USD per million tokens, longest-substring match on the model name). Edit the file directly or click the ⚙️ gear in the dashboard — both hot-reload and recompute all costs. `default` is the fallback for unrecognized models; set a `0/0/0/0` entry for local models.

## 添加新数据源 / Adding a new source

所有数据源都注册在 `server.js` 的 `SOURCES` 数组里，加一个工具只需要一项：

```js
{
  id: 'mytool', name: 'My Tool', kind: 'files',
  root: MYTOOL_DIR,                                // 目录不存在则整个源被跳过
  list: () => walkFiles(MYTOOL_DIR, 3, n => n.endsWith('.jsonl')),
  parse: parseMyToolFile,                          // 文件 → 会话对象
}
```

`parse` 返回一个统一的会话对象 / `parse` returns one normalized session object:

```js
{
  app: 'mytool', id: '会话唯一ID', agent: false,
  cwd: '/work/dir', source: null,
  firstTs: 1710000000000, lastTs: 1710000600000,   // 毫秒时间戳
  usageEntries: [{
    mid: '消息ID（用于去重，可为 null）', rid: null,
    model: 'model-name', ts: 1710000300000,
    u: { in: 1200, cw: 0, cr: 34000, out: 800 }    // 输入/缓存写/缓存读/输出 token
  }],
  events: [{ ts, kind: 'prompt' | 'command', text: '用户输入' }]
}
```

日志不是纯文本也没关系——解码放在 `parse` 里就行，`parseDshFile` 就是先把多 frame zstd 逐段解压再按 JSONL 解析。非文件型来源（如 SQLite）用 `kind: 'custom'` + `load()` 返回会话数组，参考 OpenCode 的实现。文件按 `mtime+size` 缓存，只有变化的文件会被重新解析。前端无需改动——筛选按钮、标签、缓存卡片都是按数据自动生成的。

For non-file sources (e.g. SQLite) use `kind: 'custom'` with a `load()` returning an array of session objects — see the OpenCode source. Files are cached by mtime+size, and the frontend adapts automatically (filter buttons, tags, and cache cards are all data-driven).

## 隐私 / Privacy

一切都在本机完成：服务只监听 `127.0.0.1`，只读取本地日志文件，不发出任何网络请求，不上传任何数据。

Everything stays on your machine: the server binds to `127.0.0.1` only, reads local log files read-only, and makes zero outbound network requests.

## 架构 / Architecture

```
server.js         零依赖 Node HTTP 服务：数据源扫描、解析缓存、聚合、搜索、定价 API
pricing.json      定价表（面板内可编辑）
public/index.html 单文件前端（原生 JS + SVG，无框架无构建）
data/archive.json 每日 token 归档（自动生成，已 gitignore，删掉会自动重建）
启动监控.vbs       Windows 一键启动器
```

HTTP 接口 / Endpoints：`GET /api/data?days=`（聚合数据）、`GET /api/search?q=&days=&limit=`（跨工具搜索）、`GET|POST /api/pricing`（定价热更新）。

大文件（>512MB 的 JSONL）走分块流式逐行解析；全局按 `messageId:requestId` 去重，避免多文件重复计费。

## License

MIT
