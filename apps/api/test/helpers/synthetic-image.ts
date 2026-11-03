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
  if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
  const encoded = await image.toBuffer();
  return options.gps ? attachGpsExif(encoded, options.gps) : encoded;
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
): Buffer => {
  const exif = buildExif(gps);
  const app1 = Buffer.alloc(4 + exif.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
};

const buildExif = (gps: { readonly latitude: number; readonly longitude: number }): Buffer => {
  const make = Buffer.from('SyntheticCam\0', 'ascii');
  const model = Buffer.from('SyntheticModel\0', 'ascii');
  const latitude = toRationals(gps.latitude);
  const longitude = toRationals(gps.longitude);
  return buildTiff(
    [
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
  readonly type: 2 | 4 | 5;
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
