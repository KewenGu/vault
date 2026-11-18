-- 存储桶 vault 的单文件上限从 50 MB 提到 200 MB（2026-11-18）：第一条真实的抖音视频就有 127 MB。
-- 和代码里的 VIDEO_MAX_BYTES / UPLOAD_MAX_BYTES 是一对，要一起改。
-- 注意这只是桶自己的上限；Supabase 项目还有一个全局的上传上限（控制台 Storage → Settings），
-- 免费套餐封顶 50 MB，Pro 以上可以调高——两个里面小的那个说了算。可以重复执行。
update storage.buckets set file_size_limit = 209715200 where id = 'vault';
