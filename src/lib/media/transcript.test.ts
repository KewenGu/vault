import { describe, it, expect } from "vitest";
import { clock, clockTenths, cuesToText, frameCaption, frameNote, likelyChinese, parseClock, parseTranscript, speechAt, speechLabel, speechUnits } from "./transcript";

describe("收藏夹：带时间的口播文字", () => {
  it("秒 ↔ 分:秒：过一小时带上小时；文字里取第一个时间，没有时间是 null", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(-3)).toBe("0:00");
    expect(parseClock("1:05")).toBe(65);
    expect(parseClock("0:20–0:45")).toBe(20);
    expect(parseClock("约 12:30 处")).toBe(750);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("第 3 张图")).toBeNull();
    expect(parseClock("")).toBeNull();
    // 比分、比例这类不是时间的写法（秒位超过 59）不认
    expect(parseClock("16:99")).toBeNull();
  });

  it("一句句 → 段落：到句末且够长（约 300 字或 30 秒）换段，每段开头是它开始的时间", () => {
    const cues = Array.from({ length: 12 }, (_, i) => ({ at: i * 8, text: `第 ${i + 1} 句话说完了。` }));
    expect(cuesToText(cues).split("\n")).toEqual([
      "[0:00] 第 1 句话说完了。第 2 句话说完了。第 3 句话说完了。第 4 句话说完了。第 5 句话说完了。",
      "[0:40] 第 6 句话说完了。第 7 句话说完了。第 8 句话说完了。第 9 句话说完了。第 10 句话说完了。",
      "[1:20] 第 11 句话说完了。第 12 句话说完了。",
    ]);
  });

  it("没有标点的识别结果（中文语音识别常见）：等不到句末，按 45 秒换段；空白句跳过", () => {
    const cues = [{ at: 0, text: "大家好" }, { at: 20, text: " " }, { at: 30, text: "今天讲五个特质" }, { at: 50, text: "第一个是专注" }, { at: 70, text: "第二个是耐心" }];
    expect(cuesToText(cues).split("\n")).toEqual(["[0:00] 大家好今天讲五个特质", "[0:50] 第一个是专注第二个是耐心"]);
    expect(cuesToText([])).toBe("");
    expect(cuesToText(cues, 9)).toBe("[0:00] 大家");
  });

  it("读回来：每段的时间和文字分开；没有时间的旧数据整行当一段", () => {
    expect(parseTranscript("[0:00] 大家好。\n[1:05] 第二点。\n\n[1:02:03] 结尾")).toEqual([
      { at: 0, text: "大家好。" },
      { at: 65, text: "第二点。" },
      { at: 3723, text: "结尾" },
    ]);
    expect(parseTranscript("以前存的口播文字，没有时间")).toEqual([{ at: null, text: "以前存的口播文字，没有时间" }]);
    expect(parseTranscript("")).toEqual([]);
  });

  it("一帧画面的说明：开头几秒精确到 0.1 秒（钩子），后面和口播文字用同一种时间写法", () => {
    expect(frameCaption(0.2)).toBe("视频第 0.2 秒");
    expect(frameCaption(9.9)).toBe("视频第 9.9 秒");
    expect(frameCaption(10)).toBe("视频 0:10");
    expect(frameCaption(65.4)).toBe("视频 1:05");
  });

  it("口播大概率是不是中文：国内平台直接算；别的平台看标题和文案（日文、英文、太短的不算）", () => {
    expect(likelyChinese("douyin", "")).toBe(true);
    expect(likelyChinese("xiaohongshu", "How I plan my week")).toBe(true);
    expect(likelyChinese("youtube", "磨炼这5个特质就完成了人生布局")).toBe(true);
    expect(likelyChinese("youtube", "【Vlog】我的 morning routine 分享 https://example.com/very-long-link")).toBe(true);
    expect(likelyChinese("tiktok", "How I plan my week")).toBe(false);
    expect(likelyChinese("youtube", "朝のルーティン紹介")).toBe(false);
    expect(likelyChinese("web", "好")).toBe(false);
    expect(likelyChinese("x", "")).toBe(false);
  });
});

