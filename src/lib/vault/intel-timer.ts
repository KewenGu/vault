import "server-only";
import { checkDueWatches, intelEveryMinutes } from "./intel-service";

/**
 * 情报的定时检查：服务启动时开一个进程里的定时器（src/instrumentation.ts 调），每 5 分钟看一眼有没有到时间的来源。
 * 用进程里的定时器、不用后台任务框架：去看一次只是几个 HTTP 请求，没做完也不用接着做——服务重启了，
 * 下一次到点照样会看（每个来源记着自己上次是什么时候看的）。
 */

const TICK_MS = 5 * 60_000;
const FIRST_MS = 60_000;

type Slot = { timer?: ReturnType<typeof setInterval>; running?: boolean; lastError?: string };
const slot = ((globalThis as { __vaultIntel?: Slot }).__vaultIntel ??= {});

export async function intelTick(check: typeof checkDueWatches = checkDueWatches): Promise<void> {
  // 上一轮还没看完（来源多、存档慢）：这一轮不叠上去
  if (slot.running) return;
  slot.running = true;
  try {
    const r = await check();
    if (r.checked > 0) console.log(`情报：看了 ${r.checked} 个来源，新发现 ${r.fresh} 条${r.failed > 0 ? `，${r.failed} 个没看成` : ""}`);
    slot.lastError = undefined;
  } catch (e) {
    // 同一个错（数据库没配、表还没建）只说一次，不每 5 分钟刷一行
    const message = e instanceof Error ? e.message : String(e);
    if (message !== slot.lastError) console.error(`情报的定时检查出错: ${message}`);
    slot.lastError = message;
  } finally {
    slot.running = false;
  }
}

/** 开定时器（开过了不再开；`VAULT_INTEL_EVERY_MIN=0` 时不开）。 */
export function startIntelTimer(): boolean {
  if (slot.timer || intelEveryMinutes() <= 0) return false;
  slot.timer = setInterval(() => void intelTick(), TICK_MS);
  slot.timer.unref?.();
  setTimeout(() => void intelTick(), FIRST_MS).unref?.();
  return true;
}
