export type AiConsentDecision = 'accept' | 'withdraw';
export type AiConsentChannel = 'telegram' | 'whatsapp' | 'app';

/** Append-only AI consent decisions and the lookups the assistant needs. */
export interface IdentityAssistantRepository {
  /** Serializes consent decisions of one user in the current transaction. */
  lockUser(userId: string): Promise<void>;
  latestAiConsent(userId: string, version: string): Promise<AiConsentDecision | null>;
  appendAiConsent(event: {
    readonly id: string;
    readonly userId: string;
    readonly version: string;
    readonly decision: AiConsentDecision;
    readonly channel: AiConsentChannel;
    readonly recordedAt: Date;
  }): Promise<void>;
  providerLocation(
    userId: string,
  ): Promise<{ readonly lat: number; readonly lng: number; readonly municipality: string } | null>;
}

export interface AssistantUserView {
  readonly userId: string;
  readonly role: string;
  readonly active: boolean;
}

/** Public use cases of identity for the AI assistant (adapted in bootstrap). */
export interface IdentityAssistantApi {
  findUserByChannel(
    channel: AiConsentChannel,
    channelUserId: string,
  ): Promise<AssistantUserView | null>;
  providerLocation(
    userId: string,
  ): Promise<{ readonly lat: number; readonly lng: number; readonly municipality: string } | null>;
  aiConsentStatus(userId: string, version: string): Promise<'accepted' | 'withdrawn' | 'none'>;
  /** Idempotent: nothing is written if the current decision is already `accept`. */
  recordAiConsent(userId: string, version: string, channel: AiConsentChannel): Promise<void>;
  /** Idempotent: nothing is written unless the current decision is `accept`. */
  withdrawAiConsent(userId: string, version: string, channel: AiConsentChannel): Promise<void>;
}
