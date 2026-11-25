import type { Clock } from '../../../shared/kernel/clock.js';
import { createId } from '../../../shared/kernel/ids.js';
import {
  answerQuestion,
  applyExtraction,
  choosePriceBasis,
  QUALITY_MAX_LENGTH,
  useSharedLocation,
  type ApplyResult,
  type Extraction,
} from '../domain/apply-answer.js';
import { availabilityWindow, bogotaDay, formatDay } from '../domain/dates.js';
import {
  EDITABLE_FIELDS,
  isExpired,
  newDraft,
  nextQuestion,
  transitionDraft,
  type DraftFields,
  type DraftProduct,
  type DraftQuestion,
  type EditableField,
  type LotDraftProps,
} from '../domain/lot-draft.js';
import { formatCop, formatQuantity, parseUnit, totalCop } from '../domain/parsing.js';
import { assistantMessages as t } from '../i18n.js';
import {
  buildChoicePrompt,
  buildExtractionPrompt,
  choiceSchema,
  extractionSchema,
} from '../prompts/lot-draft.v1.js';
import type {
  AiConsentPort,
  AssistantButton,
  AssistantChannelPort,
  AssistantUnitOfWork,
  AssistantUser,
  AssistantUserPort,
  ChannelRef,
  DraftCatalogPort,
  DraftRepository,
  InboxItem,
  PriceSuggestionPort,
  ProviderLocation,
} from '../ports/assistant-ports.js';
import type { AiGateway } from './ai-gateway.js';

export interface AssistantSettings {
  readonly draftTtlMinutes: number;
  readonly lotHorizonDays: number;
  readonly consentVersion: string;
}

const PROVIDER_ROLES = new Set(['producer', 'supplier']);
const MAX_CANDIDATES = 5;
const MAX_CATEGORIES = 8;

interface Reply {
  readonly text: string;
  readonly buttons?: readonly (readonly AssistantButton[])[];
}

/** callback_data: `d:<shortCode>:<version>:<op>` (≤ 64 bytes) or `c:<op>` for consent. */
export const draftAction = (draft: LotDraftProps, op: string): string =>
  `d:${draft.shortCode.toString(36)}:${draft.version}:${op}`;

const parseDraftAction = (
  action: string,
): { shortCode: number; version: number; op: string } | null => {
  const match = /^d:([0-9a-z]{1,10}):(\d{1,9}):([a-z_0-9]{1,24})$/.exec(action);
  if (!match) return null;
  return { shortCode: Number.parseInt(match[1]!, 36), version: Number(match[2]), op: match[3]! };
};

type Prepared =
  | { readonly kind: 'done'; readonly replies: readonly Reply[] }
  | { readonly kind: 'extract'; readonly text: string; readonly notices: readonly Reply[] };

/**
 * Turns a producer's messages into a lot draft and, only after they press Confirmar, into a lot
 * through catalog's public use cases. The model only extracts spans or picks among a closed
 * list; every decision and every number comes from this code.
 */
export class LotDraftAssistant {
  constructor(
    private readonly drafts: DraftRepository,
    private readonly users: AssistantUserPort,
    private readonly catalog: DraftCatalogPort,
    private readonly consent: AiConsentPort,
    private readonly ai: AiGateway,
    private readonly prices: PriceSuggestionPort,
    private readonly channel: AssistantChannelPort,
    private readonly uow: AssistantUnitOfWork,
    private readonly settings: AssistantSettings,
    private readonly clock: Clock,
  ) {}

  /** Handles one inbox item and sends the replies after the transaction commits. */
  async handle(item: InboxItem): Promise<void> {
    const to: ChannelRef = { channel: item.channel, channelUserId: item.channelUserId };
    const replies = await this.replies(item);
    // The state is already committed: a failed send must not replay the message.
    for (const reply of replies) {
      try {
        await this.channel.send(to, reply.text, reply.buttons);
      } catch {
        return;
      }
    }
  }

