#!/usr/bin/env python3
"""
把 index.html 同步到 dist/index.html，并重新打上部署版专属补丁。
每次改完主文件执行一次：python3 sync-dist.py
补丁内容：
  1) PWA head（manifest / apple-touch-icon / description）
  2) 同源 AI 代理自动探测（部署到 Pages 后无需手填代理 URL）
  3) Service Worker 注册
"""
import re
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "index.html"
DST = HERE / "dist" / "index.html"

src = SRC.read_text(encoding="utf-8")

# ---- 补丁 1：PWA head ----
anchor = '<meta name="theme-color" content="#e8915b" />'
head_patch = (
    anchor
    + '\n<meta name="description" content="喵迹 — 猫成长记录与 AI 养护助手" />'
    + '\n<link rel="manifest" href="/manifest.json" />'
    + '\n<link rel="apple-touch-icon" href="/apple-touch-icon.png" />'
)
if anchor not in src:
    sys.exit("✗ 未找到 head 锚点，补丁 1 失败")
src = src.replace(anchor, head_patch, 1)

# ---- 补丁 2：load() 中调用同源探测 ----
m = re.search(r"(const st=await idbAll\('settings'\);[^\n]*\n)", src)
if not m:
    sys.exit("✗ 未找到 load() 锚点，补丁 2 失败")
src = src.replace(m.group(1), m.group(1) + "  await detectSameOriginAPI();\n", 1)

# ---- 补丁 3：同源探测函数 + SW 注册 ----
mask_line = [ln for ln in src.split("\n") if ln.startswith("$('mask').onclick=")]
if not mask_line:
    sys.exit("✗ 未找到 mask 锚点，补丁 3 失败")
mask_line = mask_line[0]
tail_patch = mask_line + """

/* ================= 同域 AI 代理自动探测 ================= */
async function detectSameOriginAPI(){
  if(S.settings.workerUrl) return;                 // 用户已手动配置，尊重用户选择
  try{
    const r=await fetch('/api/health',{method:'GET',signal:AbortSignal.timeout(2500)});
    if(r.ok){ S.settings.workerUrl='/api'; await idbPut('settings',S.settings); }
  }catch(e){/* 同域无 API，保持离线模式 */}
}

/* ================= Service Worker 注册 ================= */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').catch(()=>{});
}"""
src = src.replace(mask_line, tail_patch, 1)

DST.parent.mkdir(parents=True, exist_ok=True)
DST.write_text(src, encoding="utf-8")
print(f"✓ 已同步 → {DST}  ({len(src)} 字符，3 个部署补丁已应用)")
