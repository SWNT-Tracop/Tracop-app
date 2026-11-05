import { DomainError } from '../../../shared/kernel/domain-error.js';

export interface SessionRevoked {
  readonly type: 'SessionRevoked';
  readonly userId: string;
  readonly deviceId: string;
  readonly familyId: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface SessionProps {
  id: string;
  userId: string;
  deviceId: string;
  familyId: string;
  refreshHash: string;
  expiresAt: Date;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
}

export class Session {
  constructor(readonly props: SessionProps) {}

  assertActive(now: Date): void {
    if (this.props.revokedAt || this.props.rotatedAt)
      throw new DomainError('La sesión no es válida.', 'session_invalid');
    if (now.getTime() >= this.props.expiresAt.getTime())
      throw new DomainError('La sesión ha vencido.', 'session_expired');
  }

  rotate(now: Date): void {
    this.assertActive(now);
    this.props.rotatedAt = now;
    this.props.lastUsedAt = now;
  }

  revoke(now: Date, reason: string): void {
    this.props.revokedAt = now;
    this.props.revokedReason = reason;
  }

  revokedEvent(reason: string, occurredAt: Date): SessionRevoked {
    return {
      type: 'SessionRevoked',
      userId: this.props.userId,
      deviceId: this.props.deviceId,
      familyId: this.props.familyId,
      reason,
      occurredAt: occurredAt.toISOString(),
    };
  }
}