  private async replies(item: InboxItem): Promise<readonly Reply[]> {
    const user = await this.users.byChannel(item.channel, item.channelUserId);
    if (!user?.active) return [{ text: t.notLinked }];
    if (!PROVIDER_ROLES.has(user.role)) return [{ text: t.notProvider }];
    const location = await this.users.providerLocation(user.userId);
    if (!location) return [{ text: t.noProfile }];

    const payload = item.payload;
    if (payload.type === 'action' && payload.action.startsWith('c:'))
      return this.handleConsent(user, payload.action);
    if (payload.type === 'text' && /^\/(ia|consentimiento)\b/i.test(payload.text.trim()))
      return this.consentStatus(user);

    let prepared: Prepared;
    try {
      prepared = await this.prepare(user, location, payload);
    } catch (error) {
      if (error instanceof ConfirmationFailed) return [{ text: t.publishFailed }];
      throw error;
    }
    if (prepared.kind === 'done') return prepared.replies;

    // Outside any transaction: the model calls can take seconds.
    const extraction = await this.extract(user.userId, prepared.text);
    const resolved =
      extraction.kind === 'ok' && extraction.value.product
        ? await this.preResolveProduct(user, extraction.value.product)
        : undefined;
    const replies = await this.uow.run(async () => {
      await this.drafts.lockUser(user.userId);
      const { draft } = await this.activeDraft(user.userId);
      const current = draft ?? (await this.createDraft(user.userId, location));
      if (extraction.kind === 'unavailable') {
        // Guided form: the whole message is taken as the product name.
        const fallback = await this.guidedText(user, current, prepared.text);
        return [{ text: t.guidedFallback }, ...fallback];
      }
      const applied = applyExtraction(current.fields, extraction.value, this.clock.now());
      const fields =
        resolved && !applied.fields.product && applied.fields.productQuery
          ? { ...applied.fields, ...resolved }
          : applied.fields;
      return this.applyAndAsk(user, current, { ...applied, fields }, extraction.value);
    });
    return [...prepared.notices, ...replies];
  }

  private prepare(
    user: AssistantUser,
    location: ProviderLocation,
    payload: InboxItem['payload'],
  ): Promise<Prepared> {
    return this.uow.run(async (): Promise<Prepared> => {
      await this.drafts.lockUser(user.userId);
      const { draft, notices } = await this.activeDraft(user.userId);
      if (payload.type === 'action')
        return this.done(notices, await this.handleAction(user, draft, payload.action));
      if (payload.type === 'location') {
        if (!draft) return this.done(notices, [{ text: t.questions.product }]);
        return this.done(
          notices,
          await this.applyAndAsk(
            user,
            draft,
            useSharedLocation(draft.fields, payload.lat, payload.lng),
          ),
        );
      }
      return this.prepareText(user, location, draft, payload.text, notices);
    });
  }

  private done(notices: readonly Reply[], replies: readonly Reply[]): Prepared {
    return { kind: 'done', replies: [...notices, ...replies] };
  }

  /** The active draft, after expiring it if its time ran out. */
  private async activeDraft(
    userId: string,
  ): Promise<{ draft: LotDraftProps | null; notices: readonly Reply[] }> {
    const draft = await this.drafts.findActive(userId);
    if (!draft) return { draft: null, notices: [] };
    if (!isExpired(draft, this.clock.now())) return { draft, notices: [] };
    await this.drafts.update(transitionDraft(draft, 'expired', this.clock.now()), draft.version);
    return { draft: null, notices: [{ text: t.expired }] };
  }

  private async createDraft(userId: string, location: ProviderLocation): Promise<LotDraftProps> {
    const draft = newDraft({
      id: createId(),
      shortCode: await this.drafts.nextShortCode(),
      userId,
      lotId: createId(),
      now: this.clock.now(),
      ttlMs: this.ttlMs(),
      fields: {
        location: {
          lat: location.lat,
          lng: location.lng,
          source: 'profile',
          municipality: location.municipality,
        },
      },
    });
    await this.drafts.insert(draft);
    return draft;
  }

