import sharp from 'sharp';
import { SharpPhotoProcessorAdapter } from './sharp-photo-processor.adapter.js';
import {
  createAnimatedPng,
  createAnimatedWebp,
  createSyntheticJpeg,
  createSyntheticPng,
} from '../../../../../test/helpers/synthetic-image.js';

const processor = new SharpPhotoProcessorAdapter();
const settings = {
  maxInputPixels: 25_000_000,
  maxInputDimension: 10_000,
  maxOutputDimension: 2_048,
  quality: 80,
};

describe('SharpPhotoProcessorAdapter', () => {
  it('strips EXIF, XMP and IPTC from final WebP with synthetic GPS and applies orientation', async () => {
    const input = await createSyntheticJpeg({
      width: 40,
      height: 30,
      orientation: 6,
      gps: { latitude: 5.5353, longitude: -73.3678 },
    });
    const inputMetadata = await sharp(input).metadata();
    expect(inputMetadata.exif).toBeDefined();
    expect(inputMetadata.orientation).toBe(6);
    expect(inputMetadata.xmpAsString).toContain('GPSLatitude="5.5353"');
    expect(inputMetadata.xmpAsString).toContain('GPSLongitude="-73.3678"');
    expect(input.includes(Buffer.from([0x25, 0x88]))).toBe(true);
    expect(input.includes(Buffer.from('GPSLatitude="5.5353"'))).toBe(true);

    const output = await processor.process({ bytes: input, ...settings });
    const metadata = await sharp(output.bytes).metadata();
    const finalBytes = Buffer.from(output.bytes);

    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(finalBytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(finalBytes.includes(Buffer.from('XMP'))).toBe(false);
    expect(finalBytes.includes(Buffer.from([0x25, 0x88]))).toBe(false);
    expect(finalBytes.includes(Buffer.from('SyntheticCam'))).toBe(false);
    expect(output.width).toBe(30);
    expect(output.height).toBe(40);
  });

  it('applies EXIF orientation before resizing', async () => {
    const input = await createSyntheticJpeg({ width: 40, height: 30, orientation: 6 });
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const output = await processor.process({ bytes: input, ...settings });
    expect(output.width).toBe(30);
    expect(output.height).toBe(40);
  });

  it('keeps Display P3 colours stable when converting to sRGB WebP', async () => {
    const background = { r: 100, g: 150, b: 200 };
    const input = await createSyntheticPng({ width: 8, height: 8, background, iccProfile: 'p3' });
    const inputRaw = await sharp(input).raw().toBuffer();
    const output = await processor.process({ bytes: input, ...settings });
    const outputRaw = await sharp(output.bytes).raw().toBuffer();

    expect(Buffer.from(output.bytes).includes(Buffer.from('Display P3'))).toBe(false);
    for (let index = 0; index < 3; index += 1) {
      expect(Math.abs(outputRaw[index]! - inputRaw[index]!)).toBeLessThanOrEqual(3);
    }
  });

  it('limits the output longest side without enlarging smaller images', async () => {
    const input = await createSyntheticJpeg({ width: 1_200, height: 600 });
    const output = await processor.process({
      bytes: input,
      ...settings,
      maxOutputDimension: 600,
    });
    expect(output.width).toBe(600);
    expect(output.height).toBe(300);
  });

  it.each([
    ['animated WebP', createAnimatedWebp],
    ['animated PNG', createAnimatedPng],
  ])('uses only the first frame of %s input', async (_name, createAnimated) => {
    const input = await createAnimated();
    if (_name === 'animated WebP') {
      expect((await sharp(input, { animated: true }).metadata()).pages).toBe(2);
    } else {
      // libvips exposes APNG as its default first-frame PNG preview.
      expect(input.includes(Buffer.from('acTL'))).toBe(true);
      expect((await sharp(input).metadata()).format).toBe('png');
    }

    const output = await processor.process({ bytes: input, ...settings });
    const firstPixel = await sharp(output.bytes).raw().toBuffer();
    expect(output.width).toBe(8);
    expect(output.height).toBe(8);
    expect(firstPixel[0]).toBeGreaterThan(200);
    expect(firstPixel[2]).toBeLessThan(60);
  });

  it('rejects GIF rather than processing an animated frame format outside the accepted set', async () => {
    const onePixelGif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
    expect((await sharp(onePixelGif).metadata()).format).toBe('gif');
    await expect(processor.process({ bytes: onePixelGif, ...settings })).rejects.toThrow(
      'unsupported_image_format',
    );
  });

  it('rejects unsupported formats, excessive dimensions and non-images', async () => {
    await expect(
      processor.process({ bytes: Buffer.from('not an image'), ...settings }),
    ).rejects.toThrow();
    const tooWide = await createSyntheticJpeg({ width: 40, height: 20 });
    await expect(
      processor.process({ bytes: tooWide, ...settings, maxInputDimension: 30 }),
    ).rejects.toThrow('image_dimensions_exceeded');
    const tooManyPixels = await createSyntheticJpeg({ width: 40, height: 20 });
    await expect(
      processor.process({ bytes: tooManyPixels, ...settings, maxInputPixels: 500 }),
    ).rejects.toThrow('image_dimensions_exceeded');
  });
});
