# syntax=docker/dockerfile:1
# Vault 的运行镜像：Next.js 服务 + 读视频要用的 ffmpeg 和 yt-dlp。构建和运行的说明见 deploy/README.md。

# 静态编译的 ffmpeg（带 libx264）。应用要求 8.1.3 以上或 9.0.2 以上，发行版自带的不够新。
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_ 开头的变量会被写进浏览器端的代码，所以构建时就要给（换了 Supabase 项目要重新构建）
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    || (echo "构建时要给 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY（见 deploy/README.md）" && exit 1)
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS run
# fontconfig + fonts-noto-cjk：视频帧格上的中文字要有字体才画得出来；tini：当 1 号进程，回收 ffmpeg 留下的子进程；
# python3：yt-dlp 要用
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-noto-cjk tini python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp：认 B 站、Vimeo 这类别的视频站。装在自己的 venv 里，版本写死；视频站改版读不到了，把版本号改成最新的重新构建
# （docker compose build --build-arg YTDLP_VERSION=… 也行）。
ARG YTDLP_VERSION=2026.10.26
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check "yt-dlp[default]==${YTDLP_VERSION}" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && yt-dlp --version
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    WORKFLOW_TARGET_WORLD=local \
    WORKFLOW_LOCAL_DATA_DIR=/data/workflow
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
# /data：后台任务的状态（处理到一半重启能接着跑）。挂一个卷，别放在容器里。
RUN mkdir -p /data/workflow && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node_modules/.bin/next", "start"]
