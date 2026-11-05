import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_LOGGER } from './tokens.js';
import type pino from 'pino';
import type { BackgroundDispatcher } from '../ports/background-dispatcher.js';

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

@Injectable()
export class ImmediateBackgroundDispatcher implements BackgroundDispatcher, OnApplicationShutdown {
  private readonly pending = new Set<Promise<void>>();

  constructor(@Inject(APP_LOGGER) private readonly logger: pino.Logger) {}

  dispatch(task: () => Promise<void>): void {
    const running = task()
      .catch((error: unknown) => {
        this.logger.warn(
          {
            event: 'background_task_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorCode:
              typeof error === 'object' && error !== null && 'code' in error
                ? String((error as { code: unknown }).code)
                : undefined,
          },
          'Background task failed.',
        );
      })
      .finally(() => {
        this.pending.delete(running);
      });
    this.pending.add(running);
  }

  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.pending]).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }
}
