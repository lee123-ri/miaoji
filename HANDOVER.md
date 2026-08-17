# 喵迹（MiaoJi）· 项目交接文档

> **给接手者（人或 Agent）**：读完本文即可独立开发、测试、部署，无需追问原作者。
> 最后更新：2026-08-06 · 状态：**MVP 闭环完成，56/56 回归通过，未上云**

---

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 是什么 | 猫咪成长记录 + AI 养护助手的移动端 PWA |
| 目标用户 | **零经验新手铲屎官**（这是最高优先级约束，所有设计围绕它） |
| 技术栈 | **零构建单文件 HTML** + 原生 JS + IndexedDB；无 React / 无 Vite / 无 npm 依赖 |
| AI | DeepSeek（`deepseek-chat`），经服务端代理调用，**密钥绝不下发前端** |
| 数据 | 全部存浏览器 IndexedDB，本地优先，**当前未上云** |
| 跑起来 | `python3 -m http.server 5173` 然后开 `http://localhost:5173/` |
| 测试 | `node e2e-test.mjs http://localhost:5173/` → 应输出 56/56 |

**最重要的一条设计原则**：宠物健康不能靠模型"猜"。所有涉及"要不要去医院"的结论，**必须由本地硬规则（`RED_RULES` / `RED_KW`）判定**，AI 只做辅助描述。改代码时不要破坏这条。

---

## 1. 目录结构与每个文件的职责

```
喵迹-app/
├── index.html          ★ 主程序（1400+ 行，唯一的前端源文件，改这个）
├── dist/               ★ Cloudflare Pages 部署包（由 sync-dist.py 生成，勿手改 index.html）
│   ├── index.html          ← 主程序 + 3 个部署补丁（自动注入，见 §5）
│   ├── functions/api/      ← Pages Functions（服务端 AI 代理）
│   │   ├── common.js           公共：CORS、DeepSeek 调用、视觉提示词
│   │   ├── health.js           GET  /api/health   探活
│   │   ├── chat.js             POST /api/chat     文本问答
│   │   └── vision.js           POST /api/vision   图片分析
│   ├── manifest.json       PWA 清单（可"添加到主屏幕"）
│   ├── sw.js               Service Worker（离线缓存）
│   ├── icon-192/512.png    图标（由 make-icons.py 生成）
│   ├── _routes.json        告诉 Pages 哪些路径走 Function
│   └── wrangler.toml       Pages 项目配置
├── ingest-server.mjs   ★ 本地素材抓取服务（监控目录 → 抽帧 → 喂给前端分析）
├── e2e-test.mjs        ★ Playwright 回归测试（56 项断言）
├── sync-dist.py        主程序 → dist 的同步脚本（改完 index.html 必须跑）
├── make-icons.py       生成 PWA 图标
├── worker.js           旧版独立 Cloudflare Worker 代理（已被 dist/functions 取代，保留备查）
└── README.md           面向用户的运行/部署说明
```

**改代码只改 `index.html`**，然后 `python3 sync-dist.py` 同步到 dist。直接改 `dist/index.html` 会在下次同步时被覆盖。

---

## 2. 前端架构（index.html）

单文件，`<script>` 内按注释分区，行号见下（会随改动漂移，用注释文本搜索）：

| 分区 | 职责 |
|---|---|
| `IndexedDB` | 极简 IDB 封装：`idbOpen / idbAll / idbPut / idbDel`。5 个 store：`cats` `logs` `reminders` `chats` `settings` |
| `常量` | `LOG_TYPES`(24 维记录) `VISION_TYPES`(8 类视觉) `RED_RULES`(9 条就医红线) `KB_ARTICLES`(8 篇) `KB`(离线问答) `RED_KW`(危险关键词) |
| **`养护引擎`** | **核心差异化模块**，见 §3 |
| `状态` | 全局单例 `S = { cats, cat, logs, reminders, chats, settings }` |
| `种子` | 首次启动灌演示数据（1 只猫 + 14 条记录） |
| `加载` | `load()` 从 IDB 读全量到 `S` |
| `首页` | `renderHome()` KPI 卡 / 成长曲线（SVG 手绘）/ 养护提示 / 提醒 |
| **`养护中心`** | `careRows()` `genAllCare()` `openCareItem()` `careAdviceFor()` |
| `提醒 CRUD` | 增删改 + 标记完成（自动按周期重置）+ 顺延 |
| `记一笔` | 24 维录入，每维有专用字段 schema |
| `时间线` | 按类型筛选 + 详情 + 编辑 + 删除 |
| `助手` | 聊天 UI + `careAnswer()` 养护问答 + `offlineAnswer()` 离线兜底 + DeepSeek 在线 |
| `拍照分析` | `runVisionAnalyze()` 是**唯一分析入口**，两个来源共用（见 §4） |
| `素材盒` | 接 `ingest-server.mjs`，从本地目录抓摄像头素材 |
| `我的` | 设置 / 多猫管理 / 档案 / 导入导出 / 重置 |
| `导航` | `go(tab)` 切页 |
| `启动` | IIFE：`idbOpen → seedIfEmpty → load → render* → go('home')`，完成后置 `window.__ready = true`（测试依赖这个标志） |

