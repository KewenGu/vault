import type { Metadata } from "next";
import { headers } from "next/headers";
import { CopyField } from "@/components/copy-field";
import { requireSession } from "@/lib/auth/user";
import { captureScript } from "@/lib/vault/page-capture";
import { shareAddress, shortcutInstall } from "@/lib/vault/shortcut";

export const metadata: Metadata = { title: "手机上用" };

/** 步骤里的界面文字：英文系统的叫法在前，中文系统的在括号里 */
function Ui({ en, zh }: { en: string; zh?: string }) {
  return (
    <span className="font-medium text-ink">
      {en}
      {zh && <span className="font-normal text-ink-muted">（{zh}）</span>}
    </span>
  );
}

/**
 * 手机上怎么从别的 App 直接存进来。Android 靠 manifest 的 share_target；iPhone 靠一个快捷指令（见 lib/vault/shortcut.ts）：
 * 从分享菜单进来存分享的内容；点主屏幕图标直接运行时先问「读剪贴板」还是「传照片或文件」（后者打开 /upload）。
 * 地址按当前访问的域名填好，照着做不用自己拼。
 */
export default async function MobilePage() {
  await requireSession();
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  const origin = `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const address = shareAddress(origin);
  const install = shortcutInstall(process.env.VAULT_IOS_SHORTCUT_URL);

  const sub = "mt-2 flex list-[lower-alpha] flex-col gap-2 pl-5 marker:text-ink-faint";
  const content = <Ui en="Content" zh="内容" />;
  const steps = (
    <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-ink-secondary marker:text-ink-faint">
      <li>
        打开「快捷指令」App，点右上角的 + 新建一个，名字改成「存入 Vault」。
        <a href="shortcuts://create-shortcut" className="ml-1 text-accent hover:underline">
          在 iPhone 上点这里直接新建
        </a>
      </li>
      <li>
        点底部的 ⓘ，打开 <Ui en="Show in Share Sheet" zh="在共享表单中显示" />。回到编辑页，最上面多了一行「Receive Any input from Share Sheet」：其中{" "}
        <Ui en="If there's no input" /> 后面保持 <Ui en="Continue" zh="继续" />。
      </li>
      <li>
        加一个动作 <Ui en="If" zh="如果" />，条件是 <Ui en="Shortcut Input" zh="快捷指令输入" /> <Ui en="has any value" zh="有任何值" />
        。它会自带 <Ui en="Otherwise" zh="否则" /> 和 <Ui en="End If" zh="结束如果" />。
      </li>
      <li>
        在 If 和 Otherwise 之间（从分享菜单进来的时候）：加一个 <Ui en="Set Variable" zh="设定变量" />，变量名填 {content}，值选 <Ui en="Shortcut Input" zh="快捷指令输入" />。
      </li>
      <li>
        在 Otherwise 和 End If 之间（点主屏幕上的图标直接运行的时候）：加一个 <Ui en="Choose from Menu" zh="从菜单中选取" />
        ，提示写「存什么」，两个选项改成「读剪贴板」和「传照片或文件」：
        <ol className={sub}>
          <li>
            「读剪贴板」下面：<Ui en="Get Clipboard" zh="获取剪贴板" />，再加一个 <Ui en="Set Variable" zh="设定变量" />，变量名同样是 {content}，值选 Clipboard。
          </li>
          <li>
            「传照片或文件」下面：<Ui en="Open URLs" zh="打开 URL" />，里面放下面这个地址；再加一个 <Ui en="Stop This Shortcut" zh="停止此快捷指令" />。
            <div className="mt-2">
              <CopyField value={`${origin}/upload`} label="上传页的地址" />
            </div>
          </li>
        </ol>
      </li>
      <li>
        在 End If 下面（最外层）依次加四个动作：
        <ol className={sub}>
          <li>
            <Ui en="Get Text from Input" />，输入选变量 {content}。
          </li>
          <li>
            <Ui en="Base64 Encode" zh="Base64 编码" />
            ，输入是上一步的 Text。点动作右边的箭头展开，把 <Ui en="Line Breaks" /> 改成 <Ui en="None" />
            （默认每 76 个字符换一行，换了行地址就断了）。
          </li>
          <li>
            <Ui en="Text" zh="文本" />
            。先粘贴下面这个地址，在同一行后面紧接着插入上一步的结果 <Ui en="Base64 Encoded" />
            ，中间不要有空格或换行。
            <div className="mt-2">
              <CopyField value={address} label="快捷指令里填的地址" />
            </div>
          </li>
          <li>
            <Ui en="Open URLs" zh="打开 URL" />
            ，里面只放上一步的 Text。不要把地址直接写在这一步里：它会把地址和内容当成两个网址分别打开。
          </li>
        </ol>
      </li>
      <li>点完成，然后在快捷指令上长按，选 <Ui en="Add to Home Screen" zh="添加到主屏幕" />。</li>
    </ol>
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">手机上用</h1>
        <p className="text-sm leading-relaxed text-ink-muted">在别的 App 里点「分享」就能存进来，不用复制、切回来再粘贴。</p>
      </header>

      <section className="panel flex flex-col gap-4 px-4 py-4">
        <h2 className="text-[15px] font-medium">iPhone：装一个快捷指令</h2>
        {install.kind === "link" && (
          <div className="flex flex-col gap-2">
            <a href={install.url} className="btn btn-primary self-start">
              安装快捷指令
            </a>
            <p className="text-sm leading-relaxed text-ink-muted">在 iPhone 上点开，再点「添加快捷指令」。它里面写的是这个站点的地址。</p>
          </div>
        )}
        {install.kind === "invalid" && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            VAULT_IOS_SHORTCUT_URL 配了，但{install.reason}，所以这里没有显示安装按钮。
          </p>
        )}
        {install.kind === "link" ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-muted hover:text-ink">自己动手做一个（步骤）</summary>
            <div className="mt-3">{steps}</div>
          </details>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-ink-muted">做一次就行，五分钟左右。</p>
            {steps}
          </>
        )}
        <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-secondary">
          <h3 className="font-medium text-ink">怎么用</h3>
          <p>在任何 App 里点「分享」，在系统的分享菜单里选「存入 Vault」，落到确认页，点一下存入。有的 App（比如抖音）要先点分享面板里的「更多」才出现系统的分享菜单。</p>
          <p>点主屏幕上的图标直接运行，会先问「存什么」：</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">
            <li>「读剪贴板」：存剪贴板里的链接或文字。App 只给「复制链接」的时候，复制完点它。</li>
            <li>「传照片或文件」：打开 Vault 的上传页，点「选择照片或文件」，可以从相册选（一次选好几张也行）、从「文件」里选或者现拍，选完就存进来，每个文件一条。</li>
          </ul>
          <p className="text-ink-muted">
            确认页是在 Safari 里打开的。Safari 和主屏幕上的 Vault 图标各记各的登录：第一次要在 Safari 里登录一次，登录完会接着存。第一次运行时系统会问能不能打开这个网站、能不能读剪贴板，都选始终允许。
          </p>
        </div>
        <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-muted">
          <h3 className="font-medium text-ink">之前照旧步骤做过</h3>
          <p>
            原来的是 Receive 之后直接 Get Text from Input → Base64 Encode → Text → Open URLs。改成上面的样子：把 If there&apos;s no input 改回 Continue；在最前面加第 3–5 步；原来的四个动作留在 End If 下面，把 Get Text from Input 的输入从 Shortcut Input 换成变量 {content}。
          </p>
        </div>
        {install.kind !== "link" && (
          <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-muted">
            <h3 className="font-medium text-ink">为什么不是一点就装</h3>
            <p>
              iPhone 只肯安装从苹果设备上分享出来的快捷指令（带苹果签名的 iCloud 链接），网站自己生成不了。上面的做好之后，在「快捷指令」里长按它，选 Share → Copy iCloud Link，把链接填到服务器的{" "}
              <code className="font-mono text-[13px] text-ink-secondary">VAULT_IOS_SHORTCUT_URL</code>
              ，这一页就会出现「安装快捷指令」按钮，换手机或者给别人用时点一下就装好。拿到链接的人都能装，里面带着这个站点的地址。快捷指令改过之后要重新拷一次链接。
            </p>
          </div>
        )}
      </section>

      <section className="panel flex flex-col gap-4 px-4 py-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[15px] font-medium">iPhone：服务器读不到的网页（微信公众号）</h2>
          <p className="text-sm leading-relaxed text-ink-muted">
            公众号文章对服务器要求先过验证，Vault 自己读不了，但在 Safari 里能看。再做一个快捷指令，在 Safari 里把正在看的公众号文章（标题、正文、配图、发布时间）读下来交给 Vault。在别的网站上用它只交链接，和上面那个一样：小红书、抖音这些照常按链接读。不能和上面那个合成一个：快捷指令只要还接收网页以外的类型，Safari 交进来的就只是链接，在页面上跑不了脚本。
          </p>
        </div>
        <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-ink-secondary marker:text-ink-faint">
          <li>
            先打开系统设置里的 <Ui en="Settings → Apps → Shortcuts → Advanced" zh="设置 → App → 快捷指令 → 高级" />，打开 <Ui en="Allow Running Scripts" zh="允许运行脚本" />。
          </li>
          <li>
            新建一个快捷指令，名字改成「存入 Vault（网页）」。点底部的 ⓘ，打开 <Ui en="Show in Share Sheet" zh="在共享表单中显示" />。回到编辑页，点最上面一行里的 Any，只勾 <Ui en="Safari Web Pages" zh="Safari 网页" />。
          </li>
          <li>
            加一个动作 <Ui en="Run JavaScript on Webpage" zh="在网页上运行 JavaScript" />
            ，它的输入是 <Ui en="Shortcut Input" zh="快捷指令输入" />。把里面自带的示例代码全部删掉，换成下面这段（地址已经按这个站点填好）：
            <div className="mt-2">
              <CopyField value={captureScript(origin)} label="快捷指令里的脚本" multiline />
            </div>
          </li>
          <li>
            最后加一个动作 <Ui en="Open URLs" zh="打开 URL" />，里面只放上一步的结果（Run JavaScript on Webpage 的输出）。
          </li>
          <li>点完成。</li>
        </ol>
        <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-secondary">
          <h3 className="font-medium text-ink">怎么用</h3>
          <p>在 Safari 里打开文章（微信里点右上角的 ···，选在浏览器里打开；没有这一项就复制链接，到 Safari 里粘贴打开），等正文显示出来，点 Safari 的分享，选「存入 Vault（网页）」。落到确认页，看一眼标题和正文开头，点存入。</p>
          <p>之前存过、读失败了的同一篇，会换上这次读到的内容重新处理，不会多出一条。</p>
          <p className="text-ink-muted">第一次运行时系统会问能不能在这个网站上运行脚本，选允许。存的是你当时在页面上看到的文字；很长的文章（两三万字以上）地址可能太长被截断，确认页会说「收到了但不完整」，那就复制正文贴进来。</p>
        </div>
      </section>

      <section className="panel flex flex-col gap-1.5 px-4 py-4 text-sm leading-relaxed text-ink-secondary">
        <h2 className="text-[15px] font-medium text-ink">Android</h2>
        <p>用 Chrome 打开这个站点，菜单里选「添加到主屏幕」。装好之后，别的 App 的分享菜单里会直接出现 Vault，不用另外装东西。</p>
      </section>
    </div>
  );
}