  private ttlMs(): number {
    return this.settings.draftTtlMinutes * 60_000;
  }

  // ------------------------------------------------------------------- text

  private async prepareText(
    user: AssistantUser,
    location: ProviderLocation,
    draft: LotDraftProps | null,
    text: string,
    notices: readonly Reply[],
  ): Promise<Prepared> {
    const current = draft ?? (await this.createDraft(user.userId, location));
    const now = this.clock.now();
    // A short answer to the question asked is parsed without the model.
    if (current.question) {
      const answered = this.answerWithoutModel(current, text, now);
      if (answered) return this.done(notices, await this.applyAndAsk(user, current, answered));
    }
    const availability = current.fields.aiDeclined
      ? 'declined'
      : await this.ai.availability(user.userId);
    if (availability === 'ok') return { kind: 'extract', text, notices };
    const replies = await this.guidedText(user, current, text);
    if (availability === 'no_consent')
      return this.done(notices, [...replies, this.consentRequest()]);
    return this.done(notices, replies);
  }

  private answerWithoutModel(draft: LotDraftProps, text: string, now: Date): ApplyResult | null {
    if (draft.question === 'quality') {
      const quality = text.trim().slice(0, QUALITY_MAX_LENGTH);
      return { fields: { ...draft.fields, quality: quality || null }, issue: null };
    }
    if (draft.question === 'product' || draft.question === 'product_choice') return null;
    const answered = answerQuestion(draft.fields, draft.question!, text, now);
    // A long free sentence is better read by the model when it is available.
    if (answered?.issue && text.trim().split(/\s+/).length > 3) return null;
    return answered;
  }

  /** Without the model: the text is the answer to the current question or the product name. */
  private async guidedText(
    user: AssistantUser,
    draft: LotDraftProps,
    text: string,
  ): Promise<readonly Reply[]> {
    const question = draft.question ?? 'product';
    if (question === 'product' || question === 'product_choice' || !draft.fields.product) {
      const fields: DraftFields = {
        ...draft.fields,
        productQuery: text.trim().slice(0, 60),
        candidates: undefined,
        product: undefined,
      };
      return this.applyAndAsk(user, draft, { fields, issue: null });
    }
    const answered = answerQuestion(draft.fields, question, text, this.clock.now());
    return this.applyAndAsk(user, draft, answered ?? { fields: draft.fields, issue: null });
  }

  private async extract(
    userId: string,
    text: string,
  ): Promise<{ kind: 'ok'; value: Extraction } | { kind: 'unavailable' }> {
    const result = await this.ai.generate(
      userId,
      'extract',
      buildExtractionPrompt(text),
      extractionSchema,
    );
    return result.kind === 'ok' ? result : { kind: 'unavailable' };
  }

  // ---------------------------------------------------------------- product

  /** Lexical search only (inside the transaction): one match is taken, several become buttons. */
  private async resolveProduct(user: AssistantUser, fields: DraftFields): Promise<DraftFields> {
    if (fields.product || !fields.productQuery || fields.candidates) return fields;
    const candidates = await this.catalog.searchProducts(
      user.userId,
      fields.productQuery,
      MAX_CANDIDATES,
    );
    if (candidates.length === 1) return this.withProduct(fields, candidates[0]!);
    return { ...fields, candidates };
  }

  /**
   * Outside the transaction, after an extraction: lexical search and, only among several
   * candidates, the model picks one label from the closed list (or none).
   */
  private async preResolveProduct(
    user: AssistantUser,
    query: string,
  ): Promise<Pick<DraftFields, 'product' | 'candidates'>> {
    const candidates = await this.catalog.searchProducts(user.userId, query, MAX_CANDIDATES);
    if (candidates.length === 1) return { product: candidates[0]!, candidates: undefined };
    if (candidates.length > 1) {
      const choice = await this.ai.generate(
        user.userId,
        'choose_product',
        buildChoicePrompt(
          query,
          candidates.map(({ name }) => name),
        ),
        choiceSchema(candidates.length),
      );
      if (choice.kind === 'ok' && choice.value.choice !== 'none') {
        const picked = candidates[Number(choice.value.choice.slice(1)) - 1];
        if (picked) return { product: picked, candidates: undefined };
      }
    }
    return { candidates };
  }

