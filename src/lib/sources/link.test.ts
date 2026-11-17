import { describe, it, expect, vi } from "vitest";
import { LinkError, extractShareUrl, parseLink, platformOfHost, resolveLink } from "./link";

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("收藏夹：链接识别", () => {
  it("从 App「复制链接」的整段话里找出链接（后面紧跟中文也不带上）", () => {
    expect(extractShareUrl("7.94 复制打开抖音，看看【某某的作品】开头太绝了 https://v.douyin.com/iAbCdEf/ k@P.xx 09/12")).toBe("https://v.douyin.com/iAbCdEf/");
    expect(extractShareUrl("28 【标题 - 某某 | 小红书】 😆 abc 😆 http://xhslink.com/o/6y3HQIIiyUh，复制后打开")).toBe("http://xhslink.com/o/6y3HQIIiyUh");
    // 没带 http 的短链
    expect(extractShareUrl("看这个 xhslink.com/a/AbC123 不错")).toBe("https://xhslink.com/a/AbC123");
    expect(extractShareUrl("youtu.be/jNQXAC9IVRw 这个讲得好")).toBe("https://youtu.be/jNQXAC9IVRw");
    // 有好几个链接时挑认得的平台的那个
    expect(extractShareUrl("https://example.com/x 和 https://www.douyin.com/video/7300000000000000000")).toBe("https://www.douyin.com/video/7300000000000000000");
    expect(extractShareUrl("原文 https://example.com/x，视频 https://x.com/a/status/2106418403661779046。")).toBe("https://x.com/a/status/2106418403661779046");
    // 都不是认得的平台：返回第一个（当网页读）；没带 http 的只认这几个平台的域名；没有链接是 null
    expect(extractShareUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(extractShareUrl("看 netflix.com/title/123 和 me@x.com/abc")).toBeNull();
    expect(extractShareUrl("只有一段话，没有链接")).toBeNull();
  });

  it("认平台只看域名结尾，仿冒域名不算", () => {
    expect(platformOfHost("www.xiaohongshu.com")).toBe("xiaohongshu");
    expect(platformOfHost("v.douyin.com")).toBe("douyin");
    expect(platformOfHost("www.iesdouyin.com")).toBe("douyin");
    expect(platformOfHost("vm.tiktok.com")).toBe("tiktok");
    expect(platformOfHost("www.instagram.com")).toBe("instagram");
    expect(platformOfHost("youtu.be")).toBe("youtube");
    expect(platformOfHost("m.youtube.com")).toBe("youtube");
    expect(platformOfHost("twitter.com")).toBe("x");
    expect(platformOfHost("fxtwitter.com")).toBe("x");
    expect(platformOfHost("xiaohongshu.com.evil.io")).toBeNull();
    expect(platformOfHost("notdouyin.com")).toBeNull();
    // 结尾碰巧是 x.com 的别的站
    expect(platformOfHost("netflix.com")).toBeNull();
    expect(platformOfHost("www.bilibili.com")).toBeNull();
  });

  it("小红书：认 explore / discovery/item，原链接（带口令）留着", () => {
    const id = "6aac3d9a000000000e03f000";
    expect(parseLink(`https://www.xiaohongshu.com/explore/${id}?xsec_token=AB_c-1=&xsec_source=pc_feed`)).toEqual({
      platform: "xiaohongshu",
      externalId: id,
      url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=AB_c-1=&xsec_source=pc_feed`,
    });
    expect(parseLink(`http://www.xiaohongshu.com/discovery/item/${id}?xsec_token=T&xsec_source=app_share`)?.url).toBe(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=T&xsec_source=app_share`);
    // 主页、搜索页、短链认不出帖子
    expect(parseLink("https://www.xiaohongshu.com/user/profile/65aea5c7000000000d01cd33")).toBeNull();
    expect(parseLink("http://xhslink.com/o/6y3HQIIiyUh")).toBeNull();
  });

  it("抖音：video / note / share/video / modal_id 都规范成 douyin.com/video/<id>", () => {
    const want = { platform: "douyin", externalId: "7682728905966423334", url: "https://www.douyin.com/video/7682728905966423334" };
    expect(parseLink("https://www.douyin.com/video/7682728905966423334?previous_page=app_code_link")).toEqual(want);
    expect(parseLink("https://www.iesdouyin.com/share/video/7682728905966423334/?region=CN&mid=1")).toEqual(want);
    expect(parseLink("https://www.douyin.com/jingxuan?modal_id=7682728905966423334")).toEqual(want);
    expect(parseLink("https://www.douyin.com/note/7682728905966423334")).toEqual(want);
    expect(parseLink("https://www.douyin.com/user/MS4wLjABAAAA")).toBeNull();
  });

  it("短链跟着跳转走到帖子；跳出平台的域名就停", async () => {
    const fetchImpl = vi.fn<(service: string, url: string, init?: RequestInit) => Promise<Response>>(async () => redirectTo("https://www.iesdouyin.com/share/video/7682728905966423334/?region=CN"));
    expect(await resolveLink("https://v.douyin.com/iAbCdEf/", fetchImpl)).toMatchObject({ platform: "douyin", externalId: "7682728905966423334" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][2]).toMatchObject({ redirect: "manual" });

    const away = vi.fn(async () => redirectTo("https://evil.example/steal"));
    await expect(resolveLink("http://xhslink.com/o/abc", away)).rejects.toThrow(/没认出这是哪篇笔记/);
    expect(away).toHaveBeenCalledTimes(1);
  });

  it("TikTok：视频 / 图集 / 旧式链接都规范成 /@用户/video/<id>，不知道用户时用 @_", () => {
    const id = "6718335390845095173";
    expect(parseLink(`https://www.tiktok.com/@scout2015/video/${id}?is_from_webapp=1&sender_device=pc`)).toEqual({ platform: "tiktok", externalId: id, url: `https://www.tiktok.com/@scout2015/video/${id}` });
    expect(parseLink(`https://www.tiktok.com/@user.name/photo/${id}`)?.url).toBe(`https://www.tiktok.com/@user.name/video/${id}`);
    expect(parseLink(`https://m.tiktok.com/v/${id}.html`)?.url).toBe(`https://www.tiktok.com/@_/video/${id}`);
    expect(parseLink(`https://www.tiktok.com/embed/v2/${id}`)?.externalId).toBe(id);
    // 主页、短链认不出视频
    expect(parseLink("https://www.tiktok.com/@scout2015")).toBeNull();
    expect(parseLink("https://vm.tiktok.com/ZMabc123/")).toBeNull();
  });

  it("Instagram：帖子 / Reels / 带用户名的写法；短码区分大小写；主页、快拍、分享短链认不出", () => {
    expect(parseLink("https://www.instagram.com/reel/Chunk8-jurw/?igsh=abc")).toEqual({ platform: "instagram", externalId: "Chunk8-jurw", url: "https://www.instagram.com/reel/Chunk8-jurw/" });
    expect(parseLink("https://www.instagram.com/someone/p/BQ0eAlwhDrw/")?.url).toBe("https://www.instagram.com/p/BQ0eAlwhDrw/");
    expect(parseLink("https://www.instagram.com/reels/Chunk8-jurw")?.url).toBe("https://www.instagram.com/reel/Chunk8-jurw/");
    expect(parseLink("https://www.instagram.com/tv/B-abc_123/")?.url).toBe("https://www.instagram.com/tv/B-abc_123/");
    expect(parseLink("https://www.instagram.com/instagram/")).toBeNull();
    expect(parseLink("https://www.instagram.com/stories/someone/3141592653/")).toBeNull();
    expect(parseLink("https://www.instagram.com/share/reel/BAbc123xyz")).toBeNull();
  });

  it("YouTube：watch / youtu.be / shorts / live / embed 都认，播放列表之类的参数去掉；频道、播放列表认不出", () => {
    const watch = (id: string) => ({ platform: "youtube", externalId: id, url: `https://www.youtube.com/watch?v=${id}` });
    expect(parseLink("https://youtu.be/jNQXAC9IVRw?si=AbCd")).toEqual(watch("jNQXAC9IVRw"));
    expect(parseLink("https://www.youtube.com/watch?v=aircAruvnKk&t=30s&list=PLabc")).toEqual(watch("aircAruvnKk"));
    expect(parseLink("https://www.youtube.com/live/jNQXAC9IVRw?feature=share")).toEqual(watch("jNQXAC9IVRw"));
    expect(parseLink("https://www.youtube-nocookie.com/embed/jNQXAC9IVRw")).toEqual(watch("jNQXAC9IVRw"));
    // Shorts 留着 /shorts/ 的写法（「看原帖」打开的还是竖屏播放页）
    expect(parseLink("https://m.youtube.com/shorts/abcDEF-_123")).toEqual({ platform: "youtube", externalId: "abcDEF-_123", url: "https://www.youtube.com/shorts/abcDEF-_123" });
    expect(parseLink("https://www.youtube.com/@3blue1brown")).toBeNull();
    expect(parseLink("https://www.youtube.com/playlist?list=PLabc")).toBeNull();
    expect(parseLink("https://www.youtube.com/watch?v=short")).toBeNull();
  });

  it("X：twitter.com 和镜像域名都认，规范成 x.com/<用户>/status/<id>；主页认不出", () => {
    const id = "2106418403661779046";
    expect(parseLink(`https://twitter.com/someone/status/${id}?s=20&t=abc`)).toEqual({ platform: "x", externalId: id, url: `https://x.com/someone/status/${id}` });
    expect(parseLink(`https://x.com/i/web/status/${id}`)?.url).toBe(`https://x.com/i/status/${id}`);
    expect(parseLink(`https://x.com/someone/status/${id}/photo/1`)?.externalId).toBe(id);
    expect(parseLink(`https://fxtwitter.com/someone/status/${id}`)?.url).toBe(`https://x.com/someone/status/${id}`);
    expect(parseLink("https://x.com/someone")).toBeNull();
    expect(parseLink("https://x.com/i/status/1")).toBeNull();
  });

  it("别的站都算网页：去掉 #片段和追踪参数，同一个地址是同一条；指向本机 / 内网的不收", async () => {
    const a = parseLink("https://simonwillison.net/2024/Dec/31/llms-in-2024/?utm_source=x&id=3&fbclid=abc#section");
    expect(a).toMatchObject({ platform: "web", url: "https://simonwillison.net/2024/Dec/31/llms-in-2024/?id=3" });
    expect(a?.externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseLink("https://simonwillison.net/2024/Dec/31/llms-in-2024/?id=3&utm_campaign=y")?.externalId).toBe(a?.externalId);
    expect(parseLink("https://simonwillison.net/2024/Dec/31/llms-in-2024/?id=4")?.externalId).not.toBe(a?.externalId);
    expect(parseLink("http://localhost:3000/admin")).toBeNull();
    expect(parseLink("ftp://example.com/a")).toBeNull();
    // 不发请求（不跟跳转）
    const fetchImpl = vi.fn();
    expect(await resolveLink("https://www.bilibili.com/video/BV1xx?spm=1", fetchImpl)).toMatchObject({ platform: "web", url: "https://www.bilibili.com/video/BV1xx" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(resolveLink("http://192.168.1.1/")).rejects.toThrow(new LinkError("这个地址读不了（指向本机或内网）"));
  });

  it("新平台的短链也跟着跳转走；认不出帖子时按平台说该贴什么", async () => {
    const tiktok = vi.fn<(service: string, url: string, init?: RequestInit) => Promise<Response>>(async () => redirectTo("https://www.tiktok.com/@scout2015/video/6718335390845095173?_r=1"));
    expect(await resolveLink("https://vm.tiktok.com/ZMabc123/", tiktok)).toEqual({ platform: "tiktok", externalId: "6718335390845095173", url: "https://www.tiktok.com/@scout2015/video/6718335390845095173" });
    expect(tiktok.mock.calls[0][0]).toBe("TikTok短链");
    const ig = vi.fn(async () => redirectTo("/reel/Chunk8-jurw/?igsh=x"));
    expect((await resolveLink("https://www.instagram.com/share/reel/BAbc123xyz", ig)).url).toBe("https://www.instagram.com/reel/Chunk8-jurw/");
    const none = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(resolveLink("https://www.youtube.com/@3blue1brown", none)).rejects.toThrow(/没认出这是哪个视频：贴视频页面的链接/);
    await expect(resolveLink("https://x.com/someone", none)).rejects.toThrow(/没认出这是哪条帖子/);
    await expect(resolveLink("https://www.instagram.com/instagram/", none)).rejects.toThrow(/主页和快拍读不了/);
  });

  it("不是链接：报给用户看的错", async () => {
    await expect(resolveLink("随便一段话")).rejects.toThrow(new LinkError("这不是一条链接"));
  });

  it("短链一直不落到帖子上（主页、活动页）：最多跟 5 跳", async () => {
    let n = 0;
    const loop = vi.fn(async () => redirectTo(`https://www.douyin.com/hop/${++n}`));
    await expect(resolveLink("https://v.douyin.com/x/", loop)).rejects.toThrow(/没认出这是哪个视频/);
    expect(loop).toHaveBeenCalledTimes(5);
  });
});

// Provider fixtures retain their fetch interface; DNS/connection enforcement is exercised in network/public-fetch.test.ts.
vi.mock("@/lib/network/public-fetch", async (original) => ({
  ...await original<typeof import("@/lib/network/public-fetch")>(),
  publicFetch: (url: string, options: import("@/lib/network/public-fetch").PublicFetchOptions = {}) => fetch(url, { headers: options.headers, method: options.method, redirect: options.redirect, signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000) }),
}));
