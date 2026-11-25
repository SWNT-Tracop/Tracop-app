import { DomainError } from '../../../shared/kernel/domain-error.js';

export const VERIFICATION_STATES = [
  'unverified',
  'pending',
  'verified',
  'rejected',
  'revoked',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATES)[number];

/** What the staff confirmed before approving; all are required (AGENTS §23.8 is still open). */
export const VERIFICATION_CHECKS = [
  'contact_confirmed',
  'location_confirmed',
  'reference_checked',
] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

export interface VerificationProps {
  readonly providerId: string;
  readonly status: VerificationStatus;
  readonly note: string | null;
  readonly checks: Readonly<Record<VerificationCheck, boolean>> | null;
  readonly reason: string | null;
  readonly requestedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly version: number;
}

const MAX_NOTE = 300;
const MAX_REASON = 300;

const text = (value: string | null | undefined, max: number, code: string, required: boolean) => {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    if (required) throw new DomainError('El motivo es obligatorio.', code);
    return null;
  }
  if (trimmed.length > max) throw new DomainError(`El texto supera ${max} caracteres.`, code);
  return trimmed;
};

export const unverified = (providerId: string): VerificationProps => ({
  providerId,
  status: 'unverified',
  note: null,
  checks: null,
  reason: null,
  requestedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  version: 0,
});

/**
 * The provider asks to be verified. Allowed from unverified, and from rejected or revoked once
 * the cooldown since that decision is over.
 */
export const requestVerification = (
  current: VerificationProps,
  note: string | null | undefined,
  now: Date,
  cooldownDays: number,
): VerificationProps => {
  if (current.status === 'pending' || current.status === 'verified')
    throw new DomainError('La verificación ya está en curso o aprobada.', 'invalid_transition');
  if (
    (current.status === 'rejected' || current.status === 'revoked') &&
    current.reviewedAt &&
    now.getTime() < current.reviewedAt.getTime() + cooldownDays * 86_400_000
  )
    throw new DomainError(
      'Debes esperar para volver a solicitar la verificación.',
      'verification_cooldown',
      {
        retryAfter: new Date(
          current.reviewedAt.getTime() + cooldownDays * 86_400_000,
        ).toISOString(),
      },
    );
  return {
    ...current,
    status: 'pending',
    note: text(note, MAX_NOTE, 'invalid_note', false),
    checks: null,
    reason: null,
    requestedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    version: current.version + 1,
  };
};

export const approveVerification = (
  current: VerificationProps,
  checks: Readonly<Record<string, boolean>>,
  reviewerId: string,
  now: Date,
): VerificationProps => {
  if (current.status !== 'pending')
    throw new DomainError('Solo se aprueba una solicitud pendiente.', 'invalid_transition');
  const missing = VERIFICATION_CHECKS.filter((check) => checks[check] !== true);
  if (missing.length)
    throw new DomainError('Faltan comprobaciones para aprobar.', 'verification_checks_incomplete', {
      missing,
    });
  return {
    ...current,
    status: 'verified',
    checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
    reason: null,
    reviewedBy: reviewerId,
    reviewedAt: now,
    version: current.version + 1,
  };
};

export const rejectVerification = (
  current: VerificationProps,
  reason: string,
  reviewerId: string,
  now: Date,
): VerificationProps => {
  if (current.status !== 'pending')
    throw new DomainError('Solo se rechaza una solicitud pendiente.', 'invalid_transition');
  return {
    ...current,
    status: 'rejected',
    reason: text(reason, MAX_REASON, 'reason_required', true),
    reviewedBy: reviewerId,
    reviewedAt: now,
    version: current.version + 1,
  };
};

export const revokeVerification = (
  current: VerificationProps,
  reason: string,
  reviewerId: string,
  now: Date,
): VerificationProps => {
  if (current.status !== 'verified')
    throw new DomainError('Solo se revoca una verificación aprobada.', 'invalid_transition');
  return {
    ...current,
    status: 'revoked',
    reason: text(reason, MAX_REASON, 'reason_required', true),
    reviewedBy: reviewerId,
    reviewedAt: now,
    version: current.version + 1,
  };
};
