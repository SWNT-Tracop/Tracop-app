import sharp from 'sharp';

type SyntheticImageOptions = {
  readonly width?: number;
  readonly height?: number;
  readonly background?: { readonly r: number; readonly g: number; readonly b: number };
  readonly orientation?: number;
  readonly iccProfile?: 'srgb' | 'p3';
  readonly gps?: { readonly latitude: number; readonly longitude: number };
};

export const createSyntheticJpeg = async (options: SyntheticImageOptions = {}): Promise<Buffer> => {
  const width = options.width ?? 32;
  const height = options.height ?? 24;
  let image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: options.background ?? { r: 120, g: 80, b: 40 },
    },
  }).jpeg({ quality: 90 });
  if (options.iccProfile) image = image.withIccProfile(options.iccProfile);
  if (options.orientation && !options.gps)
    image = image.withMetadata({ orientation: options.orientation });
  let encoded: Buffer<ArrayBufferLike> = Buffer.from(await image.toBuffer());
  if (options.gps) {
    encoded = attachGpsExif(encoded, options.gps, options.orientation);
    encoded = attachXmpGps(encoded, options.gps);
  }
  return encoded;
};

export const createAnimatedWebp = async (): Promise<Buffer> => {
  const width = 8;
  const height = 8;
  const frameSize = width * height * 3;
  const pixels = Buffer.alloc(frameSize * 2);
  for (let index = 0; index < frameSize; index += 3) {
    pixels[index] = 240;
    pixels[index + 1] = 8;
    pixels[index + 2] = 8;
    pixels[frameSize + index] = 8;
    pixels[frameSize + index + 1] = 8;
    pixels[frameSize + index + 2] = 240;
  }
  return sharp(pixels, {
    raw: { width, height: height * 2, channels: 3, pageHeight: height },
  })
    .webp({ loop: 0, delay: [100, 100], quality: 100 })
    .toBuffer();
};

export const createAnimatedPng = async (): Promise<Buffer> => {
  const width = 8;
  const height = 8;
  const firstFrame = await createSyntheticPng({
    width,
    height,
    background: { r: 240, g: 8, b: 8 },
  });
  const secondFrame = await createSyntheticPng({
    width,
    height,
    background: { r: 8, g: 8, b: 240 },
  });
  const firstChunks = parsePngChunks(firstFrame);
  const secondChunks = parsePngChunks(secondFrame);
  const ihdr = firstChunks.find(({ type }) => type === 'IHDR')!;
  const firstImage = firstChunks.filter(({ type }) => type === 'IDAT');
  const secondImage = secondChunks.filter(({ type }) => type === 'IDAT');
  return Buffer.concat([
    firstFrame.subarray(0, 8),
    encodePngChunk('IHDR', ihdr.data),
    encodePngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    encodePngChunk('fcTL', frameControl(0, width, height)),
    ...firstImage.map(({ data }) => encodePngChunk('IDAT', data)),
    encodePngChunk('fcTL', frameControl(1, width, height)),
    ...secondImage.map(({ data }) => encodePngChunk('fdAT', Buffer.concat([uint32(2), data]))),
    encodePngChunk('IEND', Buffer.alloc(0)),
  ]);
};

export const attachXmpGps = (
  jpeg: Buffer,
  gps: { readonly latitude: number; readonly longitude: number },
): Buffer => {
  const xmp = Buffer.from(
    `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="${gps.latitude}" exif:GPSLongitude="${gps.longitude}"/></rdf:RDF></x:xmpmeta>`,
    'utf8',
  );
  const app1 = Buffer.alloc(4 + xmp.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(xmp.length + 2, 2);
  xmp.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
};

type PngChunk = { readonly type: string; readonly data: Buffer };

const parsePngChunks = (png: Buffer): PngChunk[] => {
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return chunks;
};

const encodePngChunk = (type: string, data: Buffer): Buffer => {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
};

const frameControl = (sequence: number, width: number, height: number): Buffer => {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(width, 4);
  data.writeUInt32BE(height, 8);
  data.writeUInt16BE(1, 20);
  data.writeUInt16BE(10, 22);
  return data;
};

const uint32 = (value: number): Buffer => {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value, 0);
  return result;
};

