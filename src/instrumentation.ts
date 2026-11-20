/**
 * 服务启动时跑一次（Next.js 的 instrumentation 约定，见 node_modules/next/dist/docs/01-app/02-guides/instrumentation.md）。
 *
 * 把上次没跑完的后台任务重新排上队。本地模式（WORKFLOW_TARGET_WORLD=local，Docker 部署就是这个）把任务的进度存在
 * WORKFLOW_LOCAL_DATA_DIR（/data/workflow）里，但只有调用 `getWorld().start()` 才会去翻这个目录、把「排着队 / 跑到一半」
 * 的任务重新排队——框架自己不调。2026-11-19 一条视频处理到一半赶上自动更新重启了服务，没有这一步，
 * 那条内容就一直停在「正在看画面…」，直到超过 VAULT_STUCK_MINUTES 才显示成中断、要手动重试。
 *
 * 重新排队后从中断的那一步重跑（已经做完的步骤不重做）；每一步开头都会看这条内容现在的状态，重跑是安全的。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  } catch (e) {
    // 恢复不了不该拦住整个服务启动：页面照常能用，中断的内容超时后可以手动重试
    console.error(`恢复上次没跑完的后台任务失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
