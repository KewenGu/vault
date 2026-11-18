import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MIN_VIDEO_KBPS, compressArgs, planCompression } from "./compress-plan";

const MB = 1024 * 1024;

describe("planCompression", () => {
  it("fits a 38-minute talk into 50 MB at 360p with mono speech audio", () => {
    // 2026-11-18 那条抖音视频：38 分 38 秒、127 MB
    const plan = planCompression(2318, 50 * MB, { sourceHeight: 1080 })!;
    expect(plan).toEqual({ height: 360, fps: 24, videoKbps: 114, audioKbps: 48, mono: true });
    // 算出来的总码率 × 时长不超过上限
    expect(((plan.videoKbps + plan.audioKbps) * 1000 * 2318) / 8).toBeLessThan(50 * MB);
  });

  it("uses a bigger picture and stereo when the video is short enough to afford it", () => {
    expect(planCompression(300, 50 * MB, { sourceHeight: 1080 })).toMatchObject({ height: 720, fps: 30, audioKbps: 96, mono: false });
    expect(planCompression(700, 50 * MB, { sourceHeight: 1080 })).toMatchObject({ height: 480, audioKbps: 64, mono: false });
  });

  it("never enlarges a small original, and drops audio settings when there is no sound", () => {
    expect(planCompression(300, 50 * MB, { sourceHeight: 480 })!.height).toBe(480);
    expect(planCompression(2318, 50 * MB, { hasAudio: false })).toMatchObject({ audioKbps: 0, mono: false });
  });

  it("gives up on videos too long to be watchable at that size", () => {
    // 两小时压到 50 MB：视频只剩 4 kbps
    expect(planCompression(7200, 50 * MB)).toBeNull();
    const edge = planCompression(3600, 50 * MB)!;
    expect(edge.videoKbps).toBeGreaterThanOrEqual(MIN_VIDEO_KBPS);
    expect(edge.height).toBe(240);
    expect(planCompression(0, 50 * MB)).toBeNull();
  });

  it("accepts a forced lower bitrate for the second attempt", () => {
    expect(planCompression(2318, 50 * MB, { videoKbps: 95 })).toMatchObject({ videoKbps: 95, height: 360 });
    expect(planCompression(2318, 50 * MB, { videoKbps: 30 })).toBeNull();
  });
});

describe("compressArgs", () => {
  it("scales by height without enlarging, caps the bitrate and makes the file streamable", () => {
    const args = compressArgs("in.mp4", "out.mp4", { height: 360, fps: 24, videoKbps: 114, audioKbps: 48, mono: true });
    expect(args.join(" ")).toContain("-vf scale=-2:'min(360,ih)',fps=24");
    expect(args.join(" ")).toContain("-c:v libx264 -preset fast -b:v 114k -maxrate 171k -bufsize 342k");
    expect(args.join(" ")).toContain("-c:a aac -b:a 48k -ac 1");
    expect(args.join(" ")).toContain("-movflags +faststart");
    expect(compressArgs("in.mp4", "out.mp4", { height: 360, fps: 24, videoKbps: 114, audioKbps: 0, mono: false })).toContain("-an");
  });
});

/**
 * 参数真的能用：拿本机的 ffmpeg 压一段自己生成的测试视频（不碰任何外来文件），看出来的文件在目标以内、是 H.264 + AAC。
 * 这里直接调 ffmpeg 命令（不走应用里的版本检查——那是为了不让旧版本处理网上下载的文件，这段素材是测试自己造的）。没装 ffmpeg 就跳过。
 */
const hasFfmpeg = (() => {
  try {
    return /libx264/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("compressArgs with a real ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-compress-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("produces a file within the target that is H.264 video and AAC audio", () => {
    const source = join(dir, "source.mp4");
    const out = join(dir, "out.mp4");
    // 60 秒 720p、画面一直在变的测试图 + 一段正弦音：高码率编出来有十几 MB
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3000k", "-c:a", "aac", "-shortest", "-y", source]);
    const target = 3 * MB;
    expect(statSync(source).size).toBeGreaterThan(target * 2);
    const plan = planCompression(60, target, { sourceHeight: 720 })!;
    execFileSync("ffmpeg", compressArgs(source, out, plan));
    expect(statSync(out).size).toBeLessThanOrEqual(target);
    expect(statSync(out).size).toBeGreaterThan(target * 0.4);
    let info = "";
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-i", out], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      info = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/Audio: aac/);
    expect(info).toMatch(new RegExp(`, \\d+x${plan.height}`));
  }, 180_000);
});
