import sharp from "sharp";

// ImageResponse cannot embed WebP or GIF. Normalize all covers and bound their size.
export async function caseCardImageData(image: { bytes: Uint8Array }): Promise<string> {
  const png = await sharp(image.bytes, { limitInputPixels: 40_000_000 }).rotate().resize(720, 720, { fit: "cover" }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

// Social previews need a compact, widely supported image even for photographic covers.
export async function caseCardJpeg(png: ArrayBuffer): Promise<Uint8Array> {
  return sharp(Buffer.from(png)).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}
