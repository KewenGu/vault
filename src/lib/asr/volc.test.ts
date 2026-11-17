import { describe, it, expect, vi, afterEach } from "vitest";
import { ASR_RESOURCES, ASR_URL, AsrNotEnabledError, asrConfig, parseAsrBody, transcribe } from "./volc";

afterEach(() => vi.unstubAllGlobals());

const notGranted = () => new Response('{"header":{"code":45000030,"message":"requested resource not granted"}}', { status: 403, headers: { "x-api-status-code": "45000030" } });
const resourceOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)["X-Api-Resource-Id"];

const ok = (body: unknown, code = "20000000") => new Response(JSON.stringify(body), { status: 200, headers: { "x-api-status-code": code, "x-api-message": "OK" } });

describe("豆包语音识别（转写口播）", () => {
  it("配置：只要 VOLC_SPEECH_API_KEY（和配音共用）", () => {
    expect(asrConfig({ VOLC_SPEECH_API_KEY: " k " })).toEqual({ apiKey: "k" });
    expect(asrConfig({})).toBeNull();
  });

  it("解析返回体：全文在 result.text，没有就拼逐句的；时长毫秒换秒；逐句都带开始时间才给 cues", () => {
    expect(parseAsrBody({ audio_info: { duration: 61500 }, result: { text: " 大家好 ", utterances: [{ text: "大家好" }] } })).toEqual({ text: "大家好", seconds: 61.5, cues: [] });
    expect(parseAsrBody({ result: { utterances: [{ text: "第一句，" }, { text: "第二句。" }] } })).toEqual({ text: "第一句，第二句。", seconds: null, cues: [] });
    expect(parseAsrBody({ result: { text: "第一句，第二句。", utterances: [{ text: "第一句，", start_time: 120, end_time: 2100 }, { text: " " }, { text: "第二句。", start_time: 65_000 }] } }).cues).toEqual([
      { at: 0.12, end: 2.1, text: "第一句，" },
      { at: 65, text: "第二句。" },
    ]);
    expect(parseAsrBody({ result: { utterances: [{ text: "有时间", start_time: 0 }, { text: "没时间" }] } }).cues).toEqual([]);
    expect(parseAsrBody({ result: [{ text: "数组形状" }] })).toEqual({ text: "数组形状", seconds: null, cues: [] });
    expect(parseAsrBody(null)).toEqual({ text: "", seconds: null, cues: [] });
  });

  it("逐字时间：一句里每个字都带起止、拼起来和整句对得上才带 words（帧格标词用）；只给了第一个字的、对不上的不带", () => {
    const w = (text: string, start: number) => ({ text, start_time: start, end_time: start + 200, confidence: 0 });
    const full = parseAsrBody({ result: { utterances: [{ text: "大家好，", start_time: 100, end_time: 900, words: [w("大", 100), w("家", 300), w("好", 500), { text: "，", start_time: 700, end_time: 700 }] }] } });
    expect(full.cues).toEqual([
      {
        at: 0.1,
        end: 0.9,
        text: "大家好，",
        words: [
          { at: 0.1, end: 0.3, text: "大" },
          { at: 0.3, end: 0.5, text: "家" },
          { at: 0.5, end: 0.7, text: "好" },
          { at: 0.7, end: 0.7, text: "，" },
        ],
      },
    ]);
    expect(parseAsrBody({ result: { utterances: [{ text: "大家好", start_time: 0, end_time: 900, words: [w("大", 0)] }] } }).cues).toEqual([{ at: 0, end: 0.9, text: "大家好" }]);
    expect(parseAsrBody({ result: { utterances: [{ text: "大家好", start_time: 0, words: [w("大", 0), w("家", 300), { text: "好" }] }] } }).cues).toEqual([{ at: 0, text: "大家好" }]);
  });

  it("解析真实返回体的形状（2026-10-05 录音文件识别 2.0 实测）：逐句带起止时间和逐字，多出来的字段不碍事", () => {
    const body = {
      audio_info: { duration: 427464 },
      result: {
        additions: { duration: "427464" },
        text: "与人之间的差距到底在哪？很多时候并不是运气。",
        utterances: [
          { start_time: 1170, end_time: 3810, text: "与人之间的差距到底在哪？", words: [{ confidence: 0, start_time: 1170, end_time: 1410, text: "与" }] },
          { start_time: 5030, end_time: 11510, text: "很多时候并不是运气。", words: [] },
        ],
      },
    };
    // words 只给了第一个字：不算逐字时间；句子的结束时间带上
    expect(parseAsrBody(body)).toEqual({
      text: "与人之间的差距到底在哪？很多时候并不是运气。",
      seconds: 427.464,
      cues: [
        { at: 1.17, end: 3.81, text: "与人之间的差距到底在哪？" },
        { at: 5.03, end: 11.51, text: "很多时候并不是运气。" },
      ],
    });
  });

  it("转写：密钥和服务项在请求头，音频 base64 放请求体；先试录音文件识别 2.0，开通了就用它、按它记账", async () => {
    const fetchMock = vi.fn(async () => ok({ audio_info: { duration: 3000 }, result: { text: "今天讲三件事" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribe({ apiKey: "key-1" }, new Uint8Array([1, 2, 3]))).toEqual({ text: "今天讲三件事", seconds: 3, cues: [], countKey: "asr_seed2_sec" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ASR_URL);
    expect(init.headers).toMatchObject({ "X-Api-Key": "key-1", "X-Api-Resource-Id": "volc.seedasr.auc", "X-Api-Sequence": "-1" });
    expect(JSON.parse(String(init.body))).toMatchObject({ audio: { data: "AQID" }, request: { model_name: "bigmodel" } });
  });

  it("2.0 没开通（403 + 45000030）就换极速版的服务项再试，按极速版记账", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>)["X-Api-Resource-Id"] === "volc.bigasr.auc_turbo" ? ok({ audio_info: { duration: 3000 }, result: { text: "今天讲三件事" } }) : notGranted()
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribe({ apiKey: "k" }, new Uint8Array([1, 2, 3]))).toMatchObject({ text: "今天讲三件事", countKey: "asr_flash_sec" });
    expect(fetchMock.mock.calls.map(resourceOf)).toEqual(["volc.seedasr.auc", "volc.bigasr.auc_turbo"]);
    // 两次送的是同一段音频
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
  });

  it("一项都没开通：每项都试过之后抛 AsrNotEnabledError，说明去哪开", async () => {
    const fetchMock = vi.fn(async () => notGranted());
    vi.stubGlobal("fetch", fetchMock);
    const err = await transcribe({ apiKey: "k" }, new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrNotEnabledError);
    expect((err as Error).message).toContain("豆包语音控制台里还没开通录音文件识别");
    expect(fetchMock).toHaveBeenCalledTimes(ASR_RESOURCES.length);
  });

  it("没有人声不算错（空文字）；其他错误码、认不出的返回体都报错，不悄悄给空", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({}, "20000003")));
    expect(await transcribe({ apiKey: "k" }, new Uint8Array([1]))).toEqual({ text: "", seconds: null, cues: [], countKey: "asr_seed2_sec" });
    // 不是「没开通」的错：直接报，不换服务项再试
    const failing = vi.fn(async () => new Response("{}", { status: 200, headers: { "x-api-status-code": "45000151", "x-api-message": "audio format invalid" } }));
    vi.stubGlobal("fetch", failing);
    await expect(transcribe({ apiKey: "k" }, new Uint8Array([1]))).rejects.toThrow("豆包语音识别 45000151: audio format invalid");
    expect(failing).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => ok({ unexpected: true })));
    await expect(transcribe({ apiKey: "k" }, new Uint8Array([1]))).rejects.toThrow(/没有 result/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    await expect(transcribe({ apiKey: "k" }, new Uint8Array([1]))).rejects.toThrow(/502/);
  });
});
