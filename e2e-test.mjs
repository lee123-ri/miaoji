/**
 * 喵迹 · 全量点击回归测试
 * 用法：node e2e-test.mjs [baseURL]
 * 依赖：playwright（chromium）
 * 目标：把 App 里每一个可点元素真机点一遍，验证不报错、有反馈、数据真落库。
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5173/';
const results = [];
let consoleErrors = [];

function rec(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
/**
 * @param allow 允许出现的控制台错误（预期内，如故意访问无效域名的网络错误）
 */
// 每轮断言开始前调用：关掉上一项遗留的弹层，避免遮挡导致后续点击超时。
let cleanup = async () => {};
async function check(name, fn, allow) {
  const before = consoleErrors.length;
  try {
    await cleanup();
    const detail = await fn();
    const newErr = consoleErrors.slice(before).filter(e => !(allow && allow.test(e)));
    if (newErr.length) rec(name, false, 'JS 报错: ' + newErr[0]);
    else rec(name, true, detail || '');
  } catch (e) {
    rec(name, false, (e.message || String(e)).slice(0, 160));
  }
}

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  // ⚠️ 关键：不设默认超时的话，Playwright 单个 action 会干等 30s。
  // 一旦某几个选择器失配（例如页面结构调整），累加就会让整轮测试看起来"卡死"。
  // 收敛到 6s：失败快速暴露，整轮控制在 1-2 分钟内。
  ctx.setDefaultTimeout(6000);
  ctx.setDefaultNavigationTimeout(15000);
  const page = await ctx.newPage();

  // 素材盒会主动探测 /ingest/health，纯静态服务下必然 404。
  // 这是设计好的"探测失败→隐藏入口"降级路径，属预期行为，不应污染断言。
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location && m.location().url) || '';
    if (/\/ingest\/(health|list|payload|ack|skip)/.test(loc)) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());   // 自动确认 confirm

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

  const S = () => page.evaluate(() => ({
    logs: S.logs.length, rem: S.reminders.length, chats: S.chats.length, cats: S.cats.length,
    cat: S.cat && S.cat.name, url: S.settings.workerUrl, bowl: S.settings.refBowlCm
  }));
  const sheetOpen = () => page.evaluate(() => document.getElementById('sheet').classList.contains('show'));

  // 注入清场逻辑：强制收起所有 .show 弹层与遮罩（比点"关闭"按钮更稳）
  cleanup = async () => {
    try {
      await page.evaluate(() => {
        // 只收 sheet（详情抽屉）。拍照分析 modal 需跨断言保持打开，不能动。
        document.querySelectorAll('.sheet.show').forEach(el => el.classList.remove('show'));
        const modalOpen = !!document.querySelector('.modal.show');
        if (!modalOpen) document.getElementById('mask')?.classList.remove('show');
      });
      await page.waitForTimeout(80);
    } catch { /* 页面可能正在导航，忽略 */ }
  };
  const sheetTitle = () => page.textContent('#shTitle');
  const closeAll = async () => { await page.evaluate(() => { closeSheet(); closeVision(); }); await page.waitForTimeout(120); };
  const toastText = () => page.textContent('#toast');

  /* ---------- 0. 启动 ---------- */
  await check('App 启动无 JS 错误', async () => {
    const s = await S();
    if (s.logs < 10) throw new Error('种子数据未生成');
    return `种子 ${s.logs} 条记录 / ${s.rem} 条提醒 / 猫 ${s.cat}`;
  });

  /* ---------- 1. 底部导航 5 个 ---------- */
  for (const [t, name] of [['home', '首页'], ['tl', '时间线'], ['log', '记一笔'], ['ai', '助手'], ['me', '我的']]) {
    await check(`导航切换 → ${name}`, async () => {
      if (t === 'log') await page.click('.nav .fab'); else await page.click(`.nav .tab[data-t="${t}"]`);
      await page.waitForTimeout(120);
      const vis = await page.isVisible(`#p-${t}`);
      if (!vis) throw new Error('页面未显示');
      const html = await page.innerHTML(`#p-${t}`);
      if (html.trim().length < 50) throw new Error('页面内容为空');
      return `渲染 ${html.length} 字符`;
    });
  }

  /* ---------- 2. 首页 KPI 下钻 ---------- */
  await page.click('.nav .tab[data-t="home"]'); await page.waitForTimeout(150);
  const kpiExpect = ['体重明细', '健康评分构成', null, '今日 / 临期待办'];
  for (let i = 0; i < 4; i++) {
    await check(`首页 KPI 卡 #${i + 1} 可下钻`, async () => {
      await page.locator('#p-home .kpi').nth(i).click();
      await page.waitForTimeout(200);
      if (kpiExpect[i] === null) {                    // 第3张跳时间线
        const vis = await page.isVisible('#p-tl');
        if (!vis) throw new Error('未跳转时间线');
        await page.click('.nav .tab[data-t="home"]'); await page.waitForTimeout(150);
        return '跳转时间线';
      }
      if (!(await sheetOpen())) throw new Error('未弹出详情');
      const t = await sheetTitle();
      await closeAll();
      return '弹出「' + t + '」';
    });
  }

  /* ---------- 3. 成长曲线：范围切换 + 数据点 ---------- */
  for (const label of ['近30天', '近90天', '近365天', '全部']) {
    await check(`曲线范围切换「${label}」`, async () => {
      await page.locator('#p-home .filt span', { hasText: label }).first().click();
      await page.waitForTimeout(150);
      const on = await page.textContent('#p-home .filt span.on');
      if (on.trim() !== label) throw new Error('选中态未切换，当前=' + on);
      return '已切换';
    });
  }
  await check('曲线数据点可点开明细', async () => {
    await page.locator('#p-home .filt span', { hasText: '全部' }).first().click();
    await page.waitForTimeout(150);
    const pts = await page.locator('#p-home svg circle.pt').count();
    if (!pts) throw new Error('无可点数据点');
    await page.locator('#p-home svg circle.pt').nth(2).click({ force: true });
    await page.waitForTimeout(200);
    if (!(await sheetOpen())) throw new Error('点击数据点无反应');
    const t = await sheetTitle(); await closeAll();
    return `${pts} 个点，弹出「${t}」`;
  });

  /* ---------- 4. 提醒 CRUD ---------- */
  await check('提醒 · 新增', async () => {
    const b = (await S()).rem;
    await page.locator('#p-home .card h2 .act', { hasText: '新增' }).click();
    await page.waitForTimeout(200);
    await page.locator('#nrTpl .chip', { hasText: '剪指甲' }).click();
    await page.locator('#shActions button', { hasText: '保存提醒' }).click();
    await page.waitForTimeout(300);
    const a = (await S()).rem;
    if (a !== b + 1) throw new Error(`提醒数未增加 ${b}→${a}`);
    return `${b} → ${a} 条`;
  });
  await check('提醒 · 打开详情', async () => {
    await page.locator('#p-home .rrow').first().click();
    await page.waitForTimeout(200);
    if (!(await sheetOpen())) throw new Error('详情未弹出');
    const n = await page.locator('#shActions button').count();
    if (n < 5) throw new Error('操作按钮不全，仅 ' + n + ' 个');
    return `${n} 个操作`;
  });
  await check('提醒 · 标记完成（重置周期）', async () => {
    await page.locator('#shActions button', { hasText: '标记已完成' }).click();
    await page.waitForTimeout(350);
    const t = await toastText();
    if (!t.includes('已完成')) throw new Error('无完成反馈：' + t);
    return t;
  });
  await check('提醒 · 顺延 7 天', async () => {
    await page.locator('#p-home .rrow').first().click(); await page.waitForTimeout(200);
    await page.locator('#shActions button', { hasText: '顺延' }).click();
    await page.waitForTimeout(350);
    const t = await toastText();
    if (!t.includes('顺延')) throw new Error('无顺延反馈：' + t);
    return t;
  });
  await check('提醒 · 编辑保存', async () => {
    await page.locator('#p-home .rrow').first().click(); await page.waitForTimeout(200);
    await page.fill('#rmCycle', '45');
    await page.locator('#shActions button', { hasText: '保存修改' }).click();
    await page.waitForTimeout(350);
    const ok = await page.evaluate(() => S.reminders.some(r => r.cycle === 45));
    if (!ok) throw new Error('周期未写入');
    return '周期改为 45 天已落库';
  });
  await check('提醒 · 删除', async () => {
    const b = (await S()).rem;
    await page.locator('#p-home .rrow').first().click(); await page.waitForTimeout(200);
    await page.locator('#shActions button', { hasText: '删除提醒' }).click();
    await page.waitForTimeout(400);
    const a = (await S()).rem;
    if (a !== b - 1) throw new Error(`未删除 ${b}→${a}`);
    return `${b} → ${a} 条`;
  });

  /* ---------- 5. 记一笔：24 个维度全部可打开 ---------- */
  await page.click('.nav .fab'); await page.waitForTimeout(200);
  const itemCount = await page.locator('#p-log .logitem').count();
  await check('记一笔 · 24 个维度入口齐全', async () => {
    if (itemCount !== 24) throw new Error('维度数量 ' + itemCount);
    return '24 个';
  });
  let openFail = [];
  for (let i = 0; i < itemCount; i++) {
    const nm = await page.locator('#p-log .logitem .nm').nth(i).textContent();
    await page.locator('#p-log .logitem').nth(i).click();
    await page.waitForTimeout(110);
    const ok = await sheetOpen();
    const fields = await page.locator('#shFields .field').count();
    if (!ok || fields < 3) openFail.push(`${nm}(${ok ? '字段' + fields : '未打开'})`);
    await closeAll();
  }
  await check('记一笔 · 每个维度都能打开且有专用字段', async () => {
    if (openFail.length) throw new Error('异常：' + openFail.join(', '));
    return '24/24 均打开，字段≥3';
  });

  /* ---------- 6. 记录 CRUD 闭环 ---------- */
  await check('记录 · 新增体重（数据真落库）', async () => {
    const b = (await S()).logs;
    await page.locator('#p-log .logitem', { hasText: '体重' }).first().click();
    await page.waitForTimeout(200);
    await page.fill('#shFields input[data-k="value"]', '4.25');
    await page.locator('#shFields .chips[data-k="method"] .chip', { hasText: '宠物秤' }).click();
    await page.fill('#logRemark', 'E2E 测试');
    await page.locator('#shActions button', { hasText: '保存记录' }).click();
    await page.waitForTimeout(400);
    const s = await S();
    if (s.logs !== b + 1) throw new Error(`记录数未增加 ${b}→${s.logs}`);
    const saved = await page.evaluate(() => S.logs.some(l => l.data && String(l.data.value) === '4.25' && l.remark === 'E2E 测试'));
    if (!saved) throw new Error('字段未正确写入');
    return `${b} → ${s.logs} 条，字段校验通过`;
  });
  await check('记录 · 时间可修改（此前写着"可改"但改不了）', async () => {
    await page.click('.nav .fab'); await page.waitForTimeout(150);
    await page.locator('#p-log .logitem', { hasText: '喂食' }).first().click();
    await page.waitForTimeout(200);
    await page.fill('#logTs', '2026-08-01T08:30');
    await page.fill('#shFields input[data-k="value"]', '50');
    await page.locator('#shActions button', { hasText: '保存记录' }).click();
    await page.waitForTimeout(400);
    const ok = await page.evaluate(() => S.logs.some(l => l.type === '喂食' && new Date(l.ts).getDate() === 1 && new Date(l.ts).getHours() === 8));
    if (!ok) throw new Error('自定义时间未生效');
    return '时间写入 8-1 08:30';
  });
  await check('记录 · 异常状态触发红色预警', async () => {
    await page.click('.nav .fab'); await page.waitForTimeout(150);
    await page.locator('#p-log .logitem', { hasText: '呕吐' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('#stChips .chip', { hasText: '异常' }).click();
    await page.fill('#shFields input[data-k="count"]', '3');
    await page.locator('#shActions button', { hasText: '保存记录' }).click();
    await page.waitForTimeout(1600);
    const t = await toastText();
    if (!t.includes('预警')) throw new Error('未触发预警提示，toast=' + t);
    return t;
  });
  await check('记录 · 时间线里可编辑', async () => {
    await page.click('.nav .tab[data-t="tl"]'); await page.waitForTimeout(200);
    await page.locator('#p-tl .tl li').first().click(); await page.waitForTimeout(220);
    if (!(await sheetOpen())) throw new Error('详情未弹出');
    await page.locator('#shActions button', { hasText: '编辑' }).click();
    await page.waitForTimeout(450);
    await page.fill('#logRemark', '已复核');
    await page.locator('#shActions button', { hasText: '保存修改' }).click();
    await page.waitForTimeout(400);
    const ok = await page.evaluate(() => S.logs.some(l => l.remark === '已复核'));
    if (!ok) throw new Error('编辑未落库');
    return '编辑已保存';
  });
  await check('记录 · 可删除', async () => {
    const b = (await S()).logs;
    await page.locator('#p-tl .tl li').first().click(); await page.waitForTimeout(220);
    await page.locator('#shActions button', { hasText: '删除' }).click();
    await page.waitForTimeout(450);
    const a = (await S()).logs;
    if (a !== b - 1) throw new Error(`未删除 ${b}→${a}`);
    return `${b} → ${a} 条`;
  });

  await check('记录 · 表单内「拍照 AI 分析」入口可跳转', async () => {
    await page.click('.nav .fab'); await page.waitForTimeout(150);
    await page.locator('#p-log .logitem', { hasText: '梳毛美容' }).first().click();
    await page.waitForTimeout(220);
    await page.locator('#shFields .chip', { hasText: '拍照 AI 分析' }).click();
    await page.waitForTimeout(300);
    const vis = await page.evaluate(() => document.getElementById('visionModal').classList.contains('show'));
    if (!vis) throw new Error('未打开分析弹层');
    const on = await page.textContent('#vrow .chip.on');
    if (!on.includes('皮肤')) throw new Error('未按维度预选类型，当前=' + on);
    await closeAll();
    return '自动预选「' + on.trim() + '」';
  });

  /* ---------- 7. 时间线筛选 ---------- */
  await page.click('.nav .tab[data-t="tl"]'); await page.waitForTimeout(250);
  await check('时间线 · 类型筛选可用', async () => {
    const n = await page.locator('#p-tl .filt span').count();
    if (n < 3) throw new Error('筛选项过少');
    await page.locator('#p-tl .filt span', { hasText: '⚠️异常' }).click();
    await page.waitForTimeout(220);
    const on = await page.textContent('#p-tl .filt span.on');
    if (!on.includes('异常')) throw new Error('筛选未选中');
    await page.locator('#p-tl .filt span', { hasText: '全部' }).first().click();
    await page.waitForTimeout(180);
    return `${n} 个筛选项，异常筛选正常`;
  });

  /* ---------- 8. 助手 ---------- */
  await page.click('.nav .tab[data-t="ai"]'); await page.waitForTimeout(220);
  await check('助手 · 输入框发送（此前完全没有输入框）', async () => {
    const b = (await S()).chats;
    await page.fill('#chatIn', '幼猫喂多少合适');
    await page.press('#chatIn', 'Enter');
    await page.waitForTimeout(450);
    const a = (await S()).chats;
    if (a < b + 2) throw new Error(`未产生问答 ${b}→${a}`);
    const last = await page.evaluate(() => S.chats[S.chats.length - 1].text);
    return `问答落库 ${b}→${a}，回答 ${last.slice(0, 22)}…`;
  });
  await check('助手 · 快捷问题可点', async () => {
    const b = (await S()).chats;
    await page.locator('#p-ai .quick span', { hasText: '多久驱虫一次' }).first().click();
    await page.waitForTimeout(400);
    const a = (await S()).chats;
    if (a < b + 2) throw new Error('快捷问题无响应');
    return '已回答';
  });
  await check('助手 · 结合本地记录回答（体重）', async () => {
    await page.locator('#p-ai .quick span', { hasText: '最近体重' }).click();
    await page.waitForTimeout(400);
    const last = await page.evaluate(() => S.chats[S.chats.length - 1].text);
    if (!/kg/.test(last)) throw new Error('未引用记录：' + last.slice(0, 40));
    return last.slice(0, 40) + '…';
  });
  await check('助手 · 对话持久化（切页不丢）', async () => {
    const n = (await S()).chats;
    await page.click('.nav .tab[data-t="home"]'); await page.waitForTimeout(150);
    await page.click('.nav .tab[data-t="ai"]'); await page.waitForTimeout(250);
    const bubbles = await page.locator('#chatBox .bubble').count();
    if (bubbles !== n) throw new Error(`气泡 ${bubbles} ≠ 落库 ${n}`);
    return `${bubbles} 条对话保留`;
  });
  await check('助手 · 红色预警规则可展开', async () => {
    await page.click('#p-ai .banner'); await page.waitForTimeout(220);
    if (!(await sheetOpen())) throw new Error('未弹出');
    const n = await page.locator('#shFields .field').count();
    await closeAll();
    if (n < 9) throw new Error('规则条数 ' + n);
    return n + ' 条规则';
  });
  await check('助手 · 知识库可展开正文', async () => {
    await page.click('#p-ai .guide'); await page.waitForTimeout(220);
    const items = await page.locator('.kbitem').count();
    await page.locator('.kbitem').nth(1).click(); await page.waitForTimeout(180);
    const shown = await page.isVisible('#kb1');
    await closeAll();
    if (!shown) throw new Error('正文未展开');
    return `${items} 篇，可展开`;
  });
  await check('助手 · 清空对话', async () => {
    await page.click('.nav .tab[data-t="ai"]'); await page.waitForTimeout(200);
    await page.locator('#p-ai .card h2 .act', { hasText: '清空对话' }).click();
    await page.waitForTimeout(450);
    const a = (await S()).chats;
    if (a !== 0) throw new Error('未清空，剩 ' + a);
    return '已清空';
  });

  /* ---------- 9. 拍照分析 ---------- */
  await page.click('.nav .fab'); await page.waitForTimeout(200);
  await check('拍照分析 · 入口可打开', async () => {
    await page.click('#p-log .camcard'); await page.waitForTimeout(250);
    const vis = await page.evaluate(() => document.getElementById('visionModal').classList.contains('show'));
    if (!vis) throw new Error('未打开');
    return '已打开';
  });
  await check('拍照分析 · 8 种类型均可切换', async () => {
    const n = await page.locator('#vrow .chip').count();
    if (n !== 8) throw new Error('类型数 ' + n);
    for (let i = 0; i < 8; i++) {
      await page.locator('#vrow .chip').nth(i).click(); await page.waitForTimeout(60);
      const on = await page.locator('#vrow .chip.on').count();
      if (on !== 1) throw new Error('选中态异常，同时选中 ' + on);
    }
    return '8/8 切换正常';
  });
  await check('拍照分析 · 食物类型显示校准输入框', async () => {
    await page.locator('#vrow .chip', { hasText: '食物' }).click(); await page.waitForTimeout(120);
    const vis = await page.isVisible('#calibField');
    if (!vis) throw new Error('校准框未出现');
    await page.locator('#vrow .chip', { hasText: '行为' }).click(); await page.waitForTimeout(120);
    const hid = await page.isVisible('#calibField');
    if (hid) throw new Error('非食物类型仍显示校准框');
    return '按类型正确显隐';
  });
  await check('拍照分析 · 上传图片→出结果→复核→存记录', async () => {
    await page.locator('#vrow .chip', { hasText: '食物' }).click(); await page.waitForTimeout(120);
    await page.fill('#calibInput', '12');
    // 生成一张测试图片
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoU2NkYGD4z0AEYBxVSFCFAyMDA8N/ANJvBAWm5aMoAAAAAElFTkSuQmCC', 'base64');
    await page.setInputFiles('#vfile', { name: 'food.png', mimeType: 'image/png', buffer: png });
    await page.waitForTimeout(900);
    const resVis = await page.isVisible('#vres');
    if (!resVis) throw new Error('无分析结果');
    const conf = await page.locator('#vres .conf').count();
    if (!conf) throw new Error('未显示置信度');
    const vqVis = await page.isVisible('#vQ');
    if (!vqVis) throw new Error('未出现复核追问');
    await page.locator('#vQ .chip', { hasText: '适中' }).click(); await page.waitForTimeout(100);
    const b = (await S()).logs;
    await page.click('#vSave'); await page.waitForTimeout(500);
    const s = await S();
    if (s.logs !== b + 1) throw new Error('未存为记录');
    const ok = await page.evaluate(() => S.logs.some(l => l.note.includes('📷AI') && l.note.includes('复核')));
    if (!ok) throw new Error('复核结论未写入记录');
    return `置信度+复核问+落库 ${b}→${s.logs}`;
  });

  /* ---------- 10. 我的 / 设置 / 多猫 ---------- */
  await page.click('.nav .tab[data-t="me"]'); await page.waitForTimeout(220);
  await check('我的 · 设置保存', async () => {
    await page.fill('#wUrl', 'https://demo-proxy.invalid');
    await page.fill('#bowl', '14');
    await page.locator('#aOn .chip', { hasText: '关闭' }).click();
    await page.click('#p-me button:has-text("保存设置")');
    await page.waitForTimeout(400);
    const s = await S();
    if (s.bowl !== 14 || s.url !== 'https://demo-proxy.invalid') throw new Error('设置未落库');
    const off = await page.evaluate(() => S.settings.assistantOn === false);
    if (!off) throw new Error('助手记忆开关未生效');
    return '代理URL/碗直径/记忆开关 均落库';
  });
  // 故意填无效域名：验证 App 能捕获网络异常并给出反馈（浏览器自身的 ERR_NAME_NOT_RESOLVED 属预期）
  await check('我的 · 代理连通性测试有反馈（异常可捕获）', async () => {
    await page.click('#p-me button:has-text("测试 AI 代理")');
    await page.waitForTimeout(2500);
    const t = await toastText();
    if (!t || !/连接失败|连通|响应/.test(t)) throw new Error('无反馈：' + t);
    return t.slice(0, 40);
  }, /ERR_NAME_NOT_RESOLVED|Failed to load resource|net::/);
  await check('我的 · 清空代理回到离线模式', async () => {
    await page.fill('#wUrl', '');
    await page.click('#p-me button:has-text("保存设置")');
    await page.waitForTimeout(400);
    await page.click('.nav .tab[data-t="ai"]'); await page.waitForTimeout(250);
    // 助手页现在有多张卡（养护面板在前），必须精确定位「专业助手」那张
    const tag = await page.textContent('#p-ai .card h2:has-text("专业助手") .tag');
    if (!tag.includes('离线')) throw new Error('状态标签未回退：' + tag);
    await page.click('.nav .tab[data-t="me"]'); await page.waitForTimeout(200);
    return '标签=' + tag;
  });
  await check('我的 · 档案卡可编辑并保存', async () => {
    await page.click('#p-me .prof'); await page.waitForTimeout(250);
    await page.fill('#cfName', '咪咪Pro');
    await page.locator('#cfNeu .chip', { hasText: '已绝育' }).click();
    await page.locator('#shActions button', { hasText: '保存' }).first().click();
    await page.waitForTimeout(400);
    const nm = (await S()).cat;
    if (nm !== '咪咪Pro') throw new Error('档案未更新：' + nm);
    const top = await page.textContent('#catName');
    if (!top.includes('咪咪Pro')) throw new Error('顶部未同步');
    return '名称+绝育状态已更新，顶栏同步';
  });
  await check('我的 · 添加第二只猫（此前是死链）', async () => {
    const b = (await S()).cats;
    await page.locator('#p-me .menu li', { hasText: '添加一只猫' }).click();
    await page.waitForTimeout(250);
    await page.fill('#cfName', '二毛');
    await page.fill('#cfBreed', '狸花');
    await page.fill('#cfW', '4.6');
    await page.locator('#shActions button', { hasText: '创建档案' }).click();
    await page.waitForTimeout(500);
    const s = await S();
    if (s.cats !== b + 1) throw new Error('未创建');
    if (s.cat !== '二毛') throw new Error('未自动切换');
    if (s.logs === 0) throw new Error('未生成初始体重记录');
    return `猫 ${b}→${s.cats}，已切换到二毛，数据独立(${s.logs} 条)`;
  });
  await check('多猫 · 顶部可切换且数据隔离', async () => {
    await page.click('#catName'); await page.waitForTimeout(250);
    const rows = await page.locator('#sheet .rrow').count();
    if (rows < 2) throw new Error('猫列表不全');
    await page.locator('#sheet .rrow', { hasText: '咪咪Pro' }).click();
    await page.waitForTimeout(450);
    const s = await S();
    if (s.cat !== '咪咪Pro') throw new Error('未切回');
    if (s.logs < 10) throw new Error('切回后记录丢失');
    return `切回咪咪Pro，记录 ${s.logs} 条（二毛数据不混）`;
  });
  await check('我的 · 数据统计可打开', async () => {
    await page.click('.nav .tab[data-t="me"]'); await page.waitForTimeout(200);
    await page.locator('#p-me .menu li', { hasText: '数据统计' }).click();
    await page.waitForTimeout(250);
    if (!(await sheetOpen())) throw new Error('未打开');
    const t = await sheetTitle(); await closeAll();
    return t;
  });
  await check('我的 · 知识库入口可打开', async () => {
    await page.locator('#p-me .menu li', { hasText: '知识库' }).click(); await page.waitForTimeout(250);
    const n = await page.locator('.kbitem').count(); await closeAll();
    if (n < 8) throw new Error('文章数 ' + n);
    return n + ' 篇';
  });
  await check('我的 · 预警规则入口可打开', async () => {
    await page.locator('#p-me .menu li', { hasText: '预警规则' }).click(); await page.waitForTimeout(250);
    const ok = await sheetOpen(); await closeAll();
    if (!ok) throw new Error('未打开');
    return 'ok';
  });
  await check('我的 · 隐私说明可打开', async () => {
    await page.locator('#p-me .menu li', { hasText: '隐私' }).click(); await page.waitForTimeout(250);
    const ok = await sheetOpen(); const t = await sheetTitle(); await closeAll();
    if (!ok) throw new Error('未打开');
    return t;
  });
  let backupPath = '';
  await check('我的 · 导出 JSON 真的下载文件', async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.locator('#p-me .menu li', { hasText: '导出' }).click()
    ]);
    const fn = dl.suggestedFilename();
    if (!fn.endsWith('.json')) throw new Error('文件名异常 ' + fn);
    backupPath = './' + fn;
    await dl.saveAs(backupPath);
    return fn;
  });
  await check('我的 · 导入备份 JSON 可恢复数据', async () => {
    if (!backupPath) throw new Error('无备份文件');
    // 先删一条记录，再导入备份，验证能恢复
    const before = (await S()).logs;
    await page.evaluate(async () => { const l = S.logs[0]; await idbDel('logs', l.id); await load(); refreshAll(); });
    await page.waitForTimeout(300);
    const after = (await S()).logs;
    if (after !== before - 1) throw new Error('前置删除失败');
    const fc = page.waitForEvent('filechooser', { timeout: 5000 });
    await page.locator('#p-me .menu li', { hasText: '导入备份' }).click();
    (await fc).setFiles(backupPath);
    await page.waitForTimeout(1200);
    const restored = (await S()).logs;
    if (restored !== before) throw new Error(`恢复失败 ${after}→${restored}，期望 ${before}`);
    return `删 1 条后导入恢复：${after} → ${restored}`;
  });
  await check('我的 · 清空并重置为演示数据', async () => {
    await page.locator('#p-me .menu li', { hasText: '清空本地数据' }).click();
    await page.waitForTimeout(900);
    const s = await S();
    if (s.cats !== 1 || s.logs < 10) throw new Error(`重置异常 猫${s.cats} 记录${s.logs}`);
    return `重置为 1 只猫 / ${s.logs} 条种子记录`;
  });

  /* ---------- 11. 刷新后数据持久化 ---------- */
  await check('刷新页面后数据仍在（IndexedDB 持久化）', async () => {
    await page.click('.nav .fab'); await page.waitForTimeout(150);
    await page.locator('#p-log .logitem', { hasText: '饮水' }).first().click(); await page.waitForTimeout(200);
    await page.fill('#shFields input[data-k="value"]', '135');
    await page.locator('#shActions button', { hasText: '保存记录' }).click();
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    const ok = await page.evaluate(() => S.logs.some(l => l.type === '饮水' && String(l.data.value) === '135'));
    if (!ok) throw new Error('刷新后记录丢失');
    return '记录跨刷新保留';
  });

  /* ---------- 12. 遮罩关闭 ---------- */
  await check('点遮罩可关闭弹层', async () => {
    await page.click('.nav .tab[data-t="home"]'); await page.waitForTimeout(200);
    await page.locator('#p-home .kpi').first().click(); await page.waitForTimeout(220);
    await page.click('#mask', { position: { x: 200, y: 60 } });
    await page.waitForTimeout(300);
    if (await sheetOpen()) throw new Error('遮罩未关闭弹层');
    return 'ok';
  });

  /* ---------- 汇总 ---------- */
  await page.screenshot({ path: 'screenshot-home.png' });
  await page.click('.nav .fab'); await page.waitForTimeout(200);
  await page.screenshot({ path: 'screenshot-log.png' });
  await page.click('.nav .tab[data-t="ai"]'); await page.waitForTimeout(250);
  await page.screenshot({ path: 'screenshot-ai.png' });

  await browser.close();

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n══════════════════════════════');
  console.log(`总计 ${results.length} 项 · 通过 ${pass} · 失败 ${fail}`);
  if (consoleErrors.length) {
    console.log('\n控制台错误：');
    [...new Set(consoleErrors)].forEach(e => console.log('  · ' + e.slice(0, 200)));
  } else console.log('全程无 JS 控制台错误 ✅');
  if (fail) { console.log('\n失败项：'); results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name + ' — ' + r.detail)); process.exitCode = 1; }
};

/**
 * 全局看门狗：整轮测试最多跑 WATCHDOG_MS。
 * 超时立即打印已完成的结果并退出，避免 CI / 终端里"无限卡住不知道死在哪"。
 */
const WATCHDOG_MS = Number(process.env.E2E_WATCHDOG_MS || 8 * 60 * 1000);
const watchdog = setTimeout(() => {
  console.error(`\n⏱️ 看门狗触发：整轮超过 ${Math.round(WATCHDOG_MS / 1000)}s 未结束，强制中止。`);
  console.error(`已完成 ${results.length} 项，最后一项：${results.at(-1)?.name || '(无)'}`);
  console.error('→ 卡点通常在这一项的下一项，优先检查该处选择器是否失配。');
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

run()
  .catch(e => { console.error('测试崩溃：', e); process.exitCode = 2; })
  .finally(() => clearTimeout(watchdog));
