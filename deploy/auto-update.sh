#!/usr/bin/env bash
# 自动更新：看 GitHub 上的 main 有没有新提交，有就拉下来、重新构建镜像、重启应用。
# 一般不手动跑：install-auto-update.sh 装一个 systemd 定时器，每两分钟跑一次（见 deploy/README.md「自动更新」）。
# 手动跑也行：bash deploy/auto-update.sh（--force：不管有没有新提交都重新构建一次）。
#
# - 只快进（git merge --ff-only）。服务器上改过被 git 管着的文件、或者本地分叉了，就不动、报错，等人来处理。
#   deploy/.env 不归 git 管，不受影响。
# - 构建失败：旧容器照常跑（docker compose 先构建、成功了才换容器）；这个提交记下来，不再反复构建，等下一个提交。
# - 新容器起来了但健康检查不过：换回上一个镜像，同样记下这个提交。
# - 新提交里有数据库迁移（supabase/migrations）时日志里会提醒：迁移要自己推到 Supabase，这里不动数据库。
# - 成功后清掉没用了的旧镜像（每次构建都会留下一个，小磁盘几次就满了）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${VAULT_UPDATE_BRANCH:-main}"
STATE="$REPO/deploy/.auto-update"
IMAGE="vault:local"
PREVIOUS="vault:previous"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

mkdir -p "$STATE"
# 上一次还在构建（1 核的机器要十几分钟）：这次直接跳过
exec 9>"$STATE/lock"
if ! flock -n 9; then
  log "上一次更新还没跑完，这次跳过"
  exit 0
fi

cd "$REPO"
if ! git fetch --quiet origin "$BRANCH"; then
  log "拉取 origin/$BRANCH 失败（网络，或者部署密钥不对），下次再试"
  exit 1
fi

current_branch="$(git symbolic-ref --short -q HEAD || true)"
if [ "$current_branch" != "$BRANCH" ]; then
  log "服务器上的代码不在 $BRANCH 分支上（现在是 ${current_branch:-游离的 HEAD}），不自动更新。切回去：git checkout $BRANCH"
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
  if ! git merge --ff-only --quiet "origin/$BRANCH"; then
    log "没法快进到 origin/$BRANCH：服务器上改过代码，或者本地有别的提交。看 git status，处理好之后会自动接着更新"
    exit 1
  fi
fi

head="$(git rev-parse HEAD)"
short="$(git rev-parse --short HEAD)"
built="$(cat "$STATE/built" 2>/dev/null || true)"
failed="$(cat "$STATE/failed" 2>/dev/null || true)"

if [ "$FORCE" -eq 0 ]; then
  [ "$head" = "$built" ] && exit 0
  if [ "$head" = "$failed" ]; then
    # 这个提交构建或启动失败过：不反复试，等下一个提交（或者手动 --force）
    exit 0
  fi
fi

log "更新到 $short：$(git log -1 --format=%s)"
if [ -n "$built" ] && git cat-file -e "$built^{commit}" 2>/dev/null; then
  migrations="$(git diff --name-only "$built" "$head" -- supabase/migrations)"
  if [ -n "$migrations" ]; then
    log "注意：这次更新里有数据库迁移，要自己推到 Supabase（在 SQL Editor 里运行，或者 npx supabase link 之后 npx supabase db push --remote）："
    printf '  %s\n' $migrations
  fi
fi

cd "$REPO/deploy"
# 留一份现在在跑的镜像，新的起不来时换回去
had_previous=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$PREVIOUS"
  had_previous=1
fi

if ! docker compose build vault; then
  echo "$head" >"$STATE/failed"
  log "构建失败，还在跑原来的版本。修好之后推一个新提交，或者手动跑：bash deploy/auto-update.sh --force"
  exit 1
fi

# --wait：等健康检查通过（镜像里 /api/health）
if docker compose up -d --no-build --wait --wait-timeout 300 vault; then
  echo "$head" >"$STATE/built"
  rm -f "$STATE/failed"
  docker image prune -f >/dev/null || true
  log "完成：现在跑的是 $short"
  exit 0
fi

echo "$head" >"$STATE/failed"
if [ "$had_previous" -eq 1 ]; then
  log "新版本 $short 启动后健康检查没通过，换回上一个版本。看日志：cd deploy && docker compose logs --tail 200 vault"
  docker tag "$PREVIOUS" "$IMAGE"
  docker compose up -d --no-build vault || log "换回上一个版本也没起来，要手动处理"
else
  log "新版本 $short 启动后健康检查没通过，也没有上一个版本可以换回。看日志：cd deploy && docker compose logs --tail 200 vault"
fi
exit 1
