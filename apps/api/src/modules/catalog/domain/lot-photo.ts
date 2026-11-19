export const LOT_PHOTO_STATES = ['pending', 'processing', 'ready'] as const;
export type LotPhotoState = (typeof LOT_PHOTO_STATES)[number];

export type LotPhotoProps = {
  readonly id: string;
  readonly lotId: string;
  readonly mediaRef: string;
  readonly state: LotPhotoState;
  readonly contentType: 'image/webp' | null;
  readonly sizeBytes: number | null;
  readonly position: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly deletedAt: Date | null;
};

export class LotPhoto {
  private constructor(readonly props: LotPhotoProps) {}

  static createPending(props: LotPhotoProps): LotPhoto {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(props.id)) {
      throw new Error('Lot photo IDs must be UUID v7.');
    }
    if (props.state !== 'pending' || !props.mediaRef.startsWith('incoming/')) {
      throw new Error('A new lot photo must be pending in the incoming prefix.');
    }
    if (!Number.isInteger(props.position) || props.position < 1) {
      throw new Error('Lot photo position must be a positive integer.');
    }
    return new LotPhoto(props);
  }

  static reconstitute(props: LotPhotoProps): LotPhoto {
    return new LotPhoto(props);
  }

  isExpiredAt(now: Date): boolean {
    return this.props.state === 'pending' && this.props.expiresAt.getTime() <= now.getTime();
  }
}
