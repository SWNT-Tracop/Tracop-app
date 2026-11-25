import { Global, Module } from '@nestjs/common';
import {
  AI_CONSENT_PORT,
  ASSISTANT_CHANNEL_PORT,
  ASSISTANT_INBOX,
  ASSISTANT_USER_PORT,
  AiAssistantModule,
  DRAFT_CATALOG_PORT,
  type AiConsentPort,
  type AssistantButton,
  type AssistantChannelPort,
  type AssistantInbox,
  type AssistantUser,
  type AssistantUserPort,
  type CatalogCategory,
  type ChannelRef,
  type DraftCatalogPort,
  type DraftLotInput,
  type DraftProduct,
  type LotUnit,
  type ProviderLocation,
} from '../modules/ai-assistant/index.js';
import { CatalogModule, CatalogService } from '../modules/catalog/index.js';
import {
  IDENTITY_ASSISTANT,
  IdentityAssistantModule,
  type IdentityAssistantApi,
} from '../modules/identity/index.js';
import {
  CONVERSATION_PORT,
  MESSAGING_PORT,
  MessagingModule,
  type ConversationPort,
  type InboundMessage,
  type MessagingPort,
} from '../modules/messaging/index.js';

type Actor = { readonly sub: string; readonly role: string };

/** Who writes in a chat, the provider's location and the AI consent, from identity. */
export class AssistantIdentityAdapter implements AssistantUserPort, AiConsentPort {
  constructor(private readonly identity: IdentityAssistantApi) {}

  byChannel(channel: string, channelUserId: string): Promise<AssistantUser | null> {
    if (channel !== 'telegram' && channel !== 'whatsapp' && channel !== 'app')
      return Promise.resolve(null);
    return this.identity.findUserByChannel(channel, channelUserId);
  }

  providerLocation(userId: string): Promise<ProviderLocation | null> {
    return this.identity.providerLocation(userId);
  }

  status(userId: string, version: string) {
    return this.identity.aiConsentStatus(userId, version);
  }

  accept(userId: string, version: string): Promise<void> {
    return this.identity.recordAiConsent(userId, version, 'telegram');
  }

  withdraw(userId: string, version: string): Promise<void> {
    return this.identity.withdrawAiConsent(userId, version, 'telegram');
  }
}

const MIN_FALLBACK_TOKEN = 4;

/** catalog's public use cases for the assistant; the actor is always the draft's owner. */
export class AssistantCatalogAdapter implements DraftCatalogPort {
  constructor(private readonly catalog: CatalogService) {}

  async searchProducts(
    _actorId: string,
    query: string,
    limit: number,
  ): Promise<readonly DraftProduct[]> {
    let products = await this.catalog.listProducts({ q: query });
    if (products.length === 0) {
      // Every word must match; with none, try the longest word alone («papa» in «papa del día»).
      const longest = query
        .split(/\s+/)
        .filter((word) => word.length >= MIN_FALLBACK_TOKEN)
        .sort((left, right) => right.length - left.length)[0];
      if (longest && longest !== query) products = await this.catalog.listProducts({ q: longest });
    }
    return products.slice(0, limit).map((product) => ({
      id: product.id,
      name: product.name,
      unit: product.unit,
      pending: product.status !== 'approved',
    }));
  }

  async categories(): Promise<readonly CatalogCategory[]> {
    return (await this.catalog.listCategories())
      .filter((category) => category.depth === 1)
      .map(({ id, name }) => ({ id, name }));
  }

  async proposeProduct(
    actor: Actor,
    input: {
      readonly id: string;
      readonly name: string;
      readonly categoryId: string;
      readonly unit: LotUnit;
    },
  ): Promise<DraftProduct> {
    const { product } = await this.catalog.createProductProposal(actor, {
      id: input.id,
      categoryId: input.categoryId,
      name: input.name,
      unit: input.unit,
      attributes: {},
      confirm: true,
    });
    return {
      id: product.id,
      name: product.name,
      unit: product.unit,
      pending: product.status !== 'approved',
    };
  }

