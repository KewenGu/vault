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