const crc32 = (input: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const createSyntheticPng = async (options: SyntheticImageOptions = {}): Promise<Buffer> => {
  let image = sharp({
    create: {
      width: options.width ?? 32,
      height: options.height ?? 24,
      channels: 3,
      background: options.background ?? { r: 120, g: 80, b: 40 },
    },
  }).png();
  if (options.iccProfile) image = image.withIccProfile(options.iccProfile);
  return image.toBuffer();
};

export const attachGpsExif = (
  jpeg: Buffer,
  gps: { readonly latitude: number; readonly longitude: number },
  orientation?: number,
): Buffer => {
  const exif = buildExif(gps, orientation);
  const app1 = Buffer.alloc(4 + exif.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
};

const buildExif = (
  gps: { readonly latitude: number; readonly longitude: number },
  orientation?: number,
): Buffer => {
  const make = Buffer.from('SyntheticCam\0', 'ascii');
  const model = Buffer.from('SyntheticModel\0', 'ascii');
  const latitude = toRationals(gps.latitude);
  const longitude = toRationals(gps.longitude);
  return buildTiff(
    [
      ...(orientation
        ? [{ tag: 0x0112, type: 3 as const, count: 1, value: shortValue(orientation) }]
        : []),
      { tag: 0x010f, type: 2, count: make.length, value: make, deferred: true },
      { tag: 0x0110, type: 2, count: model.length, value: model, deferred: true },
      { tag: 0x8825, type: 4, count: 1, value: Buffer.alloc(0) },
    ],
    [
      { tag: 0x0001, type: 2, count: 2, value: Buffer.from('N\0', 'ascii') },
      { tag: 0x0002, type: 5, count: 3, value: latitude, deferred: true },
      { tag: 0x0003, type: 2, count: 2, value: Buffer.from('W\0', 'ascii') },
      { tag: 0x0004, type: 5, count: 3, value: longitude, deferred: true },
    ],
  );
};

type IfdEntry = {
  readonly tag: number;
  readonly type: 2 | 3 | 4 | 5;
  readonly count: number;
  readonly value: Buffer;
  readonly deferred?: boolean;
};

const buildTiff = (ifd0Entries: IfdEntry[], gpsEntries: IfdEntry[]): Buffer => {
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  const gpsOffset = 8 + ifd0Size;
  const gpsSize = 2 + gpsEntries.length * 12 + 4;
  let dataOffset = gpsOffset + gpsSize;
  const data: Buffer[] = [];
  const encode = (entries: IfdEntry[]): Buffer => {
    const buffer = Buffer.alloc(2 + entries.length * 12 + 4);
    buffer.writeUInt16LE(entries.length, 0);
    let position = 2;
    for (const entry of entries) {
      buffer.writeUInt16LE(entry.tag, position);
      buffer.writeUInt16LE(entry.type, position + 2);
      buffer.writeUInt32LE(entry.count, position + 4);
      if (entry.tag === 0x8825) {
        buffer.writeUInt32LE(gpsOffset, position + 8);
      } else if (entry.deferred) {
        buffer.writeUInt32LE(dataOffset, position + 8);
        data.push(entry.value);
        dataOffset += entry.value.length;
      } else {
        entry.value.copy(buffer, position + 8, 0, 4);
      }
      position += 12;
    }
    return buffer;
  };
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    header,
    encode(ifd0Entries),
    encode(gpsEntries),
    ...data,
  ]);
};

const toRationals = (value: number): Buffer => {
  const absolute = Math.abs(value);
  const degrees = Math.trunc(absolute);
  const minutes = Math.trunc((absolute - degrees) * 60);
  const seconds = Math.round(((absolute - degrees) * 60 - minutes) * 60 * 100);
  const values = [degrees, minutes, seconds];
  const buffer = Buffer.alloc(24);
  values.forEach((item, index) => {
    buffer.writeUInt32LE(item, index * 8);
    buffer.writeUInt32LE(100, index * 8 + 4);
  });
  return buffer;
};

const shortValue = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
};
