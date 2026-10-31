export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

export interface AuthPrincipal {
  readonly sub: string;
  readonly role: string;
  readonly sid: string;
  readonly did: string;
  readonly jti: string;
  readonly exp: number;
}

export type TokenVerification =
  | { readonly principal: AuthPrincipal; readonly reason?: undefined }
  | { readonly principal: null; readonly reason: 'invalid_token' | 'invalid_session' };

export interface AccessTokenVerifierPort {
  verify(token: string): Promise<TokenVerification>;
}
