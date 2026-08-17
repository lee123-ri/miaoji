# 喵迹（MiaoJi）移动端 PWA

猫成长记录与养护数据平台：全量记录 + 看板 + 新手引导/专业助手 + AI 拍照分析（DeepSeek 视觉）。
零构建、本地优先（IndexedDB），手机浏览器打开即用，可"添加到主屏幕"。

## 目录
- `index.html` — 移动端 PWA 主程序（原生 JS + IndexedDB，无外部依赖）
- `worker.js` — Cloudflare Worker 代理（DeepSeek 文本 / 视觉，密钥存环境变量）
- `README.md` — 本文件

## 本地运行
```bash
cd 喵迹-app
python3 -m http.server 5173
# 手机与电脑同网段时，手机浏览器访问 http://<电脑IP>:5173
# 或电脑浏览器打开 http://localhost:5173（建议用手机模拟视图）
```

## 一键部署到 Cloudflare Pages（推荐 · 免费）

```bash
cd 喵迹-app/dist
npm i -g wrangler
wrangler login
# 首次部署
wrangler pages deploy . --project-name=miaoji
# 设置 DeepSeek API Key
wrangler pages secret put DEEPSEEK_API_KEY --project-name=miaoji
```

部署后得到 `https://miaoji-xxxx.pages.dev` 地址，手机浏览器打开即可：
- 前端会自动探测 `/api/health`，发现同域 API 后自动接通 AI；
- **无需在「我的→设置」里手动填 Worker URL**。

`dist/` 目录说明见 `dist/README.md`。

## 部署独立 Cloudflare Worker（DeepSeek 代理）
```bash
npm i -g wrangler
wrangler login
# 在 worker.js 同目录执行：
wrangler deploy
wrangler secret put DEEPSEEK_API_KEY   # 粘贴你的 DeepSeek API Key
```
部署后得到 Worker URL（如 `https://miaoji-proxy.xxx.workers.dev`）。

> Worker 已配置 CORS，允许前端跨域调用；密钥仅存于 Worker 环境变量，**绝不下发前端**。

## 在 App 中接入
打开 App → 「我的」→ 填入 **DeepSeek Worker URL** → 保存。
- 未填：助手走内置离线知识库，拍照分析用演示数据（功能可见，结果非真实）。
- 已填：助手与拍照分析调用真实 DeepSeek。

## 功能速览
- **记一笔（底部＋）**：24 维全量录入；异常维度触发红色预警。
- **拍照分析（📷）**：食物营养 / 排泄物 / 皮肤 / 行为 / 用药 / 伤口 / 环境 / 体态，8 类 DeepSeek 视觉分析，结果可一键存为记录。
- **首页看板**：体重成长曲线、健康分、提醒倒计时、今日待办。
- **助手**：RAG over 本地记录（需 Worker）+ 新手引导 + 红色预警规则。
- **数据**：导出 JSON；清空本地数据。

## 隐私
记录默认留本地（IndexedDB）。仅当你提问或拍照分析时，相关片段经 Worker 上行至 DeepSeek。
可在「我的」关闭助手记忆。
