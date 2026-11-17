import { describe, it, expect, vi, afterEach } from "vitest";
import { OPENAI_ASR_MAX_BYTES, OPENAI_ASR_URL, openaiAsrConfig, openaiAsrForm, transcribeWithOpenAI } from "./openai";

afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const seg = (start: number, text: string) => ({ id: 0, seek: 0, start, end: start + 2, text, tokens: [], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.2, no_speech_prob: 0.01 });

describe("OpenAI 语音转写（豆包转不了时的备用通道）", () => {
  it("配置：只要 OPENAI_API_KEY；没配就没有这条路", () => {
    expect(openaiAsrConfig({ OPENAI_API_KEY: " sk-1 " })).toEqual({ apiKey: "sk-1" });
    expect(openaiAsrConfig({ OPENAI_API_KEY: " " })).toBeNull();
    expect(openaiAsrConfig({})).toBeNull();
  });

  it("请求体：whisper-1、要逐句的时间；中文内容指定语言并提示出简体带标点，不知道语言就都不给", async () => {
    const zh = openaiAsrForm(new Uint8Array([1, 2, 3]), "zh");
    expect(Object.fromEntries([...zh.entries()].filter(([k]) => k !== "file"))).toEqual({
      model: "whisper-1",
      response_format: "verbose_json",
      "timestamp_granularities[]": "segment",
      language: "zh",
      prompt: "以下是普通话的句子，使用简体中文，带标点符号。",
    });
    const file = zh.get("file") as File;
    expect([file.name, file.type]).toEqual(["audio.mp3", "audio/mpeg"]);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const auto = openaiAsrForm(new Uint8Array([1]), null);
    expect([auto.has("language"), auto.has("prompt")]).toEqual([false, false]);
  });

  it("转写：密钥放 Authorization；逐句的开始时间和文字接成 cues，时长照接口报的", async () => {
    const fetchMock = vi.fn(async () => ok({ task: "transcribe", language: "chinese", duration: 61.2, text: "磨炼这五个特质，就完成了人生布局。", segments: [seg(0, " 磨炼这五个特质，"), seg(3.2, "就完成了人生布局。")] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeWithOpenAI({ apiKey: "sk-1" }, new Uint8Array([1, 2, 3]), "zh")).toEqual({
      text: "磨炼这五个特质，就完成了人生布局。",
      seconds: 61.2,
      cues: [
        { at: 0, end: 2, text: "磨炼这五个特质，" },
        { at: 3.2, end: 5.2, text: "就完成了人生布局。" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_ASR_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer sk-1" });
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  it("英文按词接、中间留空格；没人说话时编出来的套话和连着重复的句子滤掉，剩下空的就是空文字", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ duration: 9, segments: [seg(0, " Plan your week"), seg(2, " on Sunday."), seg(4, " on Sunday.")] })));
    expect(await transcribeWithOpenAI({ apiKey: "k" }, new Uint8Array([1]), null)).toMatchObject({ text: "Plan your week on Sunday.", cues: [{ at: 0 }, { at: 2 }] });
    vi.stubGlobal("fetch", vi.fn(async () => ok({ duration: 30, text: "字幕由 Amara.org 社群提供", segments: [seg(0, "字幕由 Amara.org 社群提供"), seg(28, "谢谢观看")] })));
    expect(await transcribeWithOpenAI({ apiKey: "k" }, new Uint8Array([1]), "zh")).toEqual({ text: "", seconds: 30, cues: [] });
  });

  it("出错都报出来，不悄悄给空：密钥不对、返回体认不出来、音频超过 25 MB（不发请求）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}', { status: 401 })));
    await expect(transcribeWithOpenAI({ apiKey: "bad" }, new Uint8Array([1]), null)).rejects.toThrow(/OpenAI 语音转写 401: .*Incorrect API key provided/);
    vi.stubGlobal("fetch", vi.fn(async () => ok({ text: "只有全文，没有逐句" })));
    await expect(transcribeWithOpenAI({ apiKey: "k" }, new Uint8Array([1]), null)).rejects.toThrow("OpenAI 语音转写返回的内容认不出来（没有 segments）");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeWithOpenAI({ apiKey: "k" }, new Uint8Array(OPENAI_ASR_MAX_BYTES + 1), null)).rejects.toThrow("OpenAI 语音转写一次最多收 25 MB，这段音频有 26 MB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
