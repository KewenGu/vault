# 部署到一台自己的服务器

一台常开的 Linux 服务器上用 Docker 跑 Vault，前面放 Caddy 自动管 HTTPS。数据库、登录、文件存储仍然用 Supabase。

适用的机器：1 核、2 GB 内存、Ubuntu 24.04 就够（按这个大小给了默认值）。更大的机器把 `deploy/.env` 里那几个数调高即可。

## 先知道这几件事

- **速度**：1 核的机器处理长视频慢。一条半小时的视频，下载、抽画面、转写、压缩副本加起来要十几二十分钟；短视频、图文、文章是一两分钟。同时只处理一两条，其余排队。
- **机房 IP 会被一部分平台拦**：YouTube 从云服务器读会要求验证身份（已实测）。配了 `APIFY_TOKEN` 时会自动改走 Apify（约 $0.004 / 条）：读得到标题、简介和字幕，拿不到视频本体，所以没有画面；没有字幕的视频就不知道里面说了什么。小红书也有被拦的风险。读不到的链接可以在页面上手动贴文字。抖音走 Apify，不受影响。
- **没有本机 whisper**：语音转写要配 `OPENAI_API_KEY` 或 `VOLC_SPEECH_API_KEY`。
- **内存**：视频整个读进内存再处理。`VAULT_VIDEO_READ_MAX_MB` 默认给的 250 是按 2 GB 内存定的，超过这个大小的视频只读封面和文案。
- **这台机器上原来的东西**：Caddy 要用 80 和 443 端口。机器上要是还跑着别的服务占着这两个端口（比如邮件服务自带的网页），要先停掉。

## 步骤

### 1. 域名

准备一个解析到这台服务器的域名（加一条 A 记录）。没有域名可以用 `sslip.io`：服务器 IP 是 `1.2.3.4`，域名就是 `1-2-3-4.sslip.io`，不用注册。

### 2. 准备服务器

SSH 登上去，把代码拉下来。仓库是私有的，服务器上要有读它的权限，最简单的是部署密钥：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vault_deploy -N ""
```

```bash
cat ~/.ssh/vault_deploy.pub
```

把输出的那一行加到 GitHub 仓库的 **Settings → Deploy keys**（只读就行），然后：

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/vault_deploy" git clone git@github.com:KewenGu/vault.git
```

```bash
cd vault && git config core.sshCommand "ssh -i ~/.ssh/vault_deploy"
```

装 Docker、加交换空间、开防火墙（先看一眼脚本做了什么再跑）：

```bash
sudo bash deploy/setup-server.sh
```

脚本最后会列出 80 和 443 端口现在被谁占着。有东西占着的话先停掉它。

### 3. 填配置

```bash
cp deploy/.env.example deploy/.env
```

```bash
nano deploy/.env
```

必填：`VAULT_DOMAIN`、三个 Supabase 变量、`ANTHROPIC_API_KEY`、`VAULT_ALLOWED_EMAILS`（你登录用的邮箱）。其余的和你本机 `.env.local` 里的一样，抄过来。

### 4. 构建并启动

```bash
cd deploy && docker compose up -d --build
```

第一次构建在 1 核的机器上要十到十五分钟。看进度和日志：

```bash
docker compose logs -f vault
```

### 5. Supabase 那边

控制台 **Authentication → URL Configuration**：把 **Site URL** 改成 `https://你的域名`。

建议同时在 **Authentication → Sign In / Providers** 里关掉新用户注册（你的账号已经建好了）。`VAULT_ALLOWED_EMAILS` 已经挡住了别人，这是第二道。

### 6. 验证

打开 `https://你的域名`，登录，然后看「状态」页：每一项应该是「可用」，「别的视频站」和「读网页正文」是可选的。存一段文字，一分钟内出现标题和概括，就说明整条链路通了。

手机上：用浏览器打开同一个地址登录。Android 的 Chrome 里「添加到主屏幕」之后，别的 App 的分享菜单里会出现 Vault。

## 日常

更新到最新版：

```bash
cd vault && git pull && cd deploy && docker compose up -d --build
```

重启、停止：

```bash
docker compose restart vault
```

```bash
docker compose down
```

改了 `deploy/.env` 之后要重新 `docker compose up -d`；改的是 `NEXT_PUBLIC_` 开头的变量还要加 `--build`（它们是构建时写进去的）。

## 这套部署里的几个决定

- **后台任务的状态存在本机的卷里**（`vault-data`）。处理到一半重启容器，起来之后会接着跑。只能跑一个应用容器，不能横向扩。
- **后台任务的内部接口不对外**：`/.well-known/workflow/*` 在 Caddy 那一层直接回 404。本机模式下这些接口没有鉴权，应用自己从容器内部调。不要绕过 Caddy 把 3000 端口直接暴露出去。
- **ffmpeg 来自镜像**（`mwader/static-ffmpeg:9.0.2`），不用服务器上装。Ubuntu 24.04 自带的 6.1 不够新。
- **没有装 yt-dlp**：B 站这类别的视频站的链接只按网页读文字。

## 验证过什么

2026-11-18，在一台云端容器里：

- 镜像构建成功并启动：健康检查、登录跳转、以普通用户运行、tini 当 1 号进程。
- 镜像里的 ffmpeg 是 9.0.2、带 libx264；上传一段视频，真实抽出了 8 帧画面和 1 张帧格；压缩副本用的参数在这个 ffmpeg 上产出了正确的 H.264 + AAC 文件。
- 中文字体能解析（帧格上的中文标注要用）。
- Caddy 在前面时：站点正常，`/.well-known/workflow/*` 从外面访问是 404。

没验证的：在真实服务器上跑、Let's Encrypt 证书申请、1 核机器上的实际耗时。那次测试里没有 Anthropic 密钥，「理解内容」这一步在镜像里没跑（这一步和部署方式无关，本机跑通过）。

## 出问题时

- **构建到一半被杀掉**（`Killed`、退出码 137）：内存不够。确认交换空间在：`swapon --show`。
- **证书申请不下来**：域名没解析到这台机器，或者 80 / 443 被别的服务占着、被防火墙挡着。看 `docker compose logs caddy`。
- **构建时用的 Supabase 地址不对**：`docker compose` 里，当前终端里已有的同名环境变量会盖过 `deploy/.env`。服务器上一般没有；有的话先 `unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY`。
- **内容卡在「理解中」很久**：1 核机器处理长视频本来就慢。看 `docker compose logs -f vault`；容器重启过的话，起来之后会接着跑。
