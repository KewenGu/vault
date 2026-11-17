import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // 手机在同一个 Wi-Fi 下用电脑的局域网地址开 dev server：Next 16 默认只放行 localhost。只影响开发模式，只放行私有地址段。
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`)],
  // 文件不经过 Next 服务器（浏览器直传存储桶，见 lib/vault/upload.ts），这里只放宽粘贴长文字的 server action。
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // sharp 是原生模块，不打包
  serverExternalPackages: ["sharp"],
};

export default withWorkflow(nextConfig);