  private withProduct(fields: DraftFields, product: DraftProduct): DraftFields {
    return { ...fields, product, candidates: undefined };
  }

  // ------------------------------------------------------------ next step

  /**
   * Saves the merged fields and answers with the next single question, or with the
   * confirmation once everything is there.
   */
  private async applyAndAsk(
    user: AssistantUser,
    draft: LotDraftProps,
    applied: ApplyResult,
    extraction?: Extraction,
  ): Promise<readonly Reply[]> {
    let fields = await this.resolveProduct(user, applied.fields);
    // A unit the user named for the whole lot, when the product has another one.
    if (fields.product && !fields.unit && extraction?.unit) {
      const unit = parseUnit(extraction.unit);
      if (unit.kind === 'unit') fields = { ...fields, unit: unit.unit };
    }
    if (fields.product && !fields.unit && fields.quantityMilli)
      fields = { ...fields, unit: fields.product.unit };

    const now = this.clock.now();
    let issueText: string | null = applied.issue ? t.issues[applied.issue.reason] : null;
    let question: DraftQuestion | null = applied.issue?.question ?? nextQuestion(fields);
    if (fields.candidates && fields.candidates.length === 0 && !fields.product)
      question = 'product_proposal';

    if (!question && fields.availableFromDay && fields.availableUntilDay) {
      const window = availabilityWindow(
        fields.availableFromDay,
        fields.availableUntilDay,
        now,
        this.settings.lotHorizonDays,
      );
      if (window.kind !== 'ok') {
        issueText = t.issues[window.kind];
        fields = { ...fields, availableUntilDay: undefined };
        question = 'available_until';
      }
    }

    if (question) {
      const saved = await this.save(draft, 'collecting', fields, question);
      const ask = this.questionReply(saved, question);
      return [issueText ? { ...ask, text: `${issueText} ${ask.text}` } : ask];
    }
    const saved = await this.save(draft, 'awaiting_confirmation', fields, null);
    return [await this.confirmationReply(saved)];
  }

  private async save(
    draft: LotDraftProps,
    status: 'collecting' | 'awaiting_confirmation',
    fields: DraftFields,
    question: DraftQuestion | null,
  ): Promise<LotDraftProps> {
    const next = transitionDraft(draft, status, this.clock.now(), {
      fields,
      question,
      ttlMs: this.ttlMs(),
    });
    if (!(await this.drafts.update(next, draft.version)))
      throw new Error('Lot draft changed concurrently.');
    return next;
  }

