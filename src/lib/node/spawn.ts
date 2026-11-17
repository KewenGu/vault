import "server-only";
import * as childProcess from "node:child_process";

/**
 * 起子进程用这个，不要直接从 node:child_process 导入 spawn。
 * Turbopack 会分析 spawn(<路径>)：路径是动态的（ffmpeg / yt-dlp / whisper 都是运行时在 PATH 里找到的），它就当成
 * 「可能是项目里的任何文件」，把整个项目目录追踪进这个函数的产物（next build 报 "whole project was traced
 * unintentionally"，部署后函数白白多几十 MB）。经 Reflect.get 拿到的 spawn 它看不出来，就不追踪了。
 */
export const spawn: typeof childProcess.spawn = Reflect.get(childProcess, "spawn");
