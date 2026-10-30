import { DomainError } from '../../../shared/kernel/domain-error.js';

export type OtpPurpose = 'registration' | 'login';

export interface OtpProps {
  id: string;
  userId: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export class Otp {
  constructor(readonly props: OtpProps) {}

  assertUsable(now: Date): void {
    if (this.props.consumedAt) throw new DomainError('El código ya fue utilizado.', 'invalid_otp');
    if (now.getTime() >= this.props.expiresAt.getTime())
      throw new DomainError('El código ha vencido.', 'otp_expired');
    if (this.props.attempts >= this.props.maxAttempts)
      throw new DomainError('Se agotaron los intentos permitidos.', 'otp_attempts_exceeded');
  }

  recordFailedAttempt(): void {
    this.props.attempts += 1;
    if (this.props.attempts >= this.props.maxAttempts) {
      throw new DomainError('Se agotaron los intentos permitidos.', 'otp_attempts_exceeded');
    }
  }

  consume(now: Date): void {
    this.assertUsable(now);
    this.props.consumedAt = now;
  }
}
