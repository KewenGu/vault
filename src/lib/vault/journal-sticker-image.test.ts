import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { STICKER_EDGE, stickerImage } from "./journal-sticker-image";

/** 一张透明底的图，上面是一个不透明的红色 L 形：占着 box 这么大的地方，右下那四分之一是空的（透明） */
async function cutout(size: number, box: { left: number; top: number; width: number; height: number }): Promise<Uint8Array> {
  const red = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 230, g: 60, b: 60, alpha: 1 } } }).png().toBuffer();
  const top = await red(box.width, box.height / 2);
  const stem = await red(box.width / 2, box.height / 2);
  return new Uint8Array(
    await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: top, left: box.left, top: box.top },
        { input: stem, left: box.left, top: box.top + box.height / 2 },
      ])
      .png()
      .toBuffer()
  );
}

describe("stickerImage", () => {
  it("trims the empty border, keeps transparency, and saves a WebP", async () => {
    const out = await stickerImage(await cutout(400, { left: 100, top: 150, width: 200, height: 100 }));
    expect(out.mime).toBe("image/webp");
    expect({ width: out.width, height: out.height }).toEqual({ width: 200, height: 100 });
    // L 形右下那一块还是透明的
    const meta = await sharp(Buffer.from(out.data)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.hasAlpha).toBe(true);
  });

  it("shrinks a large picture to the sticker size", async () => {
    const out = await stickerImage(await cutout(2000, { left: 0, top: 500, width: 2000, height: 1000 }));
    expect({ width: out.width, height: out.height }).toEqual({ width: STICKER_EDGE, height: STICKER_EDGE / 2 });
  });

  it("keeps a picture that is one flat colour instead of failing on it", async () => {
    const flat = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: "#88aacc" } }).jpeg().toBuffer());
    const out = await stickerImage(flat);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it("throws on something that is not a picture", async () => {
    await expect(stickerImage(new TextEncoder().encode("not an image"))).rejects.toThrow();
  });
});