  private questionReply(draft: LotDraftProps, question: DraftQuestion): Reply {
    const fields = draft.fields;
    const unit = fields.product?.unit ?? fields.unit ?? 'unidades';
    switch (question) {
      case 'product_choice':
        return {
          text: t.questions.product_choice,
          buttons: [
            ...(fields.candidates ?? []).map((candidate, index) => [
              { text: candidate.name, action: draftAction(draft, `pick_${index}`) },
            ]),
            [{ text: t.otherProduct, action: draftAction(draft, 'other_product') }],
          ],
        };
      case 'product_proposal':
        return {
          text: t.questions.product_proposal(fields.productQuery ?? ''),
          buttons: [
            [{ text: t.propose, action: draftAction(draft, 'propose') }],
            [{ text: t.otherProduct, action: draftAction(draft, 'other_product') }],
          ],
        };
      case 'quantity':
        return { text: t.questions.quantity(unit) };
      case 'unit_mismatch':
        return { text: t.questions.unit_mismatch(fields.product!.unit) };
      case 'price':
        return { text: t.questions.price(unit) };
      case 'price_basis':
        return {
          text: t.questions.price_basis(formatCop(BigInt(fields.priceAmount!)), unit),
          buttons: [
            [{ text: t.perUnit, action: draftAction(draft, 'basis_unit') }],
            [{ text: t.total, action: draftAction(draft, 'basis_total') }],
          ],
        };
      case 'location':
        return {
          text: t.questions.location,
          buttons: [[{ text: t.useProfileLocation, action: draftAction(draft, 'loc_profile') }]],
        };
      case 'edit_field':
        return {
          text: t.questions.edit_field,
          buttons: EDITABLE_FIELDS.map((field) => [
            { text: t.fields[field], action: draftAction(draft, `field_${field}`) },
          ]),
        };
      case 'proposal_category':
      case 'product':
      case 'unit':
      case 'available_from':
      case 'available_until':
      case 'quality':
        return { text: t.questions[question] };
    }
  }

  /** Readable summary: no coordinates or address ever go into a chat. */
  private async confirmationReply(draft: LotDraftProps): Promise<Reply> {
    const fields = draft.fields;
    const product = fields.product!;
    const quantity = BigInt(fields.quantityMilli!);
    const unitPrice = BigInt(fields.unitPrice!);
    const total = totalCop(unitPrice, quantity);
    const lines = [
      `• ${t.fields.product}: ${product.name}`,
      `• ${t.fields.quantity}: ${formatQuantity(quantity)} ${product.unit}`,
      `• ${t.fields.price}: ${formatCop(unitPrice)} por ${product.unit}` +
        (total === null ? '' : ` (total ${formatCop(total)})`),
      ...(fields.quality ? [`• ${t.fields.quality}: ${fields.quality}`] : []),
      `• ${t.fields.available_from}: ${formatDay(fields.availableFromDay!)}`,
      `• ${t.fields.available_until}: ${formatDay(fields.availableUntilDay!)}`,
      `• ${t.fields.location}: ${fields.location?.municipality ?? 'ubicación compartida'}`,
    ];
    const suggestion = product.pending ? null : await this.prices.suggest(product.id, product.unit);
    const extra = [
      ...(suggestion
        ? [
            t.suggestion(
              formatCop(suggestion.unitPrice),
              suggestion.source,
              formatDay(bogotaDay(suggestion.observedAt)),
            ),
          ]
        : []),
      ...(product.pending ? [t.summaryDraftOnly] : []),
    ];
    return {
      text: [t.summary(lines), ...extra].join('\n\n'),
      buttons: [
        [
          { text: t.confirm, action: draftAction(draft, 'confirm') },
          { text: t.edit, action: draftAction(draft, 'edit') },
          { text: t.cancel, action: draftAction(draft, 'cancel') },
        ],
      ],
    };
  }

  // ---------------------------------------------------------------- buttons

