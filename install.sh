#!/usr/bin/env bash
# 在 Linux 云服务器上一键部署（Ubuntu / Debian / CentOS 都行）
# 用法：sudo bash install.sh [端口，默认 80]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-80}"

echo "== 检查 Python =="
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y python3
  elif command -v yum >/dev/null 2>&1; then
    yum install -y python3
  fi
  PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ]; then
  echo "没找到 python3，请先安装：apt install python3  或  yum install python3"
  exit 1
fi
echo "python: $PY"

echo "== 注册开机自启服务 =="
cat > /etc/systemd/system/pokeassist.service <<EOF
[Unit]
Description=PokeMMO Battle Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$PY $DIR/server.py $PORT
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pokeassist >/dev/null 2>&1 || true
systemctl restart pokeassist
sleep 1
systemctl --no-pager --lines=12 status pokeassist || true

echo
echo "== 完成 =="
echo "用浏览器打开： http://服务器公网IP:$PORT/"
echo "记得在云服务器的「安全组 / 防火墙」里放行 $PORT 端口。"
echo "数据文件： $DIR/data/shared.json （备份它就是备份所有配招数据）"
echo "看日志： systemctl logs -f pokeassist   或   journalctl -u pokeassist -f"
echo "改端口： 编辑 /etc/systemd/system/pokeassist.service 里的端口，然后 systemctl restart pokeassist"
