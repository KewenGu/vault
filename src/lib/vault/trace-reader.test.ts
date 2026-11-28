import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyStats, SourceFetchError, type FetchedPost } from "@/lib/sources/types";
import type { Followed } from "@/lib/sources/follow";

vi.mock("@/lib/sources/fetch-post", () => ({ fetchPostAlone: vi.fn() }));
vi.mock("@/lib/sources/link", async (orig) => ({ ...(await orig<object>()), resolveLink: vi.fn() }));

import { fetchPostAlone } from "@/lib/sources/fetch-post";
import { LinkError, resolveLink } from "@/lib/sources/link";
import { readPageForTrace } from "./trace-reader";

const post = (patch: Partial<FetchedPost> = {}): FetchedPost => ({ platform: "x", externalId: "1", kind: "text", title: "Machine architecture", text: "长文的正文", author: { id: "jackclarkSF", name: "Jack Clark" }, publishedAt: "2026-11-23T10:00:00Z", stats: emptyStats(), hashtags: [], topComments: [], images: [], video: null, music: null, notes: ["读不到回复的内容，只有回复数"], ...patch });

beforeEach(() => {
  vi.mocked(resolveLink).mockReset().mockResolvedValue({ platform: "x", externalId: "1", url: "https://x.com/i/status/1" });
  vi.mocked(fetchPostAlone).mockReset();
});

describe("readPageForTrace", () => {
  it("读一条 X 帖子：正文、接口顺带给的引用帖子、它提到的别的地址", async () => {
    const quoted: Followed = { post: post({ externalId: "2", text: "被引用的那条", author: { id: "b", name: "B" } }), mentions: [] };
    vi.mocked(fetchPostAlone).mockResolvedValue({
      post: post(),
      mentions: [
        { how: "quote", url: "https://x.com/b/status/2", ref: null, read: quoted },
        { how: "link", url: "https://jack-clark.net/2026/11/23/import-ai-482", ref: null },
        { how: "link", url: "https://jack-clark.net/2026/11/23/import-ai-482", ref: null },
      ],
    });
    expect(await readPageForTrace("https://x.com/jackclarkSF/status/1")).toEqual({
      url: "https://x.com/i/status/1",
      via: "X",
      title: "Machine architecture",
      author: "Jack Clark",
      publishedAt: "2026-11-23T10:00:00Z",
      text: "长文的正文\n\n【引用的帖子：B】\n被引用的那条",
      links: [{ text: "正文里的链接", url: "https://jack-clark.net/2026/11/23/import-ai-482" }],
      notes: ["读不到回复的内容，只有回复数"],
    });
    expect(fetchPostAlone).toHaveBeenCalledWith({ platform: "x", externalId: "1", url: "https://x.com/i/status/1" });
  });

  it("视频的字幕接在正文后面；网页带着正文里的外链", async () => {
    vi.mocked(fetchPostAlone).mockResolvedValue({ post: post({ platform: "youtube", text: "简介", captions: "[0:01] 说的话", links: [{ text: "论文", url: "https://arxiv.org/abs/1" }] }), mentions: [] });
    expect(await readPageForTrace("https://youtu.be/x")).toMatchObject({ via: "YouTube", text: "简介\n\n【字幕】\n[0:01] 说的话", links: [{ text: "论文", url: "https://arxiv.org/abs/1" }] });
  });

  it("读不到时给一句能直接看的话", async () => {
    vi.mocked(fetchPostAlone).mockRejectedValue(new SourceFetchError("这条帖子读不到：已经被删了。把内容复制下来贴进来"));
    await expect(readPageForTrace("https://x.com/a/status/1")).rejects.toThrow(/^这条帖子读不到：已经被删了$/);
    vi.mocked(resolveLink).mockRejectedValue(new LinkError("这是一个账号的主页，不是一条帖子"));
    await expect(readPageForTrace("https://x.com/a")).rejects.toThrow("这是一个账号的主页，不是一条帖子");
  });
});
