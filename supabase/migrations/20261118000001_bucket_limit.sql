-- 存储桶 vault 的单文件上限从 50 MB 提到 200 MB（2026-11-18）：第一条真实的抖音视频就有 127 MB。
-- 这是存档上限能调到的最大值（lib/vault/limits.ts 的 STORE_MAX_CEILING_MB）；实际用多少由 VAULT_STORE_MAX_MB 定，默认 50 MB。
-- 注意这只是桶自己的上限；Supabase 项目还有一个全局的上传上限（控制台 Storage → Settings），
-- 免费套餐封顶 50 MB，Pro 以上可以调高——两个里面小的那个说了算。可以重复执行。
update storage.buckets set file_size_limit = 209715200 where id = 'vault';