describe("收藏夹：锚在词上（2026-10-11）", () => {
  it("时间多一位：切点、帧格上用 0:03.2 这种写法", () => {
    expect([clockTenths(3.24), clockTenths(65), clockTenths(0.2)]).toEqual(["0:03.2", "1:05.0", "0:00.2"]);
  });

  it("没有逐词时间的句子均摊到它的时长上：中文一字一个单位、英文一词一个，标点跟着前面的；结束时间是识别给的 end，没有就下一句的开始", () => {
    const units = speechUnits([
      { at: 0, end: 2, text: "大家好，today 讲三件事。" },
      { at: 10, text: "第二句" },
    ]);
    expect(units.map((u) => u.text)).toEqual(["大", "家", "好，", "today", "讲", "三", "件", "事。", "第", "二", "句"]);
    expect(units[0]).toEqual({ at: 0, end: 0.24, text: "大" });
    expect(units[7].end).toBe(2);
    // 最后一句没有结束时间：按字数估（一个字 0.25 秒）
    expect(units[8]).toEqual({ at: 10, end: 10.25, text: "第" });
    expect(units[10].end).toBe(10.75);
    // 下一句开得太晚（中间是长停顿）：这句不会被拉到几十秒长，最多估的两倍
    const stretched = speechUnits([{ at: 0, text: "你好" }, { at: 30, text: "再见" }]);
    expect(stretched[1].end).toBe(1);
  });

  it("有逐词时间的直接用", () => {
    const units = speechUnits([{ at: 0, text: "大家好", words: [{ at: 0, end: 0.3, text: "大" }, { at: 0.3, end: 0.6, text: "家" }, { at: 0.6, end: 1, text: "好" }] }]);
    expect(units).toEqual([
      { at: 0, end: 0.3, text: "大" },
      { at: 0.3, end: 0.6, text: "家" },
      { at: 0.6, end: 1, text: "好" },
    ]);
  });

  it("第 t 秒说到哪个词：正说到的词和前后各几个字，一共约 span 个；超出的两头加 …；离最近的话超过 1 秒是 null；1 秒内的停顿 now 是空", () => {
    const text = "大家好今天讲三件事第一件事是专注第二件是耐心";
    const cues = [{ at: 1, text, words: Array.from(text).map((t, i) => ({ at: 1 + i * 0.25, end: 1.25 + i * 0.25, text: t })) }];
    expect(speechAt(cues, 2.1, 8)).toEqual({ before: "…家好今", now: "天", after: "讲三件事…" });
    expect(speechLabel(speechAt(cues, 2.1, 8)!)).toBe("…家好今【天】讲三件事…");
    // 开头：前面不够，让给后面
    expect(speechAt(cues, 1, 6)).toEqual({ before: "", now: "大", after: "家好今天讲…" });
    // 结尾：后面没有了
    expect(speechAt(cues, 6.3, 6)).toEqual({ before: "…第二件是耐", now: "心", after: "" });
    // 还没开口 / 说完很久：null；刚说完 1 秒内算停顿
    expect(speechAt(cues, 0.5, 8)).toEqual({ before: "", now: "", after: "大家好今天讲三件…" });
    expect(speechAt(cues, -0.5, 8)).toBeNull();
    expect(speechAt(cues, 9, 8)).toBeNull();
    expect(speechAt(cues, 7.2, 8)).toEqual({ before: "…专注第二件是耐心", now: "", after: "" });
    expect(speechLabel(speechAt(cues, 7.2, 8)!)).toBe("…专注第二件是耐心｜");
    // 前后文只取 5 秒以内的：下一句隔了半分钟，不会被拉进来
    const far = [{ at: 0, end: 1, text: "你好" }, { at: 40, end: 41, text: "再见" }];
    expect(speechAt(far, 0.3, 8)).toEqual({ before: "", now: "你", after: "好" });
    expect(speechAt(far, 1.5, 8)).toEqual({ before: "你好", now: "", after: "" });
    // 句子中间的停顿：两句之间
    const gap = [
      { at: 0, end: 1, text: "你好" },
      { at: 1.6, end: 2.6, text: "再见" },
    ];
    expect(speechAt(gap, 1.3, 8)).toEqual({ before: "你好", now: "", after: "再见" });
    expect(speechAt([], 1)).toBeNull();
    // 英文按词，词之间留空格（放不下的那个词变成 …）
    const en = [{ at: 0, end: 2, text: "Hello there, my friend." }];
    expect(speechAt(en, 1.1, 14)).toEqual({ before: "…there,", now: "my", after: "friend." });
    expect(speechLabel(speechAt(en, 1.1, 14)!)).toBe("…there, 【my】 friend.");
    expect(speechLabel({ before: "你好", now: "", after: "再见" })).toBe("你好｜再见");
  });

  it("一帧给模型的说明：时间 + 刚切镜 + 说到的词；没有的不写", () => {
    expect(frameNote({ at: 1.5 })).toBe("视频第 1.5 秒");
    expect(frameNote({ at: 65.4, cut: true, words: "…今【天】讲…" })).toBe("视频 1:05 · 刚切镜 · 说到：…今【天】讲…");
    expect(frameNote({ at: 3, cut: false, words: null })).toBe("视频第 3 秒");
  });
});
