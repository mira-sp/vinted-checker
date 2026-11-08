import sharp from "sharp";
import phash from "sharp-phash";

/** Fix rotation, shrink, and re-encode so hashing and stored photos are consistent. */
export async function normalize(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

export async function hashImage(buffer: Buffer): Promise<string> {
  return phash(buffer); // 64-char string of 0/1
}

/**
 * Vinted photos are often worn or laid out on a bed, while shop images are
 * studio shots. Besides the whole image, use a centre crop and the top and
 * bottom halves, so a garment that fills only part of the frame can still match.
 */
export async function crops(buffer: Buffer): Promise<Buffer[]> {
  const { width = 0, height = 0 } = await sharp(buffer).metadata();
  if (width < 64 || height < 64) return [buffer];
  const region = (left: number, top: number, w: number, h: number) =>
    sharp(buffer)
      .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) })
      .toBuffer();
  return [
    buffer,
    await region(width * 0.15, height * 0.15, width * 0.7, height * 0.7),
    await region(0, 0, width, height * 0.55),
    await region(0, height * 0.45, width, height * 0.55),
  ];
}
