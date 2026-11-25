# 部署到一台自己的服务器

一台常开的 Linux 服务器上用 Docker 跑 Vault，前面放 Caddy 自动管 HTTPS。数据库、登录、文件存储仍然用 Supabase。

适用的机器：1 核、2 GB 内存、Ubuntu 24.04 就够（按这个大小给了默认值）。更大的机器把 `deploy/.env` 里那几个数调高即可。

## 先知道这几件事

- **速度**：1 核的机器处理长视频慢。一条半小时的视频，下载、抽画面、转写加起来要好几分钟（没在 1 核的机器上实测）；短视频、图文、文章是一两分钟。同时只处理一两条，其余排队。
- **机房 IP 会被一部分平台拦**：YouTube 从云服务器读会要求验证身份（已实测）。配了 `APIFY_TOKEN` 时会自动改走 Apify（约 $0.004 / 条）：读标题、简介和字幕，再把 360p 的视频下下来（约 $0.00001 / 分钟），画面照常看，没有字幕的（中文视频大多没有）照常转写。下视频比直接读慢：一条 41 分钟的视频要等四五分钟。下视频的 actor 是个人开发者维护的，哪天不能用了，这条内容顶部会写「视频没下到」，那时只有字幕和封面；换一个或者关掉用 `APIFY_YOUTUBE_DOWNLOAD_ACTOR`。小红书也有被拦的风险。读不到的链接可以在页面上手动贴文字。抖音走 Apify，不受影响。
- **没有本机 whisper**：语音转写要配 `OPENAI_API_KEY` 或 `VOLC_SPEECH_API_KEY`。
- **磁盘**：链接里的视频下载到容器里的临时目录，不进内存。一条最多下载 600 MB（`VAULT_VIDEO_READ_MAX_MB` 可改），超过的只读封面和文案；同时处理两条，临时要占一两个 GB。
- **大视频的原片留在这台机器上**：超过存档上限（默认 50 MB）的视频不进 Supabase，读完搬到卷里的 `/data/media`，页面从这里播放。不限总量、不自动清理，磁盘会一直涨；「状态」页上有占用和剩余空间，剩下不到 2 GB 会提醒。这些文件只在这台机器上，没有备份。
- **以前部署过的**：`deploy/.env` 里要是有 `VAULT_VIDEO_READ_MAX_MB=250`，删掉这一行再 `docker compose up -d`。那是视频还整个读进内存时按 2 GB 内存定的，现在留着只会把大一点的视频挡在外面。
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

打开 `https://你的域名`，登录，然后看「状态」页：每一项应该是「可用」（「读网页正文」是可选的）。存一段文字，一分钟内出现标题和概括，就说明整条链路通了。

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

### 自动更新

装一个 systemd 定时器，main 上有新提交就自动拉下来、重新构建、重启应用，不用每次登上去手动更新：

```bash
sudo bash deploy/install-auto-update.sh
```

它以拉代码的那个用户的身份跑（git 和部署密钥都是它的），这个用户要能用 docker；不能的话脚本会告诉你怎么加。装的时候当作现在跑的就是服务器上这份代码，不会马上重新构建一遍。

- **多快**：每次检查完隔两分钟再查一次。有新提交就构建，1 核的机器要十到十五分钟；构建期间旧版本照常跑，好了才换。
- **构建失败**：旧版本照常跑，这个提交不会反复构建，等下一个提交。修好了不想等，手动跑 `bash deploy/auto-update.sh --force`。
- **正在处理的内容**：重启会打断它，新版本起来后从中断的那一步重跑（做完的步骤不重做，见 `src/instrumentation.ts`）。正在看一条长视频时赶上更新，那一步要从头再看一遍。
- **新版本起不来**（健康检查五分钟内没通过）：自动换回上一个版本。
- **数据库迁移不会自动推**：新提交里有 `supabase/migrations` 的改动时，日志里会提醒，要自己推到 Supabase。
- **只快进**：服务器上改过被 git 管着的文件，或者本地有别的提交，就不动、在日志里报错，处理好之后自动接着更新。`deploy/.env` 不归 git 管，随便改。
- **旧镜像**：每次成功后清掉没用了的，只留现在的和上一个。

看它在做什么：

```bash
journalctl -u vault-auto-update -f
```

下次什么时候查：

```bash
systemctl list-timers vault-auto-update
```

卸掉：

```bash
sudo bash deploy/install-auto-update.sh --uninstall
```

## 这套部署里的几个决定

