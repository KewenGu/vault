import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { echoesPrompt, localWhisper, parseWhisperJson, transcribeLocally, verifyWhisperModel, whisperArgs, whisperPath, whisperSetupHint } from "./whisper-local";

const root = mkdtempSync(path.join(os.tmpdir(), "whisper-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 一台假机器：bin 目录里有没有 whisper 命令、模型目录里有哪些模型文件。 */
function machine(name: string, opts: { bin?: boolean; models?: string[] }) {
  const home = path.join(root, name);
  const bin = path.join(home, "bin");
  const models = path.join(home, ".cache", "whisper");
  mkdirSync(bin, { recursive: true });
  mkdirSync(models, { recursive: true });
  if (opts.bin) writeFileSync(path.join(bin, "whisper"), "");
  for (const m of opts.models ?? []) writeFileSync(path.join(models, m), "");
  return { env: { HOME: home, PATH: bin }, bin: path.join(bin, "whisper"), models };
}

describe("本机 whisper（转写口播的备用通道）", () => {
  it("拒绝损坏模型，在启动可能自动重新下载的 CLI 前停止", async () => {
    const m = machine("truncated-model", { bin: true, models: ["small.pt"] });
    const marker = path.join(path.dirname(m.bin), "started");
    writeFileSync(m.bin, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\n`, { mode: 0o700 });
    const w = localWhisper(m.env)!;
    expect(w).not.toBeNull(); // Discovery remains cheap; execution performs the full digest check.
    await expect(transcribeLocally(w, new Uint8Array([0]), 1, null)).rejects.toThrow("校验不符");
    expect(existsSync(marker)).toBe(false);
  });

  it("模型消失、目录代替文件与未知模型都明确失败", async () => {
    const m = machine("invalid-model-file", { bin: true });
    const w = { bin: m.bin, model: "small", modelDir: m.models };
    await expect(verifyWhisperModel(w)).rejects.toThrow("无法读取");
    mkdirSync(path.join(m.models, "small.pt"));
    await expect(verifyWhisperModel(w)).rejects.toThrow("无法读取");
    await expect(verifyWhisperModel({ ...w, model: "../../untrusted" })).rejects.toThrow("不受支持");
  });

  it("命令在、模型文件也在才算能用：不指定模型时用目录里最好的那个", () => {
    const m = machine("ready", { bin: true, models: ["small.pt", "large-v3-turbo.pt"] });
    expect(whisperPath(m.env)).toBe(m.bin);
    expect(localWhisper(m.env)).toEqual({ bin: m.bin, model: "turbo", modelDir: m.models });
    expect(localWhisper({ ...m.env, WHISPER_MODEL: "small" })).toMatchObject({ model: "small" });
    expect(localWhisper({ ...m.env, WHISPER_MODEL: "medium" })).toBeNull();
    expect(whisperSetupHint(m.env)).toBeNull();
  });

  it("命令装了但没有模型文件：不用它（不在后台悄悄下 1.5 GB），给一句怎么把模型下下来", () => {
    const m = machine("no-model", { bin: true });
    expect(localWhisper(m.env)).toBeNull();
    expect(whisperSetupHint(m.env)).toBe("本机装了 whisper 但没有模型文件（在终端跑一次 `whisper --model turbo 一段音频`，它会把模型下到 ~/.cache/whisper，约 1.5 GB；之后重新分析就用它转写）");
    // 模型放在别的目录
    const other = machine("other-dir", { models: ["base.pt"] });
    expect(localWhisper({ ...m.env, WHISPER_MODEL_DIR: other.models })).toMatchObject({ model: "base", modelDir: other.models });
    // 指定的目录里没有要的那个模型：下的命令也指到那个目录
    expect(whisperSetupHint({ ...m.env, WHISPER_MODEL_DIR: "/models", WHISPER_MODEL: "small" })).toContain("`whisper --model small --model_dir /models 一段音频`，它会把模型下到 /models；");
  });

  it("WHISPER_PATH 指到不存在的文件 = 当没有，不再去别处找", () => {
    const m = machine("env-path", { bin: true, models: ["tiny.pt"] });
    expect(whisperPath({ ...m.env, WHISPER_PATH: path.join(root, "nope") })).toBeNull();
    expect(localWhisper({ ...m.env, WHISPER_PATH: path.join(root, "nope") })).toBeNull();
    expect(whisperSetupHint({ ...m.env, WHISPER_PATH: path.join(root, "nope") })).toBeNull();
    expect(whisperPath({ ...m.env, WHISPER_PATH: m.bin })).toBe(m.bin);
  });

  it("命令行参数：输出 JSON 到临时目录；知道是中文才指定语言、带简体 + 标点的开场提示", () => {
    const w = { bin: "/bin/whisper", model: "turbo", modelDir: "/models" };
    const auto = whisperArgs(w, "/tmp/a/audio.mp3", "/tmp/a", null);
    expect(auto.slice(0, 9)).toEqual(["/tmp/a/audio.mp3", "--model", "turbo", "--model_dir", "/models", "--output_format", "json", "--output_dir", "/tmp/a"]);
    expect(auto).not.toContain("--language");
    // 要逐词的时间（帧格标词用）
    expect(auto[auto.indexOf("--word_timestamps") + 1]).toBe("True");
    const zh = whisperArgs(w, "/tmp/a/audio.mp3", "/tmp/a", "zh");
    expect(zh.slice(zh.indexOf("--language"), zh.indexOf("--language") + 2)).toEqual(["--language", "zh"]);
    expect(zh[zh.indexOf("--initial_prompt") + 1]).toContain("简体中文");
  });

  it("解析输出：每段的开始时间 + 文字；没人说话时编出来的话、连着重复的句子丢掉；形状不对报错", () => {
    const out = parseWhisperJson({
      language: "zh",
      text: "忽略这个字段",
      segments: [
        { id: 0, start: 0, end: 2.4, text: " 请不吝点赞 订阅 转发 打赏支持明镜与点点栏目" },
        { id: 1, start: 2.4, end: 6, text: " 磨炼这五个特质，" },
        { id: 2, start: 6, end: 9.5, text: "就完成了人生布局。" },
        { id: 3, start: 9.5, end: 12, text: "就完成了人生布局。" },
        { id: 4, start: 12, end: 13, text: "  " },
        { id: 5, end: 15, text: "第一个是专注。" },
      ],
    });
    expect(out).toEqual({
      language: "zh",
      cues: [
        { at: 2.4, end: 6, text: "磨炼这五个特质，" },
        { at: 6, end: 9.5, text: "就完成了人生布局。" },
        { at: 6, end: 15, text: "第一个是专注。" },
      ],
    });
    // --word_timestamps True 时每段带 words：都有起止才带（帧格标词用）
    const words = parseWhisperJson({
      segments: [
        { start: 0, end: 1.2, text: " 大家好", words: [{ word: "大", start: 0, end: 0.4 }, { word: "家", start: 0.4, end: 0.8, probability: 0.9 }, { word: "好", start: 0.8, end: 1.2 }] },
        { start: 1.2, end: 2, text: "再见", words: [{ word: "再", start: 1.2 }, { word: "见" }] },
      ],
    });
    expect(words.cues).toEqual([
      { at: 0, end: 1.2, text: "大家好", words: [{ at: 0, end: 0.4, text: "大" }, { at: 0.4, end: 0.8, text: "家" }, { at: 0.8, end: 1.2, text: "好" }] },
      { at: 1.2, end: 2, text: "再见" },
    ]);
    expect(parseWhisperJson({ segments: [] })).toEqual({ cues: [], language: null });
  });

  it("没人说话时把开场提示吐回来（原样或拆碎了）：整段丢掉；真台词里碰巧有提示里的字不丢", () => {
    // 2026-10-12 复刻「猫猫骑士」：没台词的镜（只有吼声、风声）真实听出来的
    expect(echoesPrompt("用简体中文，带标点符号，带标点符号。")).toBe(true);
    expect(echoesPrompt("并且使用简体中文，的符号。")).toBe(true);
    expect(echoesPrompt("以下是普通话的句子。")).toBe(true);
    expect(echoesPrompt("你说的这句话我不同意。")).toBe(false);
    expect(echoesPrompt("我是猫猫骑士，看剑！")).toBe(false);
    expect(echoesPrompt("。")).toBe(false);
    const out = parseWhisperJson({
      segments: [
        { start: 1.5, end: 3, text: "用简体中文，带标点符号。", words: [{ word: "用", start: 1.5, end: 2 }, { word: "简体中文，带标点符号。", start: 2, end: 3 }] },
        { start: 3, end: 4, text: "快跑！" },
      ],
    });
    expect(out.cues).toEqual([{ at: 3, end: 4, text: "快跑！" }]);
    expect(() => parseWhisperJson({ text: "没有 segments" })).toThrow("认不出来");
    expect(() => parseWhisperJson(null)).toThrow("认不出来");
  });
});
