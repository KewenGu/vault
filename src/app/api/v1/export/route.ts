import { exportArchive, exportName } from "@/lib/vault/export";
import { withSession } from "../respond";

/**
 * 整库导出：一个 zip（`application/zip`，边生成边发）。里面是每条内容的 Markdown、自己建的导图、问过的问题、日记，
 * 加上每张表的 JSON；不包含图片 / 视频 / 音频这些文件本身，只有路径。包里的 README.md 写着有什么、没有什么、这次没导出成的。
 * 不调模型。内容多的时候要等一会儿（一页一页从数据库读）。
 */
export async function GET(request: Request) {
  return withSession(request, async (session) => {
    const now = new Date();
    const chunks = exportArchive(session.db, session.user.id, now);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await chunks.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (e) {
          // 已经开始发了，改不了状态码：让下载断掉（浏览器会显示失败），不发一个看起来完整的坏包
          console.error(`导出出错 user=${session.user.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          controller.error(e);
        }
      },
      // 浏览器取消了下载：不再往下读数据库
      async cancel() {
        await chunks.return();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${exportName(now)}.zip"`,
        "cache-control": "no-store",
      },
    });
  });
}
