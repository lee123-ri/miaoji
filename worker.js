// 喵迹 · AI 代理（DeepSeek）— 可部署于 Cloudflare Worker / 腾讯云函数 SCF / 阿里云函数计算 FC
// 密钥仅存运行环境的环境变量（如 wrangler secret / 云函数环境变量），前端永不持有
// 前端在「我的→设置」填入代理 URL（国内部署时直连 DeepSeek，无跨境）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// 各视觉场景的系统提示词
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

const SAFETY = '你是专业养猫顾问，语气温和易懂。仅基于提供的信息给建议，紧急情况必须建议尽快就医，不替代执业兽医诊断。回答尽量简洁，关键结论加粗。';

async function callDeepSeek(env, messages, expectJson = false) {
  const body = {
    model: 'deepseek-chat',
    messages,
    temperature: 0.3,
    max_tokens: 800,
  };
  if (expectJson) body.response_format = { type: 'json_object' };
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: `DeepSeek ${r.status}: ${await r.text()}` };
  const data = await r.json();
  return { content: data.choices?.[0]?.message?.content || '' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.DEEPSEEK_API_KEY) return json({ error: 'Worker 未配置 DEEPSEEK_API_KEY' }, 500);

    if (url.pathname === '/chat' && request.method === 'POST') {
      let p; try { p = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const messages = [
        { role: 'system', content: SAFETY + (p.context ? `\n\n猫档案与近期记录：\n${p.context}` : '') },
        ...(p.messages || [{ role: 'user', content: p.q || '' }]),
      ];
      const res = await callDeepSeek(env, messages, false);
      return json(res);
    }

    if (url.pathname === '/vision' && request.method === 'POST') {
      let p; try { p = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      let sys = VISION_PROMPTS[p.type] || VISION_PROMPTS.food;
      sys += '\n额外输出字段 confidence:number(0-1) 表示本次判断的置信度（越高越可靠）。';
      if (p.calib) sys += `\n已知参考信息（用于校准尺寸/分量，请据此修正估算）：${p.calib}`;
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'text', text: '请严格按指定 JSON 格式分析，并给出置信度。' },
          { type: 'image_url', image_url: { url: p.image } },
        ] },
      ];
      const res = await callDeepSeek(env, messages, true);
      if (res.error) return json(res, 502);
      let parsed = {};
      try { parsed = JSON.parse(res.content); } catch { parsed = { raw: res.content }; }
      return json({ result: parsed });
    }

    return json({ error: 'not found' }, 404);
  },
};
