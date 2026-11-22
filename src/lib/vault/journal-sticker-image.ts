import "server-only";
import sharp from "sharp";

/** 自己传的贴纸存成多大：长边最多这么多像素（页面上一张贴纸平常 70 来个像素宽，放大几倍也够） */
export const STICKER_EDGE = 512;

export type StickerImage = { data: Uint8Array; mime: "image/webp"; width: number; height: number };

/**
 * 把一张图片做成贴纸：按 EXIF 摆正，裁掉四周的空白（透明的边、纯色的边——iPhone 相册里抠出来的主体四周常带一圈透明），
 * 缩到长边不超过 STICKER_EDGE，存成保留透明底的 WebP。动图取第一帧。读不出来的抛错。
 */
export async function stickerImage(data: Uint8Array): Promise<StickerImage> {
  const upright = await sharp(Buffer.from(data)).rotate().png().toBuffer();
  // 整张都是一个颜色时没东西可裁（sharp 会报错）：不裁
  const trimmed = await sharp(upright)
    .trim()
    .toBuffer()
    .catch(() => upright);
  const { data: out, info } = await sharp(trimmed).resize({ width: STICKER_EDGE, height: STICKER_EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out), mime: "image/webp", width: info.width, height: info.height };
}
