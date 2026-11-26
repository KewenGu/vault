import type { AccountRef } from "@/lib/sources/link";

/**
 * 能直接告诉用户的问题（message 给用户看）：页面的 server action 显示它，/api/v1 的接口按 status 回它。
 * 502 = 依赖的外部服务（Claude）没给出能用的结果；503 = 这台服务器还没配好（数据库迁移没推）。别的错不包，往上抛（用户看到的是「出错了」）。
 */
export class VaultError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 | 503 = 400
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * 存进来的链接是一个账号的主页，不是一条帖子：存一条内容的入口不收它，带上认出来的账号，
 * 页面把用户带去「存这个博主的作品」的确认页（要选存多少条、看花费），接口把账号放在回包里。
 */
export class AccountLinkError extends VaultError {
  constructor(readonly account: AccountRef) {
    super("这是一个账号的主页，不是一条帖子。要把这个博主的作品都存下来，去「博主」页加他（要选存最近的多少条）");
    this.name = "AccountLinkError";
  }
}
