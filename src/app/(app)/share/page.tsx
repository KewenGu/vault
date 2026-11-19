import type { Metadata } from "next";
import Link from "next/link";
import { decodeSharedText } from "@/lib/vault/shortcut";
import { ShareForm } from "./share-form";

export const metadata: Metadata = { title: "存入" };

/**
 * 「分享到 Vault」落在这里（手机主屏装了之后，系统分享菜单把 title / text / url 带过来）。
 * iPhone 上没有这个分享入口，用快捷指令打开同一个地址，内容放在 b64 参数里（为什么是 Base64 见 lib/vault/shortcut.ts）。
 * 不直接存，先让用户确认一下：这是个带参数就能打开的地址，别的网站可以放一个指向它的链接，
 * 自动存的话等于谁都能往你的库里塞东西。顺便也是写「为什么存」的时机。
 */
export default async function SharePage({ searchParams }: { searchParams: Promise<{ title?: string; text?: string; url?: string; b64?: string }> }) {
  const raw = await searchParams;
  const decoded = raw.b64 ? decodeSharedText(raw.b64) : null;
  const sp = { ...raw, text: decoded ?? raw.text };
  // 带了 b64 却解不开：是收到了但读不出来，和「没收到」分开说
  const unreadable = !!raw.b64 && decoded === null;
  // 各家 App 把链接放在哪个参数里不一样（有的放 url，有的整段塞进 text）：都拼起来，交给存入逻辑去认
  const input = [sp.url, sp.text, sp.url || sp.text ? "" : sp.title].filter(Boolean).join("\n").trim();
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">存入 Vault</h1>
      {input ? (
        <ShareForm input={input} title={sp.title ?? ""} />
      ) : (
        <p className="panel px-5 py-10 text-center text-sm text-ink-muted">
          {unreadable ? "收到了内容，但没能解开：快捷指令里 Base64 Encode 的 Line Breaks 要选 None。" : "没有收到要存的内容。"}
          <Link href="/" className="ml-1 text-accent hover:underline">
            回收藏库
          </Link>
        </p>
      )}
    </div>
  );
}
