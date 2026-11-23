import { beforeEach, describe, expect, it, vi } from "vitest";

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      message: string
    ) {
      super(message);
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static BadRequestError = BadRequestError;
    beta = { messages: { stream } };
  }
  return { default: Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { meterInto } from "@/lib/usage/meter";
import { estimateUsd } from "@/lib/usage/prices";
import { askClaude, collectWebUse } from "./claude";

type Reply = { content: unknown[]; stop_reason: string; usage?: Record<string, unknown>; model?: string };
const reply = (r: Reply) => ({ finalMessage: async () => ({ model: "claude-opus-5-5", stop_details: null, usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: null }, ...r }) });
/** 上面替身里的错误类只收（状态码，消息） */
const BadRequest = Anthropic.BadRequestError as unknown as new (status: number, message: string) => Error;
const searchResult = (url: string) => ({ type: "web_search_result", url, title: "标题", encrypted_content: "…", page_age: null });

beforeEach(() => {
  stream.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});

describe("askClaude", () => {
  it("不联网时不带工具，回的是文字", async () => {
    stream.mockReturnValueOnce(reply({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "<title>好</title>" }], stop_reason: "end_turn" }));
    const counts: Record<string, number> = {};
    const res = await meterInto(counts, () => askClaude({ system: "s", prompt: "p" }));
    expect(res).toEqual({ text: "<title>好</title>", model: "claude-opus-5-5", truncated: false });
    expect(stream.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(counts).toEqual({ "tok_in|anthropic|claude-opus-5-5": 1000, "tok_out|anthropic|claude-opus-5-5": 100 });
  });

  it("联网：带上搜索和读网页两个工具和次数上限；被暂停的一轮原样接着跑；搜索按次记账", async () => {
    const paused = [
      { type: "text", text: "先搜一下。" },
      { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "FlashAttention-9" } },
      { type: "web_search_tool_result", tool_use_id: "t1", content: [searchResult("https://arxiv.org/abs/2611.01234"), searchResult("https://news.example/flash")] },
      { type: "server_tool_use", id: "t2", name: "web_fetch", input: { url: "https://arxiv.org/abs/2611.01234" } },
    ];
    stream
      .mockReturnValueOnce(reply({ content: paused, stop_reason: "pause_turn", usage: { input_tokens: 5000, output_tokens: 200, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } }))
      .mockReturnValueOnce(
        reply({
          content: [
            { type: "web_fetch_tool_result", tool_use_id: "t2", content: { type: "web_fetch_result", url: "https://arxiv.org/abs/2611.01234", retrieved_at: null, content: { type: "document", title: "FlashAttention-9" } } },
            { type: "server_tool_use", id: "t3", name: "web_fetch", input: { url: "https://paywall.example/a" } },
            { type: "web_fetch_tool_result", tool_use_id: "t3", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
            { type: "text", text: "<overview>查完了</overview>" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 2, web_fetch_requests: 2 } },
        })
      );
    const counts: Record<string, number> = {};
    const res = await meterInto(counts, () => askClaude({ system: "s", prompt: "p", web: { searches: 10, fetches: 8 } }));

    expect(stream).toHaveBeenCalledTimes(2);
    const first = stream.mock.calls[0][0];
    expect(first.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 10 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, max_content_tokens: 12_000 },
    ]);
    // 接着跑：同样的工具，上一次给的内容原样作为 assistant 的话接在后面，不另外加一句「继续」
    const second = stream.mock.calls[1][0];
    expect(second.tools).toEqual(first.tools);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: "assistant", content: paused });

    expect(res.text).toBe("先搜一下。<overview>查完了</overview>");
    expect(res.web).toEqual({
      searches: 3,
      fetches: 2,
      seen: [
        { url: "https://arxiv.org/abs/2611.01234", title: "标题", how: "read" },
        { url: "https://news.example/flash", title: "标题", how: "search" },
      ],
      errors: ["fetch:url_not_accessible"],
    });
    expect(counts).toMatchObject({ claude_web_search: 3, "tok_in|anthropic|claude-opus-5-5": 14_000, "tok_out|anthropic|claude-opus-5-5": 500 });
    // 3 次搜索 $0.03 + token
    expect(estimateUsd({ claude_web_search: 3 })).toBe(0.03);
  });

  it("一直被暂停就不再接了，说清楚没查完", async () => {
    stream.mockImplementation(() => reply({ content: [{ type: "server_tool_use", id: "t", name: "web_search", input: {} }], stop_reason: "pause_turn" }));
    await expect(meterInto({}, () => askClaude({ system: "s", prompt: "p", web: { searches: 1, fetches: 1 } }))).rejects.toThrow(/还没查完/);
    expect(stream).toHaveBeenCalledTimes(4);
  });

  it("组织关掉了联网搜索时告诉用户去哪开；拒答照常抛错", async () => {
    stream.mockReturnValueOnce({ finalMessage: async () => Promise.reject(new BadRequest(400, "Web search is not enabled for this organization")) });
    await expect(askClaude({ system: "s", prompt: "p", web: { searches: 1, fetches: 1 } })).rejects.toThrow(/没开联网搜索/);
    stream.mockReturnValueOnce(reply({ content: [], stop_reason: "refusal" }));
    await expect(meterInto({}, () => askClaude({ system: "s", prompt: "p" }))).rejects.toThrow(/模型拒绝/);
  });
});

describe("collectWebUse", () => {
  it("嵌在代码执行里的搜索结果、打印出来的地址也算见过；同一种错只记一次", () => {
    const into = { seen: [], errors: [] };
    collectWebUse(
      [
        { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", stdout: "1. https://a.example/x\n2. https://b.example/y", stderr: "", return_code: 0 } },
        { type: "web_search_tool_result", caller: { type: "code_execution_20260120", tool_id: "c1" }, content: [searchResult("https://a.example/x")] },
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
        { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://b.example/y", content: { type: "document", source: { type: "text", data: "正文里的 https://c.example/z 不算见过" } } } },
      ],
      into
    );
    expect(into).toEqual({
      seen: [
        { url: "https://a.example/x", title: "", how: "search" },
        { url: "https://b.example/y", title: "", how: "read" },
      ],
      errors: ["search:max_uses_exceeded"],
    });
  });
});
