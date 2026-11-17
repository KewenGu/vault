import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { contactSheets, everyStep, frameBudget, frameTimes, motionWindows, overviewStep, parseSceneScores, pickCuts, planFrames } from "./frames";

describe("看片：抽帧时间点", () => {
  it("抽帧时间点：开头 3 秒密（钩子），后面全片均匀；短视频自然少几张", () => {
    expect(frameTimes(60)).toEqual([0.2, 1.5, 3, 13.3, 23.7, 34, 44.3, 54.6]);
    expect(frameTimes(2)).toEqual([0.2, 1.5]);
    expect(frameTimes(4.5)).toEqual([0.2, 1.5, 3, 3.9]);
    expect(frameTimes(0)).toEqual([0]);
    expect(frameTimes(NaN)).toEqual([0]);
    const long = frameTimes(1800, 8);
    expect(long).toHaveLength(8);
    expect(long.at(-1)!).toBeLessThan(1800);
    // 相邻两帧至少隔 0.8 秒
    for (const d of [3.4, 3.9, 5, 12]) {
      const t = frameTimes(d);
      for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("抽多少帧跟着时长走：一分钟内 8 张，3 分钟内 12，10 分钟内 16，再长 20——长视频中间讲了什么也要看得到", () => {
    expect([10, 60, 61, 180, 181, 427, 600, 601, 3600].map(frameBudget)).toEqual([8, 8, 12, 12, 16, 16, 16, 20, 20]);
    expect(frameBudget(NaN)).toBe(8);
    const t = frameTimes(427);
    expect(t).toHaveLength(16);
    expect(t.slice(0, 3)).toEqual([0.2, 1.5, 3]);
    // 后面 13 张在全片里均匀取：相邻两张隔半分钟左右，最后一张离结尾不远
    for (let i = 4; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(31.4, 0);
    expect(t.at(-1)!).toBeGreaterThan(400);
    expect(frameTimes(1800)).toHaveLength(20);
  });
});

describe("收藏夹：切点和帧格（2026-10-11）", () => {
  it("解析 ffmpeg 的 scene 分数文件：时间取到 0.1 秒、同一个 0.1 秒留分高的、开头 0.1 秒内的和 0 分的不算、按时间排", () => {
    const text = ["frame:0    pts:25600   pts_time:2", "lavfi.scene_score=0.694200", "frame:1    pts:64000   pts_time:5.06", "lavfi.scene_score=0.891420", "frame:2 pts:64100 pts_time:5.09", "lavfi.scene_score=0.4", "frame:3 pts:1 pts_time:0.04", "lavfi.scene_score=0.9", "frame:4 pts:2 pts_time:6", "lavfi.scene_score=0.000000", ""].join("\n");
    expect(parseSceneScores(text)).toEqual([
      { at: 2, score: 0.694 },
      { at: 5.1, score: 0.891 },
    ]);
    expect(parseSceneScores("")).toEqual([]);
  });

  it("挑切点：过 0.3 的都算；不到 0.3 但比前后一秒高出 4 倍以上的尖也算（雾里的硬切）；连着一片高分的抖动不算；0.5 秒内留分高的；超过 300 个留分高的", () => {
    // 每 0.1 秒一个分数：底噪 0.02，2.2 秒硬切 0.34，7.1 秒雾里的硬切 0.24，12.5 / 12.9 秒一次切镜连着两个尖（留高的），14–15 秒打斗抖动一片 0.13
    const series = Array.from({ length: 199 }, (_, i) => ({ at: Math.round((i + 2) * 1) / 10, score: 0.02 }));
    const set = (at: number, score: number) => (series.find((s) => s.at === at)!.score = score);
    set(2.2, 0.343);
    set(7.1, 0.239);
    set(12.5, 0.254);
    set(12.9, 0.184);
    for (let t = 140; t <= 150; t++) set(t / 10, 0.13);
    set(14.5, 0.16);
    expect(pickCuts(series)).toEqual([
      { at: 2.2, score: 0.343 },
      { at: 7.1, score: 0.239 },
      { at: 12.5, score: 0.254 },
    ]);
    // 0.5 秒内两个过线的：留高的
    const close = series.map((s) => ({ ...s }));
    close.find((s) => s.at === 2.5)!.score = 0.5;
    expect(pickCuts(close).map((c) => c.at)).toEqual([2.5, 7.1, 12.5]);
    expect(pickCuts([])).toEqual([]);
    const many = pickCuts(Array.from({ length: 400 }, (_, i) => ({ at: (i + 1) * 0.6, score: 0.3 + (i % 50) / 100 })));
    expect(many).toHaveLength(300);
    expect(many.every((c, i) => i === 0 || c.at > many[i - 1].at)).toBe(true);
  });

  it("动作最快的几段（查身体部位变形）：0.7 秒窗口把没到切镜线的分数加起来，挑最高的两段、互不重叠、按时间排；挨着切点的、太平静的不要", () => {
    // 6 秒一镜，底噪 0.003；2.0–2.6 秒龙扑下来 0.015，4.0–4.6 秒翻滚 0.02，5.2 秒切镜 0.5（前后 0.15 秒内的窗口不算）
    const series = Array.from({ length: 59 }, (_, i) => ({ at: Math.round(i + 2) / 10, score: 0.003 }));
    const set = (at: number, score: number) => (series.find((s) => s.at === at)!.score = score);
    for (let t = 20; t <= 26; t++) set(t / 10, 0.015);
    for (let t = 40; t <= 46; t++) set(t / 10, 0.02);
    set(5.2, 0.5);
    const cuts = pickCuts(series);
    expect(cuts.map((c) => c.at)).toEqual([5.2]);
    const w = motionWindows(series, cuts, 6.04);
    expect(w.map((x) => [x.from, x.to])).toEqual([
      [1.9, 2.6],
      [3.9, 4.6],
    ]);
    expect(w[1].energy).toBe(0.14);
    // 每段都不碰切点：切点前后 0.15 秒内没有窗口
    expect(motionWindows(series, cuts, 6.04, 10).every((x) => x.to < 5.05 || x.from > 5.35)).toBe(true);
    // 太平静（全是底噪）：一段都不挑；窗口不超过结尾
    expect(motionWindows(series.map((s) => ({ ...s, score: 0.003 })), [], 6.04)).toEqual([]);
    expect(motionWindows([{ at: 0.5, score: 0.2 }], [], 0.6)).toEqual([]);
  });

  it("有切点的抽帧计划：开头三张照旧（附近有切点就换成切后那一帧）、每个切点后 0.3 秒一张、不够名额留分高的、剩下的名额劈最长的空档；没切点 = 原来的固定时间点", () => {
    expect(planFrames(60, [])).toEqual(frameTimes(60).map((at) => ({ at, cut: false })));
    expect(planFrames(0, [{ at: 1, score: 1 }])).toEqual([{ at: 0, cut: false }]);
    // 两个切点、60 秒、8 张：0.2 / 1.5 / 3 + 切后 10.3 / 30.3 + 补 45.1、22.6 以及再劈 … 相邻至少隔 0.8 秒，一共 8 张、按时间排
    const plan = planFrames(60, [{ at: 10, score: 0.8 }, { at: 30, score: 0.6 }]);
    expect(plan).toHaveLength(8);
    expect(plan.filter((p) => p.cut).map((p) => p.at)).toEqual([10.3, 30.3]);
    expect(plan.slice(0, 3)).toEqual([
      { at: 0.2, cut: false },
      { at: 1.5, cut: false },
      { at: 3, cut: false },
    ]);
    for (let i = 1; i < plan.length; i++) expect(plan[i].at - plan[i - 1].at).toBeGreaterThanOrEqual(0.8);
    // 空档补在最长的那段中间：30.3–59.8 先劈
    expect(plan.map((p) => p.at)).toContain(45.1);
    // 切点太多（20 个、8 张）：钩子 3 张 + 分最高的 5 个切点，不再补空档
    const cuts = Array.from({ length: 20 }, (_, i) => ({ at: 5 + i * 2.5, score: i % 2 ? 0.9 : 0.4 }));
    const dense = planFrames(60, cuts);
    expect(dense).toHaveLength(8);
    expect(dense.filter((p) => p.cut)).toHaveLength(5);
    expect(dense.filter((p) => p.cut).every((p) => cuts.find((c) => c.at === p.at - 0.3)?.score === 0.9)).toBe(true);
    // 开头 1.5 秒附近有切点：那一张换成切后的（1.2 + 0.3 = 1.5），算切镜
    expect(planFrames(20, [{ at: 1.2, score: 0.7 }]).slice(0, 3)).toEqual([
      { at: 0.2, cut: false },
      { at: 1.5, cut: true },
      { at: 3, cut: false },
    ]);
    // 7 秒、切在 2 和 5：0.2、1.5 照旧，3 秒那张换成切后的 2.3（隔 1.5 秒 0.8 整，不算太近——浮点差 0.7999… 不能直接比），5.3 是另一刀；空档都不到 4 秒，不补
    expect(planFrames(7, [{ at: 2, score: 0.69 }, { at: 5, score: 0.89 }])).toEqual([
      { at: 0.2, cut: false },
      { at: 1.5, cut: false },
      { at: 2.3, cut: true },
      { at: 5.3, cut: true },
    ]);
    // 镜头很短（切点挨着）：代表帧取中点，不会跑进下一个镜头；下一个切点的代表帧（5.7）离它不到 0.8 秒，不抽
    expect(planFrames(20, [{ at: 5, score: 0.9 }, { at: 5.4, score: 0.9 }]).filter((p) => p.cut).map((p) => p.at)).toEqual([5.2]);
    expect(planFrames(20, [{ at: 5, score: 0.9 }, { at: 6.4, score: 0.9 }]).filter((p) => p.cut).map((p) => p.at)).toEqual([5.3, 6.7]);
  });

  it("帧格：竖版 4×2、横版 3×3，每格下面两行字；多于一张的分页；输出是 JPEG、尺寸对", async () => {
    const frame = async (color: string) => new Uint8Array(await sharp({ create: { width: 90, height: 160, channels: 3, background: color } }).jpeg().toBuffer());
    const colors = ["#c03528", "#2c5877", "#3b7a5c", "#9a6b1f", "#7c6e9e", "#b0664a", "#5e8a8c", "#71717a", "#18181b"];
    const tiles = await Promise.all(colors.map(async (c, i) => ({ at: i * 2.5, cut: i % 3 === 1, data: await frame(c), speech: i === 0 ? null : { before: "…大家好今", now: "天", after: "讲三件事…" } })));
    const sheets = await contactSheets(tiles, true);
    expect(sheets.map((s) => [s.tiles, s.from, s.to])).toEqual([
      [8, 0, 17.5],
      [1, 20, 20],
    ]);
    const meta = await sharp(Buffer.from(sheets[0].data)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1040, 1016]);
    expect([sheets[0].width, sheets[0].height]).toEqual([1040, 1016]);
    // 只有一行时高度也只有一行
    const one = await sharp(Buffer.from(sheets[1].data)).metadata();
    expect([one.width, one.height]).toEqual([1040, 512]);
    // 第一格的画面在它的位置上（红色格子的中间是红的）
    const px = await sharp(Buffer.from(sheets[0].data)).extract({ left: 8 + 125, top: 8 + 222, width: 1, height: 1 }).raw().toBuffer();
    expect(px[0]).toBeGreaterThan(150);
    expect(px[2]).toBeLessThan(90);
    // 横版 3×3
    const wide = await contactSheets(tiles.slice(0, 9), false);
    expect(wide).toHaveLength(1);
    expect([wide[0].width, wide[0].height]).toEqual([1040, 755]);
    expect(await contactSheets([], true)).toEqual([]);
  });
});

describe("看片：均匀抽帧", () => {
  it("每秒一帧：第 0.5、1.5…秒，不超过结尾前 0.1 秒；上一帧到这一帧之间切过镜的标「切」；太短的给一帧", () => {
    expect(everyStep(8.1, []).map((f) => f.at)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
    expect(everyStep(4, [{ at: 2.3, score: 0.9 }, { at: 0.2, score: 0.5 }])).toEqual([
      { at: 0.5, cut: true },
      { at: 1.5, cut: false },
      { at: 2.5, cut: true },
      { at: 3.5, cut: false },
    ]);
    expect(everyStep(0.4, [])).toEqual([{ at: 0, cut: false }]);
  });

  it("每镜看片每秒 4 帧（龙头 0.25 秒里变成爪子，每秒一帧看不出来）：0.125、0.375…；切点落在哪两帧之间就标后一帧", () => {
    const f = everyStep(2, [{ at: 1.2, score: 0.5 }], 4);
    expect(f.map((x) => x.at)).toEqual([0.125, 0.375, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875]);
    expect(f.filter((x) => x.cut).map((x) => x.at)).toEqual([1.375]);
    expect(everyStep(6, [], 4)).toHaveLength(24);
  });

  it("全片一览：一分钟以内每秒一帧，再长的放稀到 60 格以内", () => {
    expect(overviewStep(30)).toBe(1);
    expect(overviewStep(60)).toBe(1);
    expect(overviewStep(61)).toBe(2);
    expect(overviewStep(600)).toBe(10);
    expect(everyStep(600, [], 1 / overviewStep(600)).length).toBeLessThanOrEqual(60);
  });
});
