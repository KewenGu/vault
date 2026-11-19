import type { Metadata } from "next";
import { headers } from "next/headers";
import { CopyField } from "@/components/copy-field";
import { requireSession } from "@/lib/auth/user";
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
 * 手机上怎么从别的 App 直接存进来。Android 靠 manifest 的 share_target；iPhone 靠一个快捷指令（见 lib/vault/shortcut.ts）。
 * 地址按当前访问的域名填好，照着做不用自己拼。
 */
export default async function MobilePage() {
  await requireSession();
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  const address = shareAddress(`${proto}://${h.get("x-forwarded-host") ?? h.get("host")}`);
  const install = shortcutInstall(process.env.VAULT_IOS_SHORTCUT_URL);

  const steps = (
    <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-ink-secondary marker:text-ink-faint">
      <li>
        打开「快捷指令」App，点右上角的 + 新建一个，名字改成「存入 Vault」。
        <a href="shortcuts://create-shortcut" className="ml-1 text-accent hover:underline">
          在 iPhone 上点这里直接新建
        </a>
      </li>
      <li>
        点底部的 ⓘ，打开 <Ui en="Show in Share Sheet" zh="在共享表单中显示" />。回到编辑页，最上面多了一行「Receive Any input from Share Sheet」：把其中 <Ui en="If there's no input" /> 后面的 Continue 改成{" "}
        <Ui en="Get Clipboard" zh="获取剪贴板" />
        ——这样不从分享菜单进来时，存的就是剪贴板里的内容。
      </li>
      <li>
        加一个动作 <Ui en="Get Text from Input" />
        ，它的输入选 <Ui en="Shortcut Input" zh="快捷指令输入" />。
      </li>
      <li>
        加一个动作 <Ui en="Base64 Encode" zh="Base64 编码" />
        ，输入是上一步的 Text。点动作右边的箭头展开，把 <Ui en="Line Breaks" /> 改成 <Ui en="None" />
        （默认每 76 个字符换一行，换了行地址就断了）。
      </li>
      <li>
        加一个动作 <Ui en="Text" zh="文本" />
        。先粘贴下面这个地址，在同一行后面紧接着插入上一步的结果 <Ui en="Base64 Encoded" />
        ，中间不要有空格或换行。
        <div className="mt-2">
          <CopyField value={address} label="快捷指令里填的地址" />
        </div>
      </li>
      <li>
        最后加一个动作 <Ui en="Open URLs" zh="打开 URL" />
        ，里面只放上一步的 Text。不要把地址直接写在这一步里：它会把地址和内容当成两个网址分别打开。
      </li>
      <li>点完成。</li>
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
            <p className="text-sm leading-relaxed text-ink-muted">一共四个动作，做一次就行，两三分钟。</p>
            {steps}
          </>
        )}
        <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-secondary">
          <h3 className="font-medium text-ink">怎么用</h3>
          <p>在任何 App 里点「分享」，在系统的分享菜单里选「存入 Vault」，落到确认页，点一下存入。有的 App（比如抖音）要先点分享面板里的「更多」才出现系统的分享菜单。</p>
          <p>App 只给「复制链接」的时候：复制完，直接运行这个快捷指令（可以把它加到主屏幕），存的就是剪贴板里的内容，不会再弹「粘贴」确认。</p>
          <p className="text-ink-muted">
            确认页是在 Safari 里打开的。Safari 和主屏幕上的 Vault 图标各记各的登录：第一次要在 Safari 里登录一次，登录完会接着存。第一次运行时系统会问能不能打开这个网站，选始终允许。
          </p>
        </div>
        {install.kind !== "link" && (
          <div className="flex flex-col gap-1.5 border-t border-edge pt-4 text-sm leading-relaxed text-ink-muted">
            <h3 className="font-medium text-ink">为什么不是一点就装</h3>
            <p>
              iPhone 只肯安装从苹果设备上分享出来的快捷指令（带苹果签名的 iCloud 链接），网站自己生成不了。上面的做好之后，在「快捷指令」里长按它，选 Share → Copy iCloud Link，把链接填到服务器的{" "}
              <code className="font-mono text-[13px] text-ink-secondary">VAULT_IOS_SHORTCUT_URL</code>
              ，这一页就会出现「安装快捷指令」按钮，换手机或者给别人用时点一下就装好。拿到链接的人都能装，里面带着这个站点的地址。
            </p>
          </div>
        )}
      </section>

      <section className="panel flex flex-col gap-1.5 px-4 py-4 text-sm leading-relaxed text-ink-secondary">
        <h2 className="text-[15px] font-medium text-ink">Android</h2>
        <p>用 Chrome 打开这个站点，菜单里选「添加到主屏幕」。装好之后，别的 App 的分享菜单里会直接出现 Vault，不用另外装东西。</p>
      </section>
    </div>
  );
}
