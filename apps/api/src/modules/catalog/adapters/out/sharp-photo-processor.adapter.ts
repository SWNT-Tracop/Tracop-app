import sharp from 'sharp';
import type { PhotoProcessorPort } from '../../ports/lot-photo-ports.js';

export class SharpPhotoProcessorAdapter implements PhotoProcessorPort {
  async process(input: {
    readonly bytes: Uint8Array;
    readonly maxInputPixels: number;
    readonly maxInputDimension: number;
    readonly maxOutputDimension: number;
    readonly quality: number;
  }): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> {
    const image = sharp(input.bytes, {
      failOn: 'error',
      limitInputPixels: input.maxInputPixels,
      page: 0,
      pages: 1,
      sequentialRead: true,
    });
    const metadata = await image.metadata().catch((error: unknown) => {
      if (error instanceof Error && /pixel limit/i.test(error.message)) {
        throw new Error('image_dimensions_exceeded');
      }
      throw error;
    });
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) {
      throw new Error('unsupported_image_format');
    }
    if (!metadata.width || !metadata.height) throw new Error('invalid_image_dimensions');
    if (
      metadata.width > input.maxInputDimension ||
      metadata.height > input.maxInputDimension ||
      metadata.width * metadata.height > input.maxInputPixels
    ) {
      throw new Error('image_dimensions_exceeded');
    }
    const result = await image
      .rotate()
      .toColourspace('srgb')
      .resize({
        width: input.maxOutputDimension,
        height: input.maxOutputDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: input.quality })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  }
}
