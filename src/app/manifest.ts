import type { MetadataRoute } from "next";

/**
 * 装到手机主屏的清单。share_target：装好之后（Android 的 Chrome），在任何 App 里点「分享」能看到 Vault，
 * 分享的链接 / 文字落到 /share 页，确认一下就存进来。iOS 的 Safari 还不支持 share_target，那边用快捷指令（见 /mobile 页和 lib/vault/shortcut.ts）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vault",
    short_name: "Vault",
    description: "个人收藏库",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f2ed",
    theme_color: "#1f5f4a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: { action: "/share", method: "GET", params: { title: "title", text: "text", url: "url" } },
  };
}
