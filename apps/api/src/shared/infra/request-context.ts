import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the HTTP pipeline knows about the current request. The client IP stays in memory only:
 * whoever persists it (the audit log) stores an HMAC, never the address.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly clientIp: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, operation: () => T): T =>
  storage.run(context, operation);

export const currentRequestContext = (): RequestContext | undefined => storage.getStore();

export const newRequestContext = (clientIp: string | undefined): RequestContext => ({
  requestId: randomUUID(),
  clientIp: clientIp ?? null,
});
