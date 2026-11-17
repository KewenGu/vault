import { describe, it, expect, vi, afterEach } from "vitest";
import { explainFetchError, labeledFetch } from "./fetch-error";

const errno = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("explainFetchError", () => {
  it("undici 'fetch failed' → 服务名 + cause 里的底层原因，原错误挂 cause", () => {
    const raw = new TypeError("fetch failed", { cause: errno("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED") });
    const out = explainFetchError(raw, "本地模型 Ollama（http://localhost:11434）") as Error;
    expect(out.message).toBe("本地模型 Ollama（http://localhost:11434） 连接失败: connect ECONNREFUSED 127.0.0.1:11434");
    expect(out.cause).toBe(raw);
  });

  it("cause 是 message 为空的 AggregateError（localhost 双栈都被拒）→ 展开 errors，并带上 code", () => {
    const agg = Object.assign(
      new AggregateError([errno("connect ECONNREFUSED ::1:11434", "ECONNREFUSED"), errno("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED")], ""),
      { code: "ECONNREFUSED" }
    );
    const out = explainFetchError(new TypeError("fetch failed", { cause: agg }), "Ollama") as Error;
    expect(out.message).toBe("Ollama 连接失败: connect ECONNREFUSED ::1:11434; connect ECONNREFUSED 127.0.0.1:11434");
  });

  it("cause 的 message 不含 code（如 undici 连接超时）→ code 前置补上", () => {
    const cause = errno("Connect Timeout Error (attempted address: api.voyageai.com:443, timeout: 10000ms)", "UND_ERR_CONNECT_TIMEOUT");
    const out = explainFetchError(new TypeError("fetch failed", { cause }), "Voyage 嵌入（api.voyageai.com）") as Error;
    expect(out.message).toBe(
      "Voyage 嵌入（api.voyageai.com） 连接失败: UND_ERR_CONNECT_TIMEOUT Connect Timeout Error (attempted address: api.voyageai.com:443, timeout: 10000ms)"
    );
  });

  it("AbortSignal.timeout 触发（TimeoutError）→ 请求超时", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const out = explainFetchError(timeout, "Voyage 嵌入（api.voyageai.com）") as Error;
    expect(out.message).toBe("Voyage 嵌入（api.voyageai.com） 请求超时: The operation was aborted due to timeout");
    expect(out.cause).toBe(timeout);
  });

  it("非网络层错误原样返回（同一个对象）", () => {
    const other = new Error("本地模型调用 500: boom");
    expect(explainFetchError(other, "x")).toBe(other);
    const typeErr = new TypeError("Cannot read properties of undefined");
    expect(explainFetchError(typeErr, "x")).toBe(typeErr);
  });
});

describe("labeledFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("成功时原样返回全局 fetch 的 Response，参数透传", async () => {
    const res = { ok: true } as Response;
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", fetchMock);
    await expect(labeledFetch("svc", "https://a.test/x", { method: "POST" })).resolves.toBe(res);
    expect(fetchMock).toHaveBeenCalledWith("https://a.test/x", { method: "POST" });
  });

  it("网络层失败 → 抛带服务名的错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: errno("getaddrinfo ENOTFOUND api.apify.com", "ENOTFOUND") })));
    await expect(labeledFetch("Apify（actor）", "https://api.apify.com/v2/acts")).rejects.toThrow(
      "Apify（actor） 连接失败: getaddrinfo ENOTFOUND api.apify.com"
    );
  });
});
