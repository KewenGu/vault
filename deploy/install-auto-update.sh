#!/usr/bin/env bash
# 装上自动更新：一个 systemd 定时器，开机三分钟后开始，之后每次跑完隔两分钟再跑 deploy/auto-update.sh。
# 用 root 跑：sudo bash deploy/install-auto-update.sh（可以重复跑）。卸掉：sudo bash deploy/install-auto-update.sh --uninstall
# 看它在做什么：journalctl -u vault-auto-update -f
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 跑：sudo bash deploy/install-auto-update.sh" >&2
  exit 1
fi

UNIT=vault-auto-update
if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  systemctl daemon-reload
  echo "自动更新已经卸掉。"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 用拉代码的那个用户跑：git 和部署密钥都是它的
OWNER="$(stat -c %U "$REPO")"
as_owner() { runuser -u "$OWNER" -- "$@"; }

if ! as_owner docker info >/dev/null 2>&1; then
  echo "用户 $OWNER 用不了 docker。把它加进 docker 组，重新登录一次再装：" >&2
  echo "  sudo usermod -aG docker $OWNER" >&2
  exit 1
fi
if ! as_owner git -C "$REPO" fetch --quiet origin main; then
  echo "用户 $OWNER 拉不了代码（git fetch 失败）：看 deploy/README.md 第 2 步的部署密钥。" >&2
  exit 1
fi

# 记下「现在跑的就是当前这份代码」，装上之后不会马上重新构建一遍（1 核的机器要十几分钟）
STATE="$REPO/deploy/.auto-update"
as_owner mkdir -p "$STATE"
if [ ! -s "$STATE/built" ]; then
  as_owner git -C "$REPO" rev-parse HEAD | as_owner tee "$STATE/built" >/dev/null
  echo "当作现在在跑的就是 $(as_owner git -C "$REPO" rev-parse --short HEAD) 这个版本。不是的话装好之后跑一次：bash deploy/auto-update.sh --force"
fi

cat >"/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=Vault 自动更新（main 有新提交就重新构建并重启）
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$OWNER
ExecStart=/usr/bin/env bash $REPO/deploy/auto-update.sh
# 1 核的机器构建一次要十几分钟
TimeoutStartSec=3600
# 构建时别把正在跑的应用挤得太慢
Nice=10
EOF

cat >"/etc/systemd/system/$UNIT.timer" <<EOF
[Unit]
Description=每两分钟看一次 Vault 的 main 有没有更新

[Timer]
OnBootSec=3min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.timer"
echo "装好了：每两分钟看一次 main，有新提交就重新构建（以 $OWNER 的身份）。"
echo "看日志：journalctl -u $UNIT -f"
