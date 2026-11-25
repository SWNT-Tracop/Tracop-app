import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type {
  AiConsentChannel,
  AiConsentDecision,
  IdentityAssistantRepository,
} from '../../ports/assistant-ports.js';

type Row = Record<string, unknown>;

@Injectable()
export class DrizzleIdentityAssistantRepository implements IdentityAssistantRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.database.current().execute(query)).rows as Row[];
  }

  async lockUser(userId: string): Promise<void> {
    await this.rows(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`identity.ai_consent:${userId}`}))`,
    );
  }

  async latestAiConsent(userId: string, version: string): Promise<AiConsentDecision | null> {
    const [row] = await this.rows(sql`
      SELECT decision FROM identity.ai_consent_events
      WHERE user_id = ${userId}::uuid AND version = ${version}
      ORDER BY recorded_at DESC, id DESC LIMIT 1`);
    return (row?.decision as AiConsentDecision | undefined) ?? null;
  }

  async appendAiConsent(event: {
    readonly id: string;
    readonly userId: string;
    readonly version: string;
    readonly decision: AiConsentDecision;
    readonly channel: AiConsentChannel;
    readonly recordedAt: Date;
  }): Promise<void> {
    await this.rows(sql`
      INSERT INTO identity.ai_consent_events (id, user_id, version, decision, channel, recorded_at)
      VALUES (${event.id}::uuid, ${event.userId}::uuid, ${event.version}, ${event.decision},
        ${event.channel}, ${event.recordedAt.toISOString()}::timestamptz)`);
  }

  async providerLocation(userId: string) {
    const [row] = await this.rows(sql`
      SELECT lat, lng, municipality FROM identity.provider_profiles WHERE user_id = ${userId}::uuid`);
    if (!row || row.lat === null || row.lng === null) return null;
    return { lat: Number(row.lat), lng: Number(row.lng), municipality: String(row.municipality) };
  }
}
