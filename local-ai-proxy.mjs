// 喵迹 · 本地 AI 验证代理（双模型架构）
// 文本助手：DeepSeek（DEEPSEEK_API_KEY / DEEPSEEK_MODEL / DEEPSEEK_BASE_URL）
// 拍照分析：可配置多模态视觉模型（默认通义千问视觉 DashScope，OpenAI 兼容）
//   环境变量：VISION_BASE_URL（默认 DashScope 兼容模式）、VISION_MODEL（默认 qwen-vl-max）、VISION_KEY（必填）
// 密钥只从同目录 .env / 环境变量读取，绝不下发前端
// 前端「我的→设置」AI 代理 URL 填 http://localhost:8787 即可

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* ignore */ }

const PORT = parseInt(process.env.PORT || '8787', 10);
const TEXT_KEY = process.env.DEEPSEEK_API_KEY || '';
const TEXT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TEXT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

const VISION_KEY = process.env.VISION_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen3.7-plus';
const VISION_BASE = process.env.VISION_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const send = (res, status, obj) => {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const SAFETY = '你是专业养猫顾问，语气温和易懂。仅基于提供的信息给建议，紧急情况必须建议尽快就医，不替代执业兽医诊断。回答尽量简洁，关键结论加粗。';

const VISION_PROMPTS = {
  food: '你是宠物营养师。分析这张猫食物照片：估算分量(克)、热量(kcal)、蛋白质/脂肪/碳水大致占比、是否均衡，给出改进建议。只输出 JSON：{portion_g, kcal, protein_pct, fat_pct, carb_pct, balanced:bool, advice:string}。',
  stool: '你是兽医助理。分析这张猫排泄物照片：按 Bristol 分级给出形态(1-7)、颜色、是否带血/寄生虫、健康判定(正常/注意/异常)、预警。只输出 JSON：{bristol:int, color:string, blood:bool, parasite:bool, verdict:string, warning:bool, advice:string}。',
  skin: '你是兽医助理。分析这张猫皮肤/毛发照片：是否有脱毛/皮屑/红肿/猫癣/伤口，给出初判与清洁建议。只输出 JSON：{findings:string, suspicion:string, advice:string, need_vet:bool}。',
  behavior: '你是猫行为专家。分析这张照片中猫的状态：当前行为/情绪(如炸毛/呼噜/玩耍/焦虑)，简短解读。只输出 JSON：{state:string, mood:string, interpret:string}。',
  med: '你是药剂师。识别这张药/包装照片：OCR 药名、推测剂量与用途、注意事项。只输出 JSON：{name:string, dose:string, use:string, caution:string}。',
  wound: '你是兽医助理。分析这张伤口/肿块照片：位置、大小描述、疑似类型、是否需就医。只输出 JSON：{location:string, size:string, suspicion:string, need_vet:bool, advice:string}。',
  environment: '你是居家安全顾问。分析这张猫生活环境照片：识别隐患(线绳/高空/有毒植物/小物件)，给出建议。只输出 JSON：{hazards:string, advice:string}。',
  body: '你是宠物体态评估师。根据这张猫全身照估算体脂/体态评分(BSC 1-9)与理想体重区间。只输出 JSON：{bsc:int, ideal_weight_kg:string, advice:string}。',
};

async function callLLM(base, model, key, messages, expectJson) {
  if (!key) return { error: '未配置 API Key' };
  const body = { model, messages, temperature: 0.3, max_tokens: 800 };
  if (expectJson) body.response_format = { type: 'json_object' };
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `LLM ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return { content: data.choices?.[0]?.message?.content || '' };
  } catch (e) {
    return { error: `fetch failed: ${e.message}` };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/health') return send(res, 200, {
    ok: true,
    text: { model: TEXT_MODEL, key: TEXT_KEY ? 'loaded' : 'missing' },
    vision: { model: VISION_MODEL, base: VISION_BASE, key: VISION_KEY ? 'loaded' : 'missing' },
  });

  const isChat = p === '/chat' || p === '/api/chat';
  const isVision = p === '/vision' || p === '/api/vision';

  if (isChat && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    if (!TEXT_KEY) return send(res, 502, { error: '未配置 DEEPSEEK_API_KEY（文本助手不可用）' });
    const messages = [
      { role: 'system', content: SAFETY + (body.context ? `\n\n猫档案与近期记录：\n${body.context}` : '') },
      ...(body.messages || [{ role: 'user', content: body.q || '' }]),
    ];
    const out = await callLLM(TEXT_BASE, TEXT_MODEL, TEXT_KEY, messages, false);
    return send(res, out.error ? 502 : 200, out);
  }

  if (isVision && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    if (!VISION_KEY) return send(res, 502, { error: '未配置 VISION_KEY（拍照分析未启用，请在 .env 设 VISION_KEY）' });
    let sys = VISION_PROMPTS[body.type] || VISION_PROMPTS.food;
    sys += '\n额外输出字段 confidence:number(0-1) 表示本次判断的置信度（越高越可靠）。';
    if (body.calib) sys += `\n已知参考信息（用于校准尺寸/分量，请据此修正估算）：${body.calib}`;
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: '请严格按指定 JSON 格式分析，并给出置信度。' },
        { type: 'image_url', image_url: { url: body.image } },
      ] },
    ];
    const out = await callLLM(VISION_BASE, VISION_MODEL, VISION_KEY, messages, true);
    if (out.error) return send(res, 502, out);
    let parsed = {}; try { parsed = JSON.parse(out.content); } catch { parsed = { raw: out.content }; }
    return send(res, 200, { result: parsed });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`喵迹本地 AI 代理已启动: http://localhost:${PORT}`);
  console.log(`文本: ${TEXT_MODEL} (key ${TEXT_KEY ? '已加载' : '缺失'})`);
  console.log(`视觉: ${VISION_MODEL} @ ${VISION_BASE} (key ${VISION_KEY ? '已加载' : '缺失 → 拍照分析未启用'})`);
});
