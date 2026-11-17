import { readFileSync } from "node:fs";

/**
 * 这个进程还在不在跑。被杀掉、但没人收尸的进程（容器里 1 号进程不是 init 时，孤儿进程会一直留着僵尸条目）算不在了：
 * 对僵尸 `process.kill(pid, 0)` 照样成功，只看它会把「已经杀掉」误判成「还活着」。
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return true; // 没有 /proc（macOS）：信号发得出去就算在
  }
}
