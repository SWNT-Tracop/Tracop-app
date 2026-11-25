export class DomainError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, code: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'DomainError';
  }
}

export class RateLimitExceeded extends DomainError {
  constructor(readonly retryAfter: number) {
    super('Demasiadas solicitudes. Intenta nuevamente más tarde.', 'rate_limited');
    this.name = 'RateLimitExceeded';
  }
}
