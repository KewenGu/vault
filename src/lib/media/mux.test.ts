import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runFfmpeg, downloadRemoteToFile } = vi.hoisted(() => ({ runFfmpeg: vi.fn(), downloadRemoteToFile: vi.fn() }));
vi.mock("./ffmpeg", async (original) => ({ ...(await original<typeof import("./ffmpeg")>()), runFfmpeg }));
vi.mock("./files", async (original) => ({ ...(await original<typeof import("./files")>()), downloadRemoteToFile }));

import { muxAudioInto } from "./mux";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "vault-mux-"));
  await writeFile(path.join(tmp, "source.mp4"), "只有画面");
  runFfmpeg.mockReset();
  downloadRemoteToFile.mockReset().mockImplementation(async (_file: unknown, dest: string) => {
    await writeFile(dest, "声音");
    return 6;
  });
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe("把单独的声音文件合进视频", () => {
  it("下声音、不重新编码地合成一个文件，换掉原来的，返回新的大小", async () => {
    runFfmpeg.mockImplementation(async (args: string[]) => {
      await writeFile(args[args.length - 1], "画面和声音合在一起");
      return "";
    });
    const video = path.join(tmp, "source.mp4");
    const size = await muxAudioInto(video, { url: "https://v.redd.it/abc/CMAF_AUDIO_128.mp4" }, tmp);
    expect(downloadRemoteToFile.mock.calls[0][0]).toEqual({ url: "https://v.redd.it/abc/CMAF_AUDIO_128.mp4" });
    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(" ")).toContain(`-i ${video} -i ${path.join(tmp, "sound.mp4")} -map 0:v:0 -map 1:a:0 -c copy`);
    expect(await readFile(video, "utf8")).toBe("画面和声音合在一起");
    expect(size).toBe(Buffer.byteLength("画面和声音合在一起"));
  });

  it("声音没下下来、ffmpeg 合不成：抛错，原来的视频不动", async () => {
    const video = path.join(tmp, "source.mp4");
    downloadRemoteToFile.mockRejectedValueOnce(new Error("下载文件失败（403）"));
    await expect(muxAudioInto(video, { url: "https://v.redd.it/abc/a.mp4" }, tmp)).rejects.toThrow("下载文件失败（403）");
    expect(runFfmpeg).not.toHaveBeenCalled();
    runFfmpeg.mockRejectedValue(new Error("这台机器上没有 ffmpeg"));
    await expect(muxAudioInto(video, { url: "https://v.redd.it/abc/a.mp4" }, tmp)).rejects.toThrow("没有 ffmpeg");
    expect(await readFile(video, "utf8")).toBe("只有画面");
  });
});