### 数据模型

```js
cats:      { id, name, breed, sex, birth, neutered, avatar }
logs:      { id, cat_id, ts, type, status, note, data{}, remark, photos[] }
reminders: { id, cat_id, title, due, cycle, note, done }
chats:     { id, cat_id, ts, role, text }
settings:  { id:'cfg', workerUrl, assistantOn, catId, refBowlCm, ingestUrl }
```

`logs.type` 取 24 个值之一；`status` ∈ `正常|异常`；`data` 是该维度的专用字段对象。
**所有查询都按 `cat_id` 过滤**——多猫数据隔离靠这个，改动时别漏。

---

## 3. 养护引擎（新手引导的核心）

这是产品最大的差异点：**不是几条静态文案，而是按猫的月龄自动推算每一项该做什么、多久一次、什么时候到期。**

- `CARE_PLAN`：养护项数组，每项含 `{ id, name, icon, age:[最小月龄,最大月龄], cy:{ k:幼猫周期天数, a:成猫周期天数 }, why, how[], warn }`
  - 覆盖：洗澡 / 驱虫（体内外）/ 剪指甲 / 刷牙 / 清耳 / 梳毛 / 疫苗 / 体检 / 换粮 / 猫砂更换 等
- `catMonths()`：由 `cats.birth` 算当前月龄
- `careApplicable(it)`：该项在当前月龄是否适用（幼猫不洗澡、3 月龄前不驱虫等）
- `careCycleOf(it)`：按月龄取幼猫/成猫周期
- `careRows()`：结合 `logs` 里最近一次同类记录，算出「上次做于 X 天前 / 下次还有 Y 天 / 已逾期 Z 天」，用颜色分级推到首页
- `genAllCare()`：一键把全部养护项生成为 `reminders`
- `careAdviceFor(type, o)`：**拍照分析结果 → 养护建议**的映射（例如识别到"便偏干"→ 建议增加饮水/湿粮，并给出具体做法）
- `careAnswer(q)`：助手里问"多久洗一次澡"能直接答出完整方案（周期 + 为什么 + 怎么做 + 注意）

**扩展养护项**：往 `CARE_PLAN` 加一条即可，首页/提醒/助手三处会自动生效，无需改渲染代码。这是设计好的扩展点。

---

## 4. 拍照 AI 分析：链路与准确性设计

### 链路
```
拍照/相册/素材盒
  → 端侧压缩（≤800px, JPEG 0.7）转 base64
  → POST /api/vision { type, image, calib }
  → 服务端按 type 选专用提示词 + response_format:json_object
  → DeepSeek 返回结构化 JSON
  → 端侧解析 → 置信度徽标 → 复核追问 → 趋势对账 → 人工确认 → 存为记录
```

`runVisionAnalyze(dataURL)` 是**唯一**分析函数。相册上传和素材盒都调它——**新增来源时复用它，不要另写一份**。

### 准确性四层（改代码时不要削弱）
1. **参考物校准**：食物类分析前要求填"碗内径 cm"（`settings.refBowlCm`），作为 `calib` 传给服务端，让模型把像素估算换算成真实克数
2. **置信度**：服务端强制模型返回 `confidence(0-1)`，前端 ≥0.6 绿标 / <0.6 红标"仅供参考"
3. **复核追问**：出结果后按类型弹确认题（食物"偏少/适中/偏多"、排泄"干硬/正常/软稀"），答案并入记录
4. **趋势对账**：`reconcile()` 把视觉估值与历史记录比对，偏差 >3x 或 <0.3x 弹"请复核"

