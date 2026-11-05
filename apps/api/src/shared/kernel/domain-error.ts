export class DomainError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
  }
}

export class RateLimitExceeded extends DomainError {
  constructor(readonly retryAfter: number) {
    super('Demasiadas solicitudes. Intenta nuevamente más tarde.', 'rate_limited');
    this.name = 'RateLimitExceeded';
  }
}
