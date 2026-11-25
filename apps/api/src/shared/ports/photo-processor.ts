export interface PhotoProcessorPort {
  process(input: {
    readonly bytes: Uint8Array;
    readonly maxInputPixels: number;
    readonly maxInputDimension: number;
    readonly maxOutputDimension: number;
    readonly quality: number;
  }): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }>;
}

export const PHOTO_PROCESSOR_PORT = Symbol('PHOTO_PROCESSOR_PORT');