  private async handleAction(
    user: AssistantUser,
    draft: LotDraftProps | null,
    action: string,
  ): Promise<readonly Reply[]> {
    const parsed = parseDraftAction(action);
    // Another person's draft, an old version or a finished draft: the same answer for all.
    if (
      !parsed ||
      !draft ||
      draft.userId !== user.userId ||
      draft.shortCode !== parsed.shortCode ||
      draft.version !== parsed.version
    )
      return [{ text: t.stale }];
    const { op } = parsed;
    const fields = draft.fields;

    if (op === 'confirm') return this.confirm(user, draft);
    if (op === 'cancel') {
      await this.drafts.update(
        transitionDraft(draft, 'cancelled', this.clock.now()),
        draft.version,
      );
      return [{ text: t.cancelled }];
    }
    if (op === 'edit') {
      const saved = await this.save(draft, 'collecting', fields, 'edit_field');
      return [this.questionReply(saved, 'edit_field')];
    }
    if (op.startsWith('field_')) return this.editField(draft, op.slice(6));
    if (op === 'basis_unit' || op === 'basis_total')
      return this.applyAndAsk(
        user,
        draft,
        choosePriceBasis(fields, op === 'basis_unit' ? 'unit' : 'total'),
      );
    if (op === 'loc_profile') {
      const location = await this.users.providerLocation(user.userId);
      if (!location) return [{ text: t.noProfile }];
      return this.applyAndAsk(user, draft, {
        fields: {
          ...fields,
          location: {
            lat: location.lat,
            lng: location.lng,
            source: 'profile',
            municipality: location.municipality,
          },
        },
        issue: null,
      });
    }
    if (op === 'other_product') {
      const cleared: DraftFields = {
        ...fields,
        product: undefined,
        productQuery: undefined,
        candidates: undefined,
      };
      const saved = await this.save(draft, 'collecting', cleared, 'product');
      return [this.questionReply(saved, 'product')];
    }
    const pick = /^pick_(\d)$/.exec(op);
    if (pick) {
      const candidate = fields.candidates?.[Number(pick[1])];
      if (!candidate) return [{ text: t.stale }];
      return this.applyAndAsk(user, draft, {
        fields: this.withProduct(fields, candidate),
        issue: null,
      });
    }
    if (op === 'propose') return this.askCategory(draft);
    const category = /^cat_(\d)$/.exec(op);
    if (category) return this.propose(user, draft, Number(category[1]));
    return [{ text: t.stale }];
  }

  private async editField(draft: LotDraftProps, field: string): Promise<readonly Reply[]> {
    if (!EDITABLE_FIELDS.includes(field as EditableField)) return [{ text: t.stale }];
    const fields = { ...draft.fields };
    const cleared: Record<EditableField, Partial<Record<keyof DraftFields, undefined>>> = {
      product: {
        product: undefined,
        productQuery: undefined,
        candidates: undefined,
        unit: undefined,
      },
      quantity: { quantityMilli: undefined, unitPrice: undefined },
      price: { priceAmount: undefined, priceBasis: undefined, unitPrice: undefined },
      quality: { quality: undefined },
      available_from: { availableFromDay: undefined },
      available_until: { availableUntilDay: undefined },
      location: { location: undefined },
    };
    const next = { ...fields, ...cleared[field as EditableField] } as DraftFields;
    const question: DraftQuestion =
      field === 'quality' ? 'quality' : (nextQuestion(next) ?? 'edit_field');
    const saved = await this.save(draft, 'collecting', next, question);
    return [this.questionReply(saved, question)];
  }

  private async askCategory(draft: LotDraftProps): Promise<readonly Reply[]> {
    const categories = (await this.catalog.categories()).slice(0, MAX_CATEGORIES);
    const saved = await this.save(draft, 'collecting', draft.fields, 'proposal_category');
    return [
      {
        text: t.questions.proposal_category,
        buttons: categories.map((category, index) => [
          { text: category.name, action: draftAction(saved, `cat_${index}`) },
        ]),
      },
    ];
  }

  private async propose(
    user: AssistantUser,
    draft: LotDraftProps,
    index: number,
  ): Promise<readonly Reply[]> {
    const category = (await this.catalog.categories()).slice(0, MAX_CATEGORIES)[index];
    const name = draft.fields.productQuery;
    if (!category || !name) return [{ text: t.stale }];
    if (!draft.fields.unit) {
      const saved = await this.save(draft, 'collecting', draft.fields, 'unit');
      return [this.questionReply(saved, 'unit')];
    }
    let product: DraftProduct;
    try {
      product = await this.catalog.proposeProduct(
        { sub: user.userId, role: user.role },
        { id: createId(), name, categoryId: category.id, unit: draft.fields.unit },
      );
    } catch {
      return [{ text: t.proposalFailed }];
    }
    return this.applyAndAsk(user, draft, {
      fields: this.withProduct(draft.fields, product),
      issue: null,
    });
  }

