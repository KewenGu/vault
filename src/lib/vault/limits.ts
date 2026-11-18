/**
 * 存档上限：视频原片和上传的文件，单个最多往存储桶里存多大。纯函数，没有别的依赖（服务器和测试都用）。
 *
 * 默认 50 MB，因为这是 Supabase 免费套餐的硬上限（项目的全局上传上限封顶 50 MB，改不了）。
 * 付费套餐把全局上限调高之后，用 `VAULT_STORE_MAX_MB` 跟着调（最多 200——存储桶 vault 自己的上限是 200 MB，
 * 见迁移 20261118000001；再大要一起改那个迁移）。
 *
 * 不能直接写成 200：这个数也是各平台读取器「挑哪一档清晰度」的上限，写大了，有多档的平台会挑一个存储服务不收的版本，
 * 本来存得下的视频反而存不进去（2026-11-18 在免费套餐上踩到）。
 */
export const STORE_MAX_DEFAULT_MB = 50;
export const STORE_MAX_CEILING_MB = 200;

export function storeMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.VAULT_STORE_MAX_MB);
  const chosen = Number.isFinite(mb) && mb >= 1 ? Math.min(Math.floor(mb), STORE_MAX_CEILING_MB) : STORE_MAX_DEFAULT_MB;
  return chosen * 1024 * 1024;
}
