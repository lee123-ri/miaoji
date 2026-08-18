#!/usr/bin/env bash
# 喵迹云端版 · 阿里云 ECS 一键部署脚本（Alibaba Cloud Linux 3 / RHEL9 系，2核2G 验证）
#
# 在 ECS 上以 root 执行：
#   git clone https://github.com/lee123-ri/miaoji /opt/miaoji
#   cd /opt/miaoji && cp deploy/deploy.env.example deploy/deploy.env   # 填好密钥
#   bash deploy/deploy.sh
#
# 脚本幂等：重复运行会拉最新代码、重写配置、重启服务，不会破坏数据（DB 在 server/data/）。
set -euo pipefail

APP_DIR=/opt/miaoji
WWW_DIR=/var/www/miaoji
APP_USER=miaoji
BRANCH=main
ENVFILE="$(cd "$(dirname "$0")" && pwd)/deploy.env"

echo "==> [1/8] 检查运行环境与密钥"
if [ "$(id -u)" -ne 0 ]; then echo "请使用 root 运行（sudo -i 后执行）"; exit 1; fi
if [ ! -f "$ENVFILE" ]; then
  echo "未找到 $ENVFILE"
  echo "请先：cp deploy/deploy.env.example deploy/deploy.env 并填写 DEEPSEEK_API_KEY / VISION_KEY"
  exit 1
fi
set -a; source "$ENVFILE"; set +a
: "${DEEPSEEK_API_KEY:?请在 deploy.env 填写 DEEPSEEK_API_KEY}"
: "${VISION_KEY:?请在 deploy.env 填写 VISION_KEY}"

echo "==> [2/8] 安装依赖（nginx / Node20 / 编译工具）"
command -v dnf >/dev/null 2>&1 || { echo "本脚本面向 Alibaba Cloud Linux 3（dnf）"; exit 1; }
dnf install -y nginx git gcc-c++ make python3 >/dev/null
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo "    安装 Node.js 20 LTS (NodeSource)…"
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
  dnf install -y nodejs >/dev/null
fi
node -v; npm -v

echo "==> [3/8] 拉取代码"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 --branch "$BRANCH" https://github.com/lee123-ri/miaoji "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi

echo "==> [4/8] 创建运行用户并写入环境变量"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/server/data"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
cat > "$APP_DIR/server/.env" <<EOF
PORT=3000
JWT_SECRET=$JWT_SECRET
DB_PATH=${DB_PATH:-./data/miaoji.db}
EOF
cat > "$APP_DIR/.env" <<EOF
PORT=8787
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
DEEPSEEK_MODEL=${DEEPSEEK_MODEL:-deepseek-chat}
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}
VISION_KEY=$VISION_KEY
VISION_MODEL=${VISION_MODEL:-qwen3.7-plus}
VISION_BASE_URL=${VISION_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}
EOF
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/server/.env" "$APP_DIR/.env"

echo "==> [5/8] 安装后端依赖"
( cd "$APP_DIR/server" && npm install --omit=dev >/dev/null )

echo "==> [6/8] 部署前端静态文件"
mkdir -p "$WWW_DIR"
cp "$APP_DIR/index.html" "$WWW_DIR/index.html"
chown -R "$APP_USER:$APP_USER" "$WWW_DIR"

echo "==> [7/8] 配置 nginx + 防火墙"
if [ -n "${SITE_DOMAIN:-}" ]; then
  # 先起 HTTP（仅做 ACME 校验 + 跳转），拿到证书后再切 HTTPS
  cat > /etc/nginx/conf.d/miaoji.conf <<EOF
server {
    listen 80;
    server_name $SITE_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
  mkdir -p /var/www/certbot
  nginx -t && systemctl enable --now nginx
  echo "    检测到 SITE_DOMAIN，使用 certbot 申请证书…"
  dnf install -y certbot python3-certbot-nginx >/dev/null
  certbot certonly --nginx -d "$SITE_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || true
  cat > /etc/nginx/conf.d/miaoji.conf <<EOF
server {
    listen 443 ssl;
    server_name $SITE_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$SITE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$SITE_DOMAIN/privkey.pem;
    root $WWW_DIR; index index.html;
    location = /index.html { add_header Cache-Control "no-cache"; }
    location / { try_files \$uri \$uri/ /index.html; }
    location /api/ { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }
    location = /chat       { proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location = /vision     { proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location = /api/chat   { proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location = /api/vision { proxy_pass http://127.0.0.1:8787; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
}
server {
    listen 80;
    server_name $SITE_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
  nginx -t && systemctl reload nginx
else
  cp "$APP_DIR/deploy/nginx-miaoji.conf" /etc/nginx/conf.d/miaoji.conf
  nginx -t && systemctl enable --now nginx
fi
# 防火墙（控制台「安全组」仍需手动放通 80/443 入方向）
systemctl enable --now firewalld 2>/dev/null || true
firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
firewall-cmd --reload >/dev/null 2>&1 || true

echo "==> [8/8] 注册并启动 systemd 服务"
cp "$APP_DIR/deploy/miaoji-server.service" /etc/systemd/system/
cp "$APP_DIR/deploy/miaoji-ai.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now miaoji-server miaoji-ai

sleep 2
echo "==> 健康检查"
curl -fsS http://127.0.0.1:3000/health >/dev/null && echo "  ✅ 后端 OK" || echo "  ❌ 后端异常"
curl -fsS http://127.0.0.1:8787/health >/dev/null && echo "  ✅ AI 代理 OK" || echo "  ❌ AI 代理异常"
curl -fsS http://127.0.0.1/ >/dev/null && echo "  ✅ 前端 OK" || echo "  ❌ 前端异常"

echo ""
echo "✅ 部署完成。"
echo "   访问地址： http://$(curl -fsS ip.sb 2>/dev/null || echo '<ECS公网IP>')/"
[ -n "${SITE_DOMAIN:-}" ] && echo "   或（HTTPS）： https://$SITE_DOMAIN/"
echo "   ⚠️ 阿里云控制台「安全组」需放通 80/443 入方向；"
echo "   ⚠️ 首次使用：在「我的 → 设置 → 重置」清空浏览器本地演示数据，再以云端账号使用。"