- **大视频的原片也在这个卷里**（`vault-data` 的 `/data/media`）。`docker compose down` 不会删卷，`down -v` 会连原片一起删。要腾地方：`docker compose exec vault sh -c 'du -sh /data/media/*/*'` 看哪条占得多，删掉对应的目录（`<用户>/<内容 id>`），那条内容还在，只是不能播放。
- **后台任务的状态存在本机的卷里**（`vault-data`）。处理到一半重启容器，起来之后会接着跑。只能跑一个应用容器，不能横向扩。
- **后台任务的内部接口不对外**：`/.well-known/workflow/*` 在 Caddy 那一层直接回 404。本机模式下这些接口没有鉴权，应用自己从容器内部调。不要绕过 Caddy 把 3000 端口直接暴露出去。
- **ffmpeg 来自镜像**（`mwader/static-ffmpeg:9.0.2`），不用服务器上装。Ubuntu 24.04 自带的 6.1 不够新。
- **yt-dlp 装在镜像里**（Python 的 venv，`/opt/yt-dlp`，镜像大约多 110 MB）：B 站、Vimeo、TED 这类别的视频站的链接能读到视频信息，视频本体下不下得来要看那个站让不让机房 IP 下（见下面「验证过什么」）。版本在 `Dockerfile` 里写死（`YTDLP_VERSION`）。视频站经常改版，哪天某个站读不到了，先把这个版本号改成 [PyPI 上最新的](https://pypi.org/project/yt-dlp/) 再重新构建。它帮不了 YouTube：从机房 IP 出去一样被拦，YouTube（信息、字幕、视频本体）靠上面说的 Apify。

## 验证过什么

2026-11-18，在一台云端容器里：

- 镜像构建成功并启动：健康检查、登录跳转、以普通用户运行、tini 当 1 号进程。
- 镜像里的 ffmpeg 是 9.0.2、带 libx264；上传一段视频，真实抽出了 8 帧画面和 1 张帧格。
- 中文字体能解析（帧格上的中文标注要用）。
- Caddy 在前面时：站点正常，`/.well-known/workflow/*` 从外面访问是 404。

2026-11-19，同样在云端容器里，加了 yt-dlp 之后：

- 镜像构建成功；里面的 yt-dlp 是 2026.10.26，以应用的普通用户身份能跑。
- 用应用自己的读取代码调镜像里的 yt-dlp 和 ffmpeg：读到了 archive.org、TED、B 站视频的信息；TED 一条 19 分钟的演讲（161 MB）和 archive.org 一条 10 分钟的视频下了下来，是能播放的 H.264 + AAC 文件。
- B 站：视频信息读到了，视频本体没下下来（B 站的 CDN 对那个容器的 IP 返回 HTTP 567）。在真实服务器上能不能下没验证，下不了时只看封面和文字。
- YouTube：yt-dlp 在机房 IP 上同样被拦，接着走 Apify 读到了（整个过程约 19 秒）。

2026-11-25，在云端容器里，YouTube 的视频本体：

- 用应用自己的读取代码读一条 41 分钟、没有字幕的中文视频：YouTube 直接读被拦，走 Apify，24 秒读到信息，再起一次运行下视频，2 分 20 秒后拿到 38 MB 的 360p 文件（H.264 + AAC），经应用的受控出口存到磁盘；ffmpeg 从里面抽出了画面和音轨。Apify 记了 $0.003（读信息）+ $0.0004（下视频）。
- 没验证的：这条视频接着走转存、抽画面、转写、理解；一两个小时的长视频要下多久；在真实服务器上跑。

没验证的：在真实服务器上跑、Let's Encrypt 证书申请、1 核机器上的实际耗时。那次测试里没有 Anthropic 密钥，「理解内容」这一步在镜像里没跑（这一步和部署方式无关，本机跑通过）。

## 出问题时

- **构建到一半被杀掉**（`Killed`、退出码 137）：内存不够。确认交换空间在：`swapon --show`。
- **证书申请不下来**：域名没解析到这台机器，或者 80 / 443 被别的服务占着、被防火墙挡着。看 `docker compose logs caddy`。
- **构建时用的 Supabase 地址不对**：`docker compose` 里，当前终端里已有的同名环境变量会盖过 `deploy/.env`。服务器上一般没有；有的话先 `unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY`。
- **内容卡在「理解中」很久**：1 核机器处理长视频本来就慢。看 `docker compose logs -f vault`；容器重启过的话，起来之后会接着跑。