  /**
   * Claims the draft, creates (and publishes) the lot with the draft's fixed id and marks the
   * draft finished, all in the caller's transaction: two taps make one lot, and a failure
   * leaves the draft waiting for confirmation.
   */
  private async confirm(user: AssistantUser, draft: LotDraftProps): Promise<readonly Reply[]> {
    if (draft.status !== 'awaiting_confirmation') return [{ text: t.stale }];
    const fields = draft.fields;
    const now = this.clock.now();
    const window = availabilityWindow(
      fields.availableFromDay!,
      fields.availableUntilDay!,
      now,
      this.settings.lotHorizonDays,
    );
    if (window.kind !== 'ok') {
      await this.save(
        draft,
        'collecting',
        { ...fields, availableUntilDay: undefined },
        'available_until',
      );
      return [{ text: `${t.issues[window.kind]} ${t.questions.available_until}` }];
    }
    const pending = fields.product!.pending;
    const finished = transitionDraft(draft, pending ? 'saved_as_draft' : 'confirmed', now);
    if (!(await this.drafts.update(finished, draft.version))) return [{ text: t.stale }];
    try {
      await this.catalog.createLot(
        { sub: user.userId, role: user.role },
        {
          lotId: draft.lotId,
          product: fields.product!,
          quantityMilli: BigInt(fields.quantityMilli!),
          unitPrice: BigInt(fields.unitPrice!),
          qualityGrade: fields.quality ?? null,
          availableFrom: window.from,
          availableUntil: window.until,
          lat: fields.location!.lat,
          lng: fields.location!.lng,
        },
        !pending,
      );
    } catch (error) {
      throw new ConfirmationFailed(error);
    }
    return [{ text: pending ? t.savedAsDraft : t.published }];
  }

  // ---------------------------------------------------------------- consent

  private consentRequest(): Reply {
    return {
      text: t.consentRequest,
      buttons: [
        [
          { text: t.accept, action: 'c:yes' },
          { text: t.decline, action: 'c:no' },
        ],
      ],
    };
  }

  private async consentStatus(user: AssistantUser): Promise<readonly Reply[]> {
    const status = await this.consent.status(user.userId, this.settings.consentVersion);
    if (status === 'accepted')
      return [
        {
          text: t.consentStatusAccepted,
          buttons: [[{ text: t.withdraw, action: 'c:withdraw' }]],
        },
      ];
    return [{ text: t.consentStatusNone }, this.consentRequest()];
  }

  private async handleConsent(user: AssistantUser, action: string): Promise<readonly Reply[]> {
    const version = this.settings.consentVersion;
    if (action === 'c:yes') {
      await this.uow.run(async () => {
        await this.drafts.lockUser(user.userId);
        await this.consent.accept(user.userId, version);
        const draft = await this.drafts.findActive(user.userId);
        if (draft?.fields.aiDeclined)
          await this.save(
            draft,
            draft.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'collecting',
            { ...draft.fields, aiDeclined: undefined },
            draft.question,
          );
      });
      return [{ text: t.consentAccepted }];
    }
    if (action === 'c:withdraw') {
      await this.consent.withdraw(user.userId, version);
      return [{ text: t.consentWithdrawn }];
    }
    if (action === 'c:no') {
      await this.uow.run(async () => {
        await this.drafts.lockUser(user.userId);
        const draft = await this.drafts.findActive(user.userId);
        if (draft && !isExpired(draft, this.clock.now()))
          await this.save(
            draft,
            draft.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'collecting',
            { ...draft.fields, aiDeclined: true },
            draft.question,
          );
      });
      return [{ text: t.consentDeclined }];
    }
    return [{ text: t.stale }];
  }
}

/** Raised inside the confirmation transaction so it rolls back as a whole. */
export class ConfirmationFailed extends Error {
  constructor(readonly causeError: unknown) {
    super('Lot confirmation failed.');
    this.name = 'ConfirmationFailed';
  }
}
