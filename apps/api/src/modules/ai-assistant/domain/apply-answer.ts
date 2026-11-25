import { isWithinColombia } from '../../../shared/kernel/geo.js';
import { parseDay } from './dates.js';
import type { DraftFields, DraftQuestion } from './lot-draft.js';
import {
  parseCop,
  parseQuantityMilli,
  parseUnit,
  unitPriceFrom,
  type PriceBasis,
} from './parsing.js';

/**
 * What the model pointed at in the user's words. Every value is a short span of text; the
 * numbers, units and dates are parsed here, never taken from the model.
 */
export interface Extraction {
  readonly product: string | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly price: string | null;
  readonly priceBasis: PriceBasis | null;
  readonly quality: string | null;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
}

/** Why a value could not be used; the bot asks again about that field. */
export type AnswerIssue =
  | 'unsupported_unit'
  | 'invalid_quantity'
  | 'invalid_price'
  | 'ambiguous_price'
  | 'ambiguous_date'
  | 'invalid_date'
  | 'outside_colombia';

export interface ApplyResult {
  readonly fields: DraftFields;
  readonly issue: { readonly question: DraftQuestion; readonly reason: AnswerIssue } | null;
}

export const QUALITY_MAX_LENGTH = 100;

const withPrice = (fields: DraftFields): DraftFields => {
  if (!fields.priceAmount || !fields.priceBasis || !fields.quantityMilli) return fields;
  const unitPrice = unitPriceFrom(
    BigInt(fields.priceAmount),
    fields.priceBasis,
    BigInt(fields.quantityMilli),
  );
  return unitPrice === null ? fields : { ...fields, unitPrice: unitPrice.toString() };
};

/**
 * Merges an extraction into the draft. The first problem found becomes the next question;
 * values the user already gave are kept.
 */
export const applyExtraction = (
  current: DraftFields,
  extraction: Extraction,
  now: Date,
): ApplyResult => {
  let fields: DraftFields = { ...current };
  let issue: ApplyResult['issue'] = null;
  const flag = (question: DraftQuestion, reason: AnswerIssue) => {
    issue ??= { question, reason };
  };

  if (extraction.product && !fields.product) {
    fields = { ...fields, productQuery: extraction.product.trim().slice(0, 60) };
  }
  if (extraction.quantity) {
    const quantity = parseQuantityMilli(extraction.quantity);
    if (quantity === null) flag('quantity', 'invalid_quantity');
    else fields = { ...fields, quantityMilli: quantity.toString(), unitPrice: undefined };
  }
  if (extraction.unit) {
    const unit = parseUnit(extraction.unit);
    if (unit.kind === 'unsupported') flag('unit', 'unsupported_unit');
    else fields = { ...fields, unit: unit.unit };
  }
  if (extraction.price) {
    const amount = parseCop(extraction.price);
    if (amount === null || amount <= 0n) flag('price', 'invalid_price');
    else
      fields = {
        ...fields,
        priceAmount: amount.toString(),
        priceBasis: extraction.priceBasis ?? undefined,
        unitPrice: undefined,
      };
  }
  if (extraction.quality) {
    fields = { ...fields, quality: extraction.quality.trim().slice(0, QUALITY_MAX_LENGTH) || null };
  }
  for (const [key, field, question] of [
    ['availableFrom', 'availableFromDay', 'available_from'],
    ['availableUntil', 'availableUntilDay', 'available_until'],
  ] as const) {
    const text = extraction[key];
    if (!text) continue;
    const day = parseDay(text, now);
    if (day.kind === 'day') fields = { ...fields, [field]: day.date };
    else flag(question, day.kind === 'ambiguous' ? 'ambiguous_date' : 'invalid_date');
  }

  fields = withPrice(fields);
  if (fields.priceAmount && fields.priceBasis && fields.quantityMilli && !fields.unitPrice)
    flag('price', 'ambiguous_price');
  return { fields, issue };
};

/**
 * The answer to the one question the bot asked, parsed without the model. Used by the guided
 * form and for short replies («3», «mañana») so they cost no model call.
 */
export const answerQuestion = (
  current: DraftFields,
  question: DraftQuestion,
  text: string,
  now: Date,
): ApplyResult | null => {
  const empty: Extraction = {
    product: null,
    quantity: null,
    unit: null,
    price: null,
    priceBasis: null,
    quality: null,
    availableFrom: null,
    availableUntil: null,
  };
  switch (question) {
    case 'quantity':
    case 'unit_mismatch': {
      const quantity = parseQuantityMilli(text);
      if (quantity === null)
        return { fields: current, issue: { question, reason: 'invalid_quantity' } };
      // The answer is in the product's own unit; a price per the other unit no longer applies.
      const base =
        question === 'unit_mismatch' && current.priceBasis === 'unit'
          ? { ...current, priceAmount: undefined, priceBasis: undefined }
          : current;
      return {
        fields: withPrice({
          ...base,
          quantityMilli: quantity.toString(),
          unit: current.product?.unit ?? current.unit,
          unitPrice: undefined,
        }),
        issue: null,
      };
    }
    case 'unit':
      return applyExtraction(current, { ...empty, unit: text }, now);
    case 'price':
      // The question asks the price of each unit.
      return applyExtraction(current, { ...empty, price: text, priceBasis: 'unit' }, now);
    case 'available_from':
      return applyExtraction(current, { ...empty, availableFrom: text }, now);
    case 'available_until':
      return applyExtraction(current, { ...empty, availableUntil: text }, now);
    default:
      return null;
  }
};

export const choosePriceBasis = (current: DraftFields, basis: PriceBasis): ApplyResult => {
  const fields = withPrice({ ...current, priceBasis: basis, unitPrice: undefined });
  return {
    fields,
    issue: fields.unitPrice ? null : { question: 'price', reason: 'ambiguous_price' },
  };
};

export const useSharedLocation = (current: DraftFields, lat: number, lng: number): ApplyResult =>
  isWithinColombia(lat, lng)
    ? {
        fields: { ...current, location: { lat, lng, source: 'shared', municipality: null } },
        issue: null,
      }
    : { fields: current, issue: { question: 'location', reason: 'outside_colombia' } };
