# Vault

个人收藏库：把看到的任何内容存进来——链接、截图、图片、音频、视频、文字——Vault 把它读懂、归好类，以后搜得到、用得上。

现在是自用阶段的网页版；数据按用户隔离、接口独立成 `/api/v1`，为以后的手机 App 留好了位置。收藏和图谱的底子来自 [SM-Intelligence](https://github.com/KewenGu/SM-Intelligence) 的收藏夹与知识图谱。

技术栈：Next.js 16 / React 19、Supabase（Postgres + pgvector、Auth、Storage）、Workflow DevKit、Claude、Voyage 向量。

## 它做什么

| 步骤 | 做什么 |
|---|---|
| 存 | 贴链接（含 App 里「复制链接」得到的那段话）、贴文字、上传 / 拖入 / 粘贴文件。同一条内容只存一次。 |
| 读取 | 链接按平台读帖子，图片和视频转存到自己的存储桶（原帖删了、链接失效了也还在）。 |
| 看和听 | 视频抽画面、测切点；视频和音频里说的话转成带时间的文字。 |
| 理解 | Claude 看图 + 读文字，产出标题、概括、内容要点（视频的带时间）、按内容类型提取的卡片字段（食材、地址、价格…）、原话、图上的文字。 |
| 归类 | 内容类型（食谱 / 地点 / 商品 / 教程…15 种）、领域（美食 / 旅行 / 科技…15 个）、标签（会参考你已有的标签，尽量复用）。 |
| 目录和搜索 | 按类型、领域、来源、标签筛选；关键词 + 语义搜索，能搜到视频里说过的话和图片上的字，中英文互通。 |
| 知识图谱 | 每条内容提到的人、机构、地方、产品、作品、概念、事件增量并入一张图：同名直接归并，疑似同一个的让模型判断。 |

支持的来源：

| 来源 | 怎么读 | 花费 |
|---|---|---|
| 小红书 | 直接读分享页（要链接里的口令） | 免费 |
| 抖音 | Apify actor（视频、图文都读） | 约 $0.01 / 条 |
| TikTok | 直接读视频页 | 免费 |
| Instagram | Apify 官方 actor | 约 $0.003 / 条 |
| YouTube | App 的播放接口（字幕 + 360p 视频）；被拦时（云服务器上）走 Apify，只有字幕、没有画面 | 免费；走 Apify 时约 $0.004 / 条 |
| X | FxTwitter 公开接口 → 官方嵌入接口（长文 Articles 读全文和配图，要贴发长文的那条帖子的链接）；帖子提到的东西都跟着读：引用的、长文里嵌的帖子，正文和长文里的每个链接（网页、YouTube、小红书… 走各自的读法），读到的帖子里提到的接着往下读，最多 30 条 | 免费（跟着读的链接按各自平台计费） |
| 其他网页（博客、新闻、商品页、Reddit…） | Jina Reader → 自己抓；本机有 yt-dlp 时认别的视频站 | Jina 带密钥时 $0.0005 |
| 微信公众号文章 | 服务器读不了（微信对服务器和机房 IP 要求先过验证，2026-11-19 实测 Jina 和直接请求都只拿到验证页）：在 iPhone 的 Safari 里打开，用快捷指令「存入 Vault（网页）」从页面上读标题、正文、配图、发布时间（见「手机上用」）。直接贴链接会读失败，页面上告诉你这条路 | 免费 |
| 上传 | 图片 / 截图、视频、音频、`.txt` / `.md`，单个最多 50 MB（可调，见「存档上限」） | — |
| 文字 | 直接贴，最多 20 万字 | — |

链接读不到时（被删、要登录、风控），可以在那条内容的页面上手动贴正文，按贴的文字理解；微信公众号还可以在手机的 Safari 里打开它，用快捷指令「存入 Vault（网页）」存（同一个链接会换上读到的内容重新处理）。

## 验证到了哪一步

2026-11-17，在一台云端 Linux 容器里：

- 单元测试 257 个全部通过。其中迁移脚本在本机临时起的 PostgreSQL 16 + pgvector 上实跑：行级安全、中文关键词搜索、语义搜索、筛选、图谱函数。
- 本地完整 Supabase（数据库、登录、REST、存储）+ 真实的 Claude 和 Voyage 接口，用浏览器走通：注册登录、存文字、上传截图、存网页链接、链接读不到时贴文字、重复内容去重、改标签和备注、筛选、搜索、图谱页、删除（行、文件、无主的实体一起清掉）。
- 搜索实测：搜「冰糖」找到上传的食谱截图（字在图上）；中文问句找到英文文章；英文 "pressure cooker beef stew" 找到中文食谱。
- 两个账号互相看不到对方的内容：通过页面接口、直接调 Supabase 的 REST 和存储接口都试过。

2026-11-18，在作者自己的 Mac 上（云端的 Supabase 项目、免费套餐）：一条 38 分钟、127 MB 的抖音视频走通了读取链接、下载、从原片读画面和声音、压缩副本存档，压缩后的副本能在页面上播放。提取出来的内容够不够完整还没有逐条核对过。

2026-11-19，在一台云端容器里：一个 96 MB 的真实文件下载到磁盘，进程内存涨了约 40 MB（改之前整个读进内存，同一个文件涨 350 MB）；用真实的 ffmpeg 从磁盘上的视频抽出了画面和音轨。那台容器里的 ffmpeg 是 6.1，绕过了版本检查才跑的。同一天去掉了「大视频另存一份压缩副本」这一步（上面 11-18 那条里的压缩副本是去掉之前的行为），改成原片留在服务器的磁盘上、页面从磁盘播放：这一段只跑过自动测试（搬文件、分段读取、归属检查），没有在浏览器里对着真实的大视频播过。

2026-11-20，在一台云端容器里：生产构建 + 本地模式（和 Docker 部署一样），起一个三步的测试任务，第二步跑到一半时 `kill -9` 掉服务再起来：第一步没重做，第二步重跑，第三步跑完。去掉 `src/instrumentation.ts` 做同样的事，任务停在第二步不动——之前服务器上自动更新重启后内容卡在「正在看画面」就是这个原因。用的是测试任务，不是真实的一条内容。

**没有验证的**：

- 小红书、TikTok、Instagram、X 的真实读取。抖音只试过上面那一条。
- 几百 MB、一两个小时的真实视频从头到尾处理一遍（下载到磁盘那一步验证过，见上；整条链路没在这么大的视频上跑过）。
- 上传的视频和音频文件（链接里的视频试过，上传的没试）。
- YouTube：从云端机房 IP 读会被要求验证（「Sign in to confirm you're not a bot」）。配了 `APIFY_TOKEN` 时自动改走 Apify（2026-11-19 在云端容器里实测：一条 15 分钟的视频约 17 秒读到标题、简介、互动数和完整字幕；拿不到视频本体，所以没有画面）。没配时的失败提示和贴文字的补救流程验证过。在家用网络下直接读应当能行，没测。
- 部署到服务器：Docker 镜像在本地构建并跑通过（见 deploy/README.md），真实服务器上还没跑过。

处理一条内容的花费（Claude Opus 5.5 + Voyage）：实测一段短文字约 $0.04，一张截图约 $0.05，一篇短文约 $0.06。带十几帧画面的视频会更高。每条的花费记在 `items.cost_usd`，详情页底部显示。想省钱可以把 `VAULT_MODEL` 换成 `claude-sonnet-5-5`。

## 本地运行

需要 Node.js 22 以上、Docker（跑本地 Supabase 用；用云端的 Supabase 项目就不需要）。

```bash
npm install
```

```bash
npx supabase start
```

`supabase start` 会自动执行 `supabase/migrations` 里的迁移。地址和密钥：

```bash
npx supabase status
```

```bash
cp .env.example .env.local
```

把 `API_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY` 填进 `.env.local` 的三个 Supabase 变量，再填 `ANTHROPIC_API_KEY`（必填）和 `VOYAGE_API_KEY`（建议）。新式的 `PUBLISHABLE_KEY`（`sb_publishable_…`）和 `SECRET_KEY`（`sb_secret_…`）也能用，分别对应 anon 和 service role。然后：

```bash
npm run dev
```

打开 <http://localhost:3000>，用邮箱和密码注册（本地的 Supabase 不要求确认邮件）。

用云端的 Supabase 项目：建好项目后把迁移推上去（`npx supabase link` 再 `npx supabase db push`，或者把迁移文件的内容贴进控制台的 SQL Editor 运行），三个变量换成项目的（控制台 **Settings → API Keys**）。账号可以在 **Authentication → Users → Add user** 里直接建，勾上 Auto Confirm User 就不用等确认邮件。部署到公网时配上 `VAULT_ALLOWED_EMAILS`，或者在 Supabase 的 Auth 设置里关掉注册。

### 部署到服务器

想让它常开、手机上也能用：见 [deploy/README.md](deploy/README.md)（一台小的 Linux 服务器 + Docker + 自动 HTTPS）。Vercel 这类无服务器平台不合适：没有 ffmpeg，函数有时长和内存上限，读不了视频。

### 本机工具

| 工具 | 用来做什么 | 没有会怎样 |
|---|---|---|
| ffmpeg ≥ 8.1.3 | 抽视频画面、测切点、导音轨 | 视频只看封面和文字；上传的视频 / 音频没法理解 |
| 语音识别（豆包 / OpenAI / 本机 whisper，任一） | 把说的话转成带时间的文字 | 视频只看画面和文案；音频没法理解 |
| yt-dlp | 别的视频站、YouTube 的后备 | 这类链接只按网页读文字 |

登录后打开「状态」页（`/status`）能看到这台机器上每一项配齐了没有、缺了会怎样、怎么补。一条内容读得不完整时，详情页顶部会列出没读到的部分。

ffmpeg 的版本门槛是从 SM-Intelligence 带过来的安全基线（处理的是从网上下载的不可信文件）。macOS 上 `brew install ffmpeg` 即可；系统自带的旧版本可以用 `FFMPEG_PATH` 指到新的。

### 存档上限

视频原片和上传的文件，单个默认最多存 50 MB。这是 Supabase 免费套餐的硬上限（项目的全局上传上限封顶 50 MB）。

链接里更大的视频（最多 600 MB）照样下载下来，画面和声音从原片读。原片不进 Supabase，也不压缩，留在跑这个应用的那台机器的磁盘上（`VAULT_LOCAL_MEDIA_DIR`，Docker 部署是卷上的 `/data/media`；没设就是运行目录下的 `.vault-media`），页面直接从磁盘播放。

- 不限总量，不自动清理。「状态」页上能看到占了多少、磁盘还剩多少；剩下不到 2 GB 会提醒。
- 删掉一条内容，数据库里的行、存储桶里的文件（图片、视频、抽的帧）和这里的原片一起删。还在处理时删的，后台任务收尾时会把它后来又写出来的文件清掉。
- 只有那一台机器上有，没有备份。文件没了（清过磁盘、换了机器），这条内容读出来的画面和口播都还在，只是不能播放。
- 目录结构和存储桶一样（`<用户>/<内容 id>/video.mp4`）。以后换了付费套餐、调高上限，把这些文件搬进存储桶的功能还没做。
- 2026-11-19 之前存的大视频，存储桶里是一份压缩过的副本，照样能播。

想存更大的原片，三处都要放开，小的那个说了算：

| 哪里 | 怎么改 |
|---|---|
| Supabase 项目的全局上传上限 | 要付费套餐。控制台 **Storage → Settings → Upload file size limit** |
| 存储桶 `vault` | 迁移 `20261118000001_bucket_limit.sql` 已经设成 200 MB |
| 这个应用 | `.env.local` 里设 `VAULT_STORE_MAX_MB`（最多 200） |

「状态」页的「存档原片」一项会显示当前的上限和存储桶的上限对不对得上。另外留意总容量：免费套餐的存储一共 1 GB。

### 手机上用

网页已经适配手机宽度。在 Android 的 Chrome 里把站点「添加到主屏幕」之后，别的 App 的分享菜单里会出现 Vault，分享的链接落到确认页，点一下存入。iOS 的 Safari 不支持这个分享入口，用一个快捷指令代替：「手机」页（`/mobile`）上有按当前域名填好的步骤。从分享菜单进来存分享的内容；点主屏幕上的图标直接运行时先问「读剪贴板」还是「传照片或文件」，后者打开上传页 `/upload`（一个大按钮，点了就是系统的选照片 / 选文件 / 拍照；网页不能自己弹出选择界面，要点一下）；做好后把它的 iCloud 链接填进 `VAULT_IOS_SHORTCUT_URL`，页面上就有「安装快捷指令」按钮（快捷指令只能从苹果设备上分享出来，网站自己生成不了）。局域网里用手机访问电脑上的开发服务器时，上传的文件不会去重（浏览器只在 https 或 localhost 下提供算校验值的接口）。

服务器读不到的网页（微信公众号）用第二个快捷指令「存入 Vault（网页）」：只出现在 Safari 的分享菜单里，用「在网页上运行 JavaScript」从正在看的页面上取标题、正文、配图、发布时间，打开 `/share#page=<Base64 的 JSON>`（只对服务器读不了的站这样读，目前只有 `mp.weixin.qq.com`，名单是 `BROWSER_READ_HOSTS`；别的网站只交链接，走 `/share?b64=` 那条路），确认后存成一条链接内容，后台用这一份、不去抓网页（`src/lib/vault/page-capture.ts`）。内容放在 `#` 片段里，不发给服务器，长文不会撞上请求头的长度上限；没登录时登录完接着存。脚本也在「手机」页上，按当前域名填好。不能和普通分享的快捷指令合成一个：实测接收的类型里有网页以外的，Safari 就只交链接，脚本跑不了。还没在 iPhone 上实际跑过；很长的文章（两三万字以上）地址可能被截断，确认页会说「收到了但不完整」。

## 检查

```bash
npm run check
```

等于依次跑类型检查、lint、测试、生产构建。迁移测试需要本机有 PostgreSQL 16 和 pgvector，没有时自动跳过；`REQUIRE_POSTGRES=1` 让它必须跑。

## 接口

页面和接口共用同一套逻辑（`src/lib/vault/service.ts`）。鉴权认浏览器的登录态，也认 `Authorization: Bearer <Supabase 访问令牌>`。失败时返回 `{ "error": "给用户看的一句话" }`。

| 方法和路径 | 做什么 |
|---|---|
| `POST /api/v1/items` | 存一条。`{ input, note? }`，`input` 是链接、分享文案或文字。服务器读不到、客户端自己读到的网页传 `{ page: { url, title, text, description?, cover?, images?, author?, site?, publishedAt? }, note? }`（存过的同一个链接换上这份重新处理）。返回 `{ id, existing }` |
| `GET /api/v1/items` | 列出 / 搜索。`q`、`type`、`category`、`tag`、`platform`、`source`、`kind`、`entity`、`limit` |
| `GET /api/v1/items/:id` | 详情：理解结果、正文、口播、文件、关联的实体 |
| `PATCH /api/v1/items/:id` | 改备注和标签。`{ note?, tags? }` |
| `DELETE /api/v1/items/:id` | 删除（连同转存的文件） |
| `POST /api/v1/items/:id/process` | 重新处理。`{ from: "fetch" \| "analyze", text? }` |
| `POST /api/v1/uploads` | 开始上传。`{ name, mime, size, sha256, note? }`，返回签名上传的 `{ bucket, path, token }`；已存过时 `upload` 为 `null` |
| `POST /api/v1/uploads/:id/complete` | 文件传完，开始处理 |
| `GET /api/v1/graph` | 整张图谱：`{ nodes, links }` |
| `GET /media/:id/:file` | 读一个转存的文件（跳到短时效的签名地址） |

## 代码结构

```
supabase/migrations/        表、行级安全、搜索和图谱的数据库函数、存储桶
src/workflows/process-item.ts   一条内容的后台处理：读取 → 看和听 → 理解 → 建索引并入图
src/instrumentation.ts      服务启动时把上次没跑完的后台任务重新排上队
src/lib/
  vault/      capture（存进来的是什么）· store（items 表读写）· service（存 / 重跑 / 删）
              page-capture（在手机的 Safari 里读网页：快捷指令的脚本和确认页的解码）
              understand（提示词和解析）· taxonomy（类型、领域、实体的定义）
              indexing（搜索全文和向量文字）· search（关键词 + 语义）· facets（筛选栏计数）
  graph/      merge（实体增量并入）· data（图谱页的数据）
  ai/         claude（唯一的 Claude 调用出口）
  sources/    各平台的链接读取器
  media/      下载和统一图片、ffmpeg、抽帧和帧格、带时间的文字、音频、留在本机磁盘上的大视频原片
  asr/        语音识别的三条路
  network/    读外部地址的受控出口（只许公网地址、限大小、可走可信代理）
  usage/      用量计量和价格
  auth/       登录网关、邮箱名单、会话
src/app/
  (app)/      收藏库首页、详情、图谱、状态、手机上用、分享确认页、上传页
  (public)/   登录
  api/v1/     接口
  media/      文件读取
```

从 SM-Intelligence 搬来的部分（那边修了平台改版的问题要同步过来）：

| 这里 | SM-Intelligence |
|---|---|
| `src/lib/sources/` | `src/lib/favorites/`（各平台读取器、`link.ts`、`types.ts`） |
| `src/lib/media/files.ts` | `src/lib/favorites/media.ts` |
| `src/lib/media/{ffmpeg,frames,transcript}.ts` | `src/lib/video/ffmpeg.ts`、`src/lib/video/digest/{frames,transcript}.ts` |
| `src/lib/asr/{volc,openai,whisper-local}.ts` | `src/lib/media-gen/{asr,openai-asr,whisper-local}.ts` |
| `src/lib/network/`、`src/lib/node/` | 同名目录 |
| `src/lib/embeddings.ts` | `src/lib/search/embeddings.ts` |

和 SM-Intelligence 不一样的地方：

- 内容挂在用户上（不是人设），行级安全按用户隔离。
- 理解的提示词是通用的「讲了什么、有什么可用的信息」，不再是运营视角的「为什么火」。
- 图谱是一人一张、每存一条增量并入；那边是围绕种子整批建图。
- Claude 走官方 SDK（`@anthropic-ai/sdk`），不经 Vercel AI SDK。

## 已知的限制

- 首页一次最多列 60 条，还没有翻页。
- 中文关键词不分词：「三亚酒店」当一个词找，要拆开搜得写成「三亚 酒店」；语义搜索那一路会补上一部分。
- 语义搜索的相似度门槛（0.35）和实体归并的门槛（0.76）还没有用大一点的真实数据校准。
- 口播最多转写前 60 分钟。链接里的视频最多下载 600 MB 来读（`VAULT_VIDEO_READ_MAX_MB` 可改）：下载到磁盘上的临时目录，读完就删，不进内存。超过存档上限（默认 50 MB）的原片不进 Supabase，留在服务器的磁盘上（见「存档上限」）：磁盘只会越用越多，要自己看着清；上传的文件不走这条路，超过上限的传不上来。
- 上传的图片会统一成 JPEG（长边最多 2160），不保留原文件。长图（高是宽的 1.8 倍以上：手机截图、长截图、小红书长图）按宽度缩，宽最多 1440、高最多 3 万像素；给模型看时缩到宽 1024、切成每段 1536 高的几段（单张最多 16 段，一条最多 40 段，没给模型看的部分记进「没看到」）。2026-11-19 之前存的长图已经按长边缩小了，原图没留，要重新上传才清楚。iPhone 的 HEIC 照片在浏览器里一般会自动转成 JPEG 再传，转不了的会提示。
- 不支持 PDF 和 Office 文档。
- 图谱里并错的实体还不能手动拆开或合并。
