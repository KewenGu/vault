#!/usr/bin/env bash
# 在一台新的 Ubuntu 服务器上做三件准备工作（用 root 跑；可以重复跑）：
#   1. 加 2 GB 交换空间——2 GB 内存的机器构建镜像时不够用，没有它构建会被系统杀掉
#   2. 装 Docker
#   3. 防火墙只放行 SSH、80、443
# 不动别的东西。跑之前先看一遍。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 跑：sudo bash deploy/setup-server.sh" >&2
  exit 1
fi

if ! swapon --show | grep -q .; then
  echo "== 加 2 GB 交换空间"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "== 已有交换空间，跳过"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "== 装 Docker（官方安装脚本）"
  curl -fsSL https://get.docker.com | sh
else
  echo "== 已有 Docker，跳过"
fi

if command -v ufw >/dev/null 2>&1; then
  echo "== 防火墙：放行 SSH、80、443"
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

echo
echo "准备好了。80 和 443 端口现在被谁占着："
ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' || echo "  没有（可以部署）"
