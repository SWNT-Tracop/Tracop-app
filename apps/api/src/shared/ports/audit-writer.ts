/**
 * A sensitive staff action, written in the same transaction as the change it describes
 * (AGENTS §5.20). `before` and `after` hold only the fields that changed and never personal data.
 */
export interface AuditEntryInput {
  /** The staff user, or null for system actions such as the staff CLI. */
  readonly actorId: string | null;
  readonly actorRole: string;
  /** Verb in dot notation, e.g. `payment.verify`, `parameter.update`. */
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
}

export interface AuditWriter {
  record(entry: AuditEntryInput): Promise<void>;
}

export const AUDIT_WRITER = Symbol('AUDIT_WRITER');
