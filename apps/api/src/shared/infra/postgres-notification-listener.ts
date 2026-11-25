import pg from 'pg';
import type pino from 'pino';

const RECONNECT_DELAY_MS = 5_000;

/**
 * LISTENs to one PostgreSQL channel and runs `onNotify` once per burst: notifications that
 * arrive while it runs trigger exactly one more run. Reconnects after a lost connection; the
 * worker's periodic job covers any notification missed in between.
 */
export class PostgresNotificationListener {
  private client: pg.Client | null = null;
  private running = false;
  private pending = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly channel: string,
    private readonly onNotify: () => Promise<unknown>,
    private readonly logger: pino.Logger,
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) throw new Error('Invalid channel name.');
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  /** Runs now, or once more after the current run. */
  trigger(): void {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    void this.onNotify()
      .catch((error: unknown) =>
        this.logger.warn(
          {
            event: 'notification_handler_failed',
            errorName: error instanceof Error ? error.name : 'Error',
          },
          'Notification handler failed.',
        ),
      )
      .finally(() => {
        this.running = false;
        if (this.pending && !this.stopped) {
          this.pending = false;
          this.trigger();
        }
      });
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', () => this.trigger());
    client.on('error', () => this.reconnect(client));
    client.on('end', () => this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${this.channel}`);
      this.client = client;
      // Anything queued before we listened.
      this.trigger();
    } catch {
      this.reconnect(client);
    }
  }

  private reconnect(client: pg.Client): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.client === client) this.client = null;
    void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
