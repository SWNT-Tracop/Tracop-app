import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const payloadSchema = z
  .object({ s: z.number().int().min(0).max(1_000_000), l: z.string().uuid() })
  .strict();

/** Opaque, authenticated cursor (AES-256-GCM): the client cannot read or forge positions. */
export class RecommendationCursorCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`recommendations.cursor:${secret}`).digest();
  }

  encode(position: { readonly score: number; readonly lotId: string }): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ s: position.score, l: position.lotId }), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** Null for anything that is not a cursor this server issued. */
  decode(cursor: string): { readonly score: number; readonly lotId: string } | null {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29 || bytes.length > 512) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const json = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      const parsed = payloadSchema.safeParse(JSON.parse(json));
      return parsed.success ? { score: parsed.data.s, lotId: parsed.data.l } : null;
    } catch {
      return null;
    }
  }
}
