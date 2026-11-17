import type { Metadata } from "next";
import Link from "next/link";
import { ShareForm } from "./share-form";

export const metadata: Metadata = { title: "存入" };

/**
 * 「分享到 Vault」落在这里（手机主屏装了之后，系统分享菜单把 title / text / url 带过来）。
 * 不直接存，先让用户确认一下：这是个带参数就能打开的地址，别的网站可以放一个指向它的链接，
 * 自动存的话等于谁都能往你的库里塞东西。顺便也是写「为什么存」的时机。
 */
export default async function SharePage({ searchParams }: { searchParams: Promise<{ title?: string; text?: string; url?: string }> }) {
  const sp = await searchParams;
  // 各家 App 把链接放在哪个参数里不一样（有的放 url，有的整段塞进 text）：都拼起来，交给存入逻辑去认
  const input = [sp.url, sp.text, sp.url || sp.text ? "" : sp.title].filter(Boolean).join("\n").trim();
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">存入 Vault</h1>
      {input ? (
        <ShareForm input={input} title={sp.title ?? ""} />
      ) : (
        <p className="panel px-5 py-10 text-center text-sm text-ink-muted">
          没有收到要存的内容。
          <Link href="/" className="ml-1 text-accent hover:underline">
            回收藏库
          </Link>
        </p>
      )}
    </div>
  );
}
