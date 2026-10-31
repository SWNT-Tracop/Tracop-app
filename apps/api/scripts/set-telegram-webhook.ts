import { loadAppEnvironment } from '../src/shared/infra/env.js';

const TELEGRAM_API_ROOT = 'https://api.telegram.org';

const main = async (): Promise<void> => {
  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    throw new Error(
      'Usage: pnpm --filter @tracop/api telegram:set-webhook -- https://api.example.com/webhooks/telegram',
    );
  }
  const parsedUrl = new URL(webhookUrl);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Telegram requires an HTTPS webhook URL.');
  }

  const environment = loadAppEnvironment();
  if (!environment.TELEGRAM_BOT_TOKEN || !environment.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required.');
  }

  const response = await fetch(
    `${TELEGRAM_API_ROOT}/bot${environment.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: environment.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
    },
  );
  const result = (await response.json()) as { ok: boolean; description?: string };
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram rejected the webhook: ${result.description ?? response.status}`);
  }
  process.stdout.write('Telegram webhook configured.\n');
};

void main();
