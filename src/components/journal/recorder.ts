"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 在浏览器里录音（MediaRecorder）。录完交出一个文件，和选一个音频文件上传走同一条路。
 * - 麦克风只在 https 或 localhost 下能用：局域网的 http 地址（手机连电脑上的开发服务器）不行，会说清楚。
 * - 格式看浏览器：Chrome / Firefox 是 webm（opus），Safari 是 mp4。服务器那边会统一转成能播的 m4a。
 * - 录的时候数据在内存里：录完之前关页面、刷新，这一段就没了。手机上屏幕锁了 / 切到别的 App 录音可能停，
 *   所以录的时候请求屏幕常亮（浏览器不给也照样录）。
 */

const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg" };

export type Recorder = {
  status: "idle" | "starting" | "recording";
  /** 录了多少秒 */
  seconds: number;
  error: string | null;
  start: () => void;
  /** 录完：交出文件 */
  stop: () => void;
  /** 不要了 */
  cancel: () => void;
};

const pad = (n: number) => String(n).padStart(2, "0");

function reason(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "没有麦克风的权限：在浏览器的网站设置里允许这个网站用麦克风，再点一次";
  if (name === "NotFoundError") return "没找到麦克风";
  if (name === "NotReadableError") return "麦克风被别的程序占着";
  return `录音没开始：${e instanceof Error ? e.message : String(e)}`;
}

export function useRecorder(onDone: (file: File) => void, maxSeconds = 3600): Recorder {
  const [status, setStatus] = useState<Recorder["status"]>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<{ recorder: MediaRecorder; stream: MediaStream; timer: ReturnType<typeof setInterval>; keep: boolean; lock: { release: () => Promise<void> } | null } | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  const finish = useCallback((keep: boolean) => {
    const now = live.current;
    if (!now) return;
    now.keep = keep;
    if (now.recorder.state !== "inactive") now.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (live.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(window.isSecureContext ? "这个浏览器不支持录音：用系统的录音机录好，再点「音频文件」传上来" : "录音要在 https 或 localhost 下才能用（局域网的 http 地址不行）：先用系统的录音机录好，再点「音频文件」传上来");
      return;
    }
    setStatus("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus("idle");
      setError(reason(e));
      return;
    }
    const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("idle");
      setError(reason(e));
      return;
    }
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= maxSeconds) finish(true);
    }, 500);
    const session = { recorder, stream, timer, keep: true, lock: null as { release: () => Promise<void> } | null };
    live.current = session;
    (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((lock) => {
        if (live.current === session) session.lock = lock;
        else void lock.release();
      })
      .catch(() => {});
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void session.lock?.release().catch(() => {});
      if (live.current === session) live.current = null;
      setStatus("idle");
      setSeconds(0);
      if (!session.keep) return;
      const type = (recorder.mimeType || mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) return setError("什么都没录到，再试一次");
      const now = new Date();
      done.current(new File([blob], `录音 ${pad(now.getHours())}${pad(now.getMinutes())}.${EXT[type] ?? "webm"}`, { type }));
    };
    recorder.start(1000);
    setSeconds(0);
    setStatus("recording");
  }, [finish, maxSeconds]);

  // 离开页面：不要了（麦克风放掉）
  useEffect(() => () => finish(false), [finish]);

  return { status, seconds, error, start: () => void start(), stop: () => finish(true), cancel: () => finish(false) };
}