### 8 类分析场景
`food` 食物营养 / `stool` 排泄物(Bristol分级) / `skin` 皮肤毛发 / `behavior` 行为 / `med` 用药OCR / `wound` 伤口肿块 / `environment` 环境隐患 / `body` 体态BSC

### 边界（必须在 UI 上如实告知用户，已实现，勿删）
视觉估算 ≠ 测量；医疗结论是筛查不是诊断。免责声明在 `showVision()` 结果区底部。

---

## 5. 部署（Cloudflare Pages，前端+API 同域）

```bash
cd 喵迹-app
python3 sync-dist.py                       # 1. 同步主程序到 dist
cd dist
npx wrangler pages deploy . --project-name=miaoji
npx wrangler pages secret put DEEPSEEK_API_KEY --project-name=miaoji
```

部署后拿到 `https://miaoji-xxxx.pages.dev`。手机打开会**自动探测 `/api/health`**，成功则自动启用 AI，**用户无需手动填代理地址**。

`sync-dist.py` 自动注入的 3 个部署补丁（这就是为什么不能直接改 dist）：
1. PWA `<head>`：manifest / apple-touch-icon / theme-color
2. `detectSameOriginAPI()`：启动时探测同域 `/api/health`，成功则设 `settings.workerUrl = location.origin + '/api'`
3. Service Worker 注册

**免费额度**：Pages 静态资源不限量，Functions 10 万请求/天。个人使用唯一成本是 DeepSeek API 调用费。

**为什么选 Cloudflare 而不是国内云**：前后端同域一次部署、无需备案、无需实名。已对比过 EdgeOne / SCF / FC / Vercel / Deno Deploy，结论见根目录 `喵迹-免费部署方案对比.md`。

---

## 6. 本地素材抓取通道（摄像头联动）

用户把摄像头照片/视频存到固定目录，系统去抓，**前端原有上传入口零改动**。

```bash
node ingest-server.mjs --web ./dist --port 7788
# 素材投放目录：~/喵迹素材/inbox/
# 处理后自动归档到：~/喵迹素材/processed/日期/
```

- 服务**同时托管前端**（`--web ./dist`），这是刻意设计：HTTPS 页面 fetch `http://localhost` 会被浏览器拦截，同源部署可绕开
- 按文件名关键词自动推测分析类型（`food` / `litter|poop`→stool / 默认 behavior）
- 图片用 `sips` 压缩；视频用 `ffmpeg` 抽 3 帧（自动发现 `imageio-ffmpeg` 自带的二进制，无需 brew 装 ffmpeg），无 ffmpeg 时降级 `qlmanage` 取首帧
- API：`GET /ingest/health` `GET /ingest/list` `GET /ingest/payload?id=&frame=` `POST /ingest/ack` `POST /ingest/skip`
- `ack` 会把素材移到 `processed/` 并写一份分析留痕 JSON，不会重复处理

前端未探测到该服务时，素材盒入口自动隐藏——**这就是为什么纯静态服务下会有 `/ingest/health` 404，属预期行为**。

---

## 7. 测试

```bash
cd 喵迹-app
node e2e-test.mjs http://localhost:5173/     # 预期：总计 56 项 · 通过 56 · 失败 0
```

### 踩过的坑（改测试前务必读）

1. **不设默认超时会假死**：Playwright 单 action 默认干等 30s，多个选择器失配就累加成"卡住几十分钟"。已设 `ctx.setDefaultTimeout(6000)` + 全局看门狗 `E2E_WATCHDOG_MS`（默认 6 分钟强制退出）。
2. **弹层遮挡导致连环超时**：上一项测完遗留 `.sheet.show` 会挡住后续点击。已在 `check()` 里加 `cleanup()` 自动收起 sheet。**注意 cleanup 只收 sheet，不能收 `.modal.show`**——拍照分析的 modal 需要跨断言保持打开。
3. **`/ingest/health` 404 污染断言**：console 错误是全局累积的，一个 404 会让后续所有断言误报。已在 console 监听里按 URL 过滤掉 `/ingest/*`。
4. **`ERR_NAME_NOT_RESOLVED` 是故意的**：有一项测试填无效域名，验证 AI 代理连不通时 App 会不会崩（正确行为是提示"连接失败"并降级离线知识库）。这条控制台错误属预期。
5. **测试脚本要放在项目目录内跑**：`node_modules` 是软链到 `~/.workbuddy/binaries/node/workspace/node_modules`，在 `/tmp` 下跑会 `ERR_MODULE_NOT_FOUND`。
6. **UI 改动后要同步更新断言**：例如助手页新增养护卡片后，`#p-ai .card h2 .tag` 会匹配错卡片，必须用 `h2:has-text("专业助手") .tag`。

