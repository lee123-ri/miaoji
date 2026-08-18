# 喵迹云端版 · 部署手册（阿里云 ECS）

适用：阿里云 ECS，Alibaba Cloud Linux 3，2 核 2G（其他 RHEL9 系类似）。
架构：单文件 PWA 前端 + Express 后端（:3000）+ 本地 AI 代理（:8787，DeepSeek 文本 + 通义千问视觉），统一由 nginx 反代，对外只暴露 80/443。

```
浏览器 ──(80/443)──▶ nginx ──/api/*──▶ miaoji-server :3000
                           └──/chat /vision──▶ miaoji-ai :8787
```

## 一、控制台准备（一次性）
1. 实例已购，记录**公网 IP**（如 39.96.218.181）。
2. **安全组**放通入方向：22(SSH)、80、443。
3. （可选，生产推荐）买一个域名，A 记录指向公网 IP；手机拍照分析需 HTTPS，纯 IP+HTTP 下摄像头不可用。

## 二、填密钥（本地仓库）
```bash
cd 喵迹-app
cp deploy/deploy.env.example deploy/deploy.env      # 编辑填入 DEEPSEEK_API_KEY / VISION_KEY
# 若要 HTTPS：在 deploy/deploy.env 设 SITE_DOMAIN=miaoji.你的域名
```
> deploy/deploy.env 含密钥，已被 .gitignore 忽略，不会入库。

## 三、推代码（走分支工作流）
```bash
git add -A && git commit -m "feat(deploy): ECS 一键部署" && git push
# 开 PR → 合并到 main（与历史 Stage 一致）
```

## 四、SSH 上 ECS 一键部署
```bash
sudo -i
git clone https://github.com/lee123-ri/miaoji /opt/miaoji
cd /opt/miaoji
# 把本地的 deploy/deploy.env 拷到服务器 /opt/miaoji/deploy/deploy.env（或用 scp）
bash deploy/deploy.sh
```
脚本会：装 nginx/Node20 → 拉代码 → 装后端依赖 → 写 .env → 拷贝前端 → 配 nginx+防火墙 → 起两个 systemd 服务，并做健康检查。

## 五、验证
- 打开 `http://<公网IP>/`，应出现登录/注册页。
- 注册账号 → 创建家庭组 → 添加一只猫 → 记一条体重 → 在「专业助手」里对话（DeepSeek）→ 拍照分析（通义视觉）。
- 用另一台设备/浏览器登录同一账号（或同一家庭的邀请码），数据应同步。
- `journalctl -u miaoji-server -u miaoji-ai -f` 看日志。

## 六、日常运维
- **更新代码**：`cd /opt/miaoji && git pull && bash deploy/deploy.sh`（幂等，不丢数据，DB 在 server/data/miaoji.db）。
- **重启服务**：`systemctl restart miaoji-server miaoji-ai`。
- **清库重来**：停服后删 `server/data/miaoji.db` 再启动（会重建空库）。
- **重置浏览器本地数据**：App 内「我的 → 设置 → 重置」（清 IndexedDB 本地缓存/演示数据）。
- **HTTPS 证书续期**：certbot 默认装了定时器；手动 `certbot renew`。

## 七、已知边界
- `ingest-server.mjs`（本地素材抓取，:7788）是**桌面端辅助**，不上云；云端忽略 `/ingest/*` 即可。
- 云端版不做演示数据 seeding，新账号即为空。
- 2 核 2G 足够本地推理转发；若并发高再升配。
