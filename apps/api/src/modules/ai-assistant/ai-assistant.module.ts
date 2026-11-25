import { Module } from '@nestjs/common';
import type pino from 'pino';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { APP_CLOCK, APP_ENVIRONMENT, APP_LOGGER, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import type { UnitOfWork } from '../../shared/infra/unit-of-work.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { AnthropicLLMAdapter } from './adapters/out/anthropic-llm.adapter.js';
import {
  DrizzleDraftRepository,
  DrizzleInboxRepository,
  DrizzleUsageRepository,
} from './adapters/out/drizzle-assistant-repositories.js';
import { FakeLLMAdapter } from './adapters/out/fake-llm.adapter.js';
import { AiGateway, MinuteRateLimiter } from './application/ai-gateway.js';
import {
  AssistantInbox,
  AssistantMaintenance,
  InboxProcessor,
} from './application/assistant-inbox.js';
import {
  AI_CONSENT_PORT,
  ASSISTANT_CHANNEL_PORT,
  ASSISTANT_CLOCK,
  ASSISTANT_INBOX,
  ASSISTANT_INBOX_PROCESSOR,
  ASSISTANT_MAINTENANCE,
  ASSISTANT_USER_PORT,
  DRAFT_CATALOG_PORT,
  LLM_PORT,
  LOT_DRAFT_ASSISTANT,
  PRICE_SUGGESTION_PORT,
} from './application/assistant-tokens.js';
import { LotDraftAssistant } from './application/lot-draft-assistant.js';
import type {
  AiConsentPort,
  AssistantChannelPort,
  AssistantUserPort,
  DraftCatalogPort,
  LLMPort,
  PriceSuggestionPort,
} from './ports/assistant-ports.js';

/**
 * The lot draft assistant. AI_CONSENT_PORT, ASSISTANT_USER_PORT, DRAFT_CATALOG_PORT and
 * ASSISTANT_CHANNEL_PORT come from bootstrap/ai-assistant-bridge.module.ts; PRICE_SUGGESTION_PORT
 * from bootstrap/recommendations-bridge.module.ts.
 */
@Module({
  providers: [
    DrizzleDraftRepository,
    DrizzleInboxRepository,
    DrizzleUsageRepository,
    { provide: ASSISTANT_CLOCK, useExisting: APP_CLOCK },
    {
      provide: LLM_PORT,
      inject: [APP_ENVIRONMENT, APP_LOGGER],
      useFactory: (environment: AppEnvironment, logger: pino.Logger): LLMPort =>
        environment.AI_ENABLED && environment.LLM_API_KEY && environment.LLM_MODEL
          ? new AnthropicLLMAdapter({
              apiKey: environment.LLM_API_KEY,
              model: environment.LLM_MODEL,
              timeoutMs: environment.LLM_TIMEOUT_MS,
              ...(environment.LLM_BASE_URL ? { baseUrl: environment.LLM_BASE_URL } : {}),
              logger,
            })
          : new FakeLLMAdapter(),
    },
    {
      provide: AiGateway,
      inject: [LLM_PORT, AI_CONSENT_PORT, DrizzleUsageRepository, APP_ENVIRONMENT, ASSISTANT_CLOCK],
      useFactory: (
        llm: LLMPort,
        consent: AiConsentPort,
        usage: DrizzleUsageRepository,
        environment: AppEnvironment,
        clock: Clock,
      ) =>
        new AiGateway(
          llm,
          consent,
          usage,
          new MinuteRateLimiter(environment.AI_REQUESTS_PER_MINUTE, clock),
          {
            enabled: environment.AI_ENABLED,
            consentVersion: environment.AI_CONSENT_VERSION ?? '',
            dailyRequestsPerUser: environment.AI_DAILY_REQUESTS_PER_USER,
            requestsPerMinute: environment.AI_REQUESTS_PER_MINUTE,
            monthlyTokenCap: environment.AI_MONTHLY_TOKEN_CAP,
            maxOutputTokens: environment.LLM_MAX_OUTPUT_TOKENS,
          },
          clock,
        ),
    },
    {
      provide: LOT_DRAFT_ASSISTANT,
      inject: [
        DrizzleDraftRepository,
        ASSISTANT_USER_PORT,
        DRAFT_CATALOG_PORT,
        AI_CONSENT_PORT,
        AiGateway,
        PRICE_SUGGESTION_PORT,
        ASSISTANT_CHANNEL_PORT,
        UNIT_OF_WORK,
        APP_ENVIRONMENT,
        ASSISTANT_CLOCK,
      ],
      useFactory: (
        drafts: DrizzleDraftRepository,
        users: AssistantUserPort,
        catalog: DraftCatalogPort,
        consent: AiConsentPort,
        gateway: AiGateway,
        prices: PriceSuggestionPort,
        channel: AssistantChannelPort,
        uow: UnitOfWork,
        environment: AppEnvironment,
        clock: Clock,
      ) =>
        new LotDraftAssistant(
          drafts,
          users,
          catalog,
          consent,
          gateway,
          prices,
          channel,
          uow,
          {
            draftTtlMinutes: environment.AI_DRAFT_TTL_MINUTES,
            lotHorizonDays: environment.CATALOG_LOT_MAX_HORIZON_DAYS,
            consentVersion: environment.AI_CONSENT_VERSION ?? '',
          },
          clock,
        ),
    },
    {
      provide: ASSISTANT_INBOX,
      inject: [DrizzleInboxRepository, ASSISTANT_CLOCK],
      useFactory: (inbox: DrizzleInboxRepository, clock: Clock) => new AssistantInbox(inbox, clock),
    },
    {
      provide: ASSISTANT_INBOX_PROCESSOR,
      inject: [
        DrizzleInboxRepository,
        LOT_DRAFT_ASSISTANT,
        APP_ENVIRONMENT,
        ASSISTANT_CLOCK,
        APP_LOGGER,
      ],
      useFactory: (
        inbox: DrizzleInboxRepository,
        assistant: LotDraftAssistant,
        environment: AppEnvironment,
        clock: Clock,
        logger: pino.Logger,
      ) =>
        new InboxProcessor(
          inbox,
          assistant,
          {
            leaseSeconds: environment.AI_INBOX_LEASE_SECONDS,
            maxAttempts: environment.AI_INBOX_MAX_ATTEMPTS,
            batchSize: 50,
          },
          clock,
          logger,
        ),
    },
    {
      provide: ASSISTANT_MAINTENANCE,
      inject: [DrizzleDraftRepository, DrizzleUsageRepository, APP_ENVIRONMENT, ASSISTANT_CLOCK],
      useFactory: (
        drafts: DrizzleDraftRepository,
        usage: DrizzleUsageRepository,
        environment: AppEnvironment,
        clock: Clock,
      ) =>
        new AssistantMaintenance(
          drafts,
          usage,
          {
            finishedDraftRetentionDays: environment.AI_FINISHED_DRAFT_RETENTION_DAYS,
            usageRetentionDays: environment.AI_USAGE_RETENTION_DAYS,
            batchSize: 500,
          },
          clock,
        ),
    },
  ],
  exports: [
    ASSISTANT_INBOX,
    ASSISTANT_INBOX_PROCESSOR,
    ASSISTANT_MAINTENANCE,
    LOT_DRAFT_ASSISTANT,
    LLM_PORT,
    ASSISTANT_CLOCK,
  ],
})
export class AiAssistantModule {}