### 运行环境
- Node: `/Users/lee/.workbuddy/binaries/node/versions/22.22.2/bin/node`
- Playwright 浏览器：`PLAYWRIGHT_BROWSERS_PATH=0`（装在 workspace 内）
- Python: `/Users/lee/.workbuddy/binaries/python/versions/3.13.12/bin/python3`

---

## 8. 当前状态与下一步

### 已完成 ✅
- 24 维全量记录，每维专用字段，可增删改
- 首页看板：KPI 下钻、成长曲线（4 档时间范围 + 数据点详情）、养护提示、提醒
- 养护引擎：按月龄自动推算全部养护项周期与到期日
- 提醒：增/详情/完成(自动重置周期)/顺延/编辑/删
- AI 助手：在线 DeepSeek + 离线知识库兜底，对话持久化，结合本地记录回答
- 拍照分析 8 类场景 + 准确性四层
- 本地素材抓取通道（摄像头联动）
- 多猫管理与数据隔离
- 导入导出 JSON、重置演示数据
- PWA（可添加到主屏幕、离线可用）
- 56 项 E2E 回归全通过

### 未做 / 已知限制 ⚠️
- **未上云**：数据只在浏览器 IndexedDB，换设备不同步，清缓存会丢（导出 JSON 是唯一备份手段）
- **未接真实 DeepSeek 验证**：拍照分析目前跑的是演示数据，真实准确率未测
- 无用户账号体系、无多端同步、无计费
- 摄像头是手动投放素材，未做 RTSP/Tuya 自动拉流

### 推荐的下一步顺序（有意为之，别跳步）
1. **真机自用一周** → 砍掉 24 维里的伪需求（预计能砍掉一半）
2. **接通 DeepSeek** → 验证拍照分析真实准确率（这是产品核心卖点，没验证就上云等于放大一个未验证假设）
3. **定数据模型终稿**
4. **再做多租户上云**（方案已写好，见根目录 `喵迹-多租户云部署设计.md`：共享库 + `tenant_id` 行级隔离 + RLS，境内存储）

> **为什么不先上云**：当前 IndexedDB 的数据模型未经真实使用检验。一旦映射到 Postgres + RLS，再改数据模型成本高一个数量级。

---

## 9. 相关文档（在工作区根目录）

| 文件 | 内容 |
|---|---|
| `喵迹-猫成长数据平台-方案与开发说明.md` | 主 Spec：需求、决策表、数据模型、路线图 |
| `喵迹-多租户云部署设计.md` | 上云方案：租户模型、RLS、鉴权、合规、成本 |
| `喵迹-MVP闭环验证报告.md` | 闭环验证结果与上云前置条件 |
| `喵迹-免费部署方案对比.md` | 各免费平台对比与选型理由 |
| `喵迹-app/README.md` | 面向使用者的运行与部署说明 |

---

## 10. 给接手 Agent 的注意事项

1. **改 `index.html` 后必须跑 `python3 sync-dist.py`**，否则部署包是旧的
2. **改完必须跑 `node e2e-test.mjs`**，保持 56/56
3. **不要引入构建工具**。零构建单文件是刻意选择——用户要"手机打开即用"，加 Vite/React 会破坏这个特性且收益有限
4. **不要把 API Key 写进前端**。所有 AI 调用必须走服务端代理
5. **不要让 AI 决定医疗结论**。红线判定必须是本地硬规则
6. **新增记录维度**：改 `LOG_TYPES` + 对应字段 schema，渲染层自动适配
7. **新增养护项**：往 `CARE_PLAN` 加一条，三处自动生效
8. **新增视觉场景**：`VISION_TYPES` 加一项 + `dist/functions/api/common.js` 里加提示词