  async createLot(
    actor: Actor,
    input: DraftLotInput,
    publish: boolean,
  ): Promise<{ readonly status: string }> {
    const lot = await this.catalog.createLot(actor, {
      id: input.lotId,
      productId: input.product.id,
      quantityMilli: input.quantityMilli,
      unit: input.product.unit,
      unitPrice: input.unitPrice,
      qualityGrade: input.qualityGrade,
      availableFrom: input.availableFrom,
      availableUntil: input.availableUntil,
      locationLat: input.lat,
      locationLng: input.lng,
    });
    if (!publish || lot.status !== 'draft') return { status: lot.status };
    const published = await this.catalog.publishLot(actor, lot.id, lot.version);
    return { status: published.status };
  }
}

/** Sends the assistant's replies through messaging (one button per row in Telegram). */
export class AssistantChannelAdapter implements AssistantChannelPort {
  constructor(private readonly messaging: MessagingPort) {}

  async send(
    to: ChannelRef,
    text: string,
    buttons?: readonly (readonly AssistantButton[])[],
  ): Promise<void> {
    if (to.channel !== 'telegram') return;
    const ref = { channel: 'telegram' as const, channelUserId: to.channelUserId };
    const flat = (buttons ?? []).flat();
    const outcome = flat.length
      ? await this.messaging.sendButtons(
          ref,
          text,
          flat.map((button) => ({
            kind: 'action' as const,
            text: button.text,
            action: button.action,
          })),
        )
      : await this.messaging.sendText(ref, text);
    if (!outcome.ok) throw new Error(`Assistant reply not delivered: ${outcome.error.kind}`);
  }
}

/** messaging → assistant inbox, in the webhook's transaction. */
export class AssistantConversationAdapter implements ConversationPort {
  constructor(private readonly inbox: AssistantInbox) {}

  async accept(message: InboundMessage): Promise<void> {
    const payload =
      message.type === 'text' && message.text !== undefined
        ? { type: 'text' as const, text: message.text }
        : message.type === 'location' && message.location
          ? { type: 'location' as const, lat: message.location.lat, lng: message.location.lng }
          : message.type === 'action' && message.action
            ? { type: 'action' as const, action: message.action.name.slice(0, 64) }
            : null;
    if (!payload) return;
    await this.inbox.accept({
      channel: message.channel,
      channelUserId: message.channelUserId,
      receivedAt: new Date(message.receivedAt),
      payload,
    });
  }
}

/** Ports the assistant needs from identity, catalog and messaging. */
@Global()
@Module({
  imports: [IdentityAssistantModule, CatalogModule, MessagingModule],
  providers: [
    {
      provide: AssistantIdentityAdapter,
      inject: [IDENTITY_ASSISTANT],
      useFactory: (identity: IdentityAssistantApi) => new AssistantIdentityAdapter(identity),
    },
    { provide: ASSISTANT_USER_PORT, useExisting: AssistantIdentityAdapter },
    { provide: AI_CONSENT_PORT, useExisting: AssistantIdentityAdapter },
    {
      provide: DRAFT_CATALOG_PORT,
      inject: [CatalogService],
      useFactory: (catalog: CatalogService) => new AssistantCatalogAdapter(catalog),
    },
    {
      provide: ASSISTANT_CHANNEL_PORT,
      inject: [MESSAGING_PORT],
      useFactory: (messaging: MessagingPort) => new AssistantChannelAdapter(messaging),
    },
  ],
  exports: [ASSISTANT_USER_PORT, AI_CONSENT_PORT, DRAFT_CATALOG_PORT, ASSISTANT_CHANNEL_PORT],
})
export class AiAssistantPortsBridgeModule {}

/** The conversation port messaging uses; a separate module so the two do not form a cycle. */
@Global()
@Module({
  imports: [AiAssistantModule],
  providers: [
    {
      provide: CONVERSATION_PORT,
      inject: [ASSISTANT_INBOX],
      useFactory: (inbox: AssistantInbox) => new AssistantConversationAdapter(inbox),
    },
  ],
  exports: [CONVERSATION_PORT],
})
export class AiAssistantConversationBridgeModule {}
