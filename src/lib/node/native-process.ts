import "server-only";
import type { ChildProcess } from "node:child_process";
import { spawn } from "./spawn";

const activeChildren = new Set<ChildProcess>();
const stoppedChildren = new WeakSet<ChildProcess>();
function stopAllChildren(): void {
  for (const child of activeChildren) stopNativeProcess(child);
}

// Native parsers do not need provider/database credentials or runtime injection hooks.
// This is environment minimization, not a filesystem or network sandbox.
const ENVIRONMENT_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "PATHEXT",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "FONTCONFIG_FILE", "FONTCONFIG_PATH", "XDG_CACHE_HOME",
  "CUDA_VISIBLE_DEVICES", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS",
] as const;

export function nativeEnvironment(source: Partial<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV ?? "production", PYTHONNOUSERSITE: "1" };
  for (const key of ENVIRONMENT_KEYS) if (source[key] !== undefined) result[key] = source[key];
  return result;
}

/** User-site installs are deliberately excluded from the isolated child environment. */
export function nativePythonSetupError(tool: "whisper" | "yt-dlp", stderr: string): Error | null {
  if (!/(?:ModuleNotFoundError: No module named|ImportError:)/.test(stderr)) return null;
  const setting = tool === "whisper" ? "WHISPER_PATH" : "YTDLP_PATH";
  return new Error(`${tool} 的 Python 依赖无法加载；原生工具不读取 pip --user 包，请用独立 venv / pipx 安装，并把 ${setting} 指向该环境的可执行文件（见 scripts/native-tools/README.md）`);
}

/** Each POSIX invocation owns a process group, including FFmpeg started by Python tools. */
export function spawnNative(command: string, args: string[], env: NodeJS.ProcessEnv = nativeEnvironment()) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  if (activeChildren.size === 0) process.once("exit", stopAllChildren);
  activeChildren.add(child);
  const finish = () => {
    // 'exit' precedes 'close': descendants can still own the inherited output pipes.
    stopNativeProcess(child);
    activeChildren.delete(child);
    if (activeChildren.size === 0) process.removeListener("exit", stopAllChildren);
  };
  child.once("exit", finish);
  child.once("error", finish);
  return child;
}

/** Only signal the group created for this child; never enumerate or kill other processes. */
export function stopNativeProcess(child: ChildProcess): void {
  if (stoppedChildren.has(child)) return;
  stoppedChildren.add(child);
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
    }
  } else {
    // Windows has no POSIX process groups. A deployment there needs a Job Object worker.
    child.kill("SIGKILL");
  }
}
