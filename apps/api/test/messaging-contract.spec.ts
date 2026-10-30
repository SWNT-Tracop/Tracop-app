import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryMessagingAdapter, TelegramAdapter } from '../src/modules/messaging/index.js';

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

const startFakeTelegram = async (): Promise<{
  server: Server;
  apiRoot: string;
  requests: CapturedRequest[];
  respondWith: (status: number, body: unknown) => void;
}> => {
  const requests: CapturedRequest[] = [];
  let response: { status: number; body: unknown } = {
    status: 200,
    body: {
      ok: true,
      result: {
        message_id: 1,
        date: 1_767_225_600,
        chat: { id: 900001, type: 'private' },
        text: 'ok',
      },
    },
  };
  const server = createServer((request: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requests.push({ path: request.url ?? '', body: await readBody(request) });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    apiRoot: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (status, body) => {
      response = { status, body };
    },
  };
};

const recipient = { channel: 'telegram' as const, channelUserId: '900001' };

describe('MessagingPort contract', () => {
  let fake: Awaited<ReturnType<typeof startFakeTelegram>>;

  beforeEach(async () => {
    fake = await startFakeTelegram();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      fake.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('delivers text through the in-memory adapter', async () => {
    const adapter = new InMemoryMessagingAdapter();
    const result = await adapter.sendText(recipient, 'Hola');
    expect(result.ok).toBe(true);
    expect(adapter.sent).toEqual([{ to: recipient, text: 'Hola' }]);
  });

  it('delivers text through the Telegram adapter without contacting the real API', async () => {
    const adapter = new TelegramAdapter({ token: '123456:test-token', apiRoot: fake.apiRoot });
    const result = await adapter.sendText(recipient, 'Hola');

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe('/bot123456:test-token/sendMessage');
    expect(fake.requests[0]?.body).toMatchObject({ chat_id: '900001', text: 'Hola' });
  });

  it('builds a native contact request keyboard', async () => {
    const adapter = new TelegramAdapter({ token: '123456:test-token', apiRoot: fake.apiRoot });
    const result = await adapter.sendButtons(recipient, 'Comparte tu contacto', [
      { text: 'Compartir', kind: 'request_contact' },
    ]);

    expect(result.ok).toBe(true);
    expect(fake.requests[0]?.body.reply_markup).toMatchObject({
      keyboard: [[{ text: 'Compartir', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  });

  it('builds inline action buttons', async () => {
    const adapter = new TelegramAdapter({ token: '123456:test-token', apiRoot: fake.apiRoot });
    await adapter.sendButtons(recipient, 'Elige', [
      { text: 'Aceptar', kind: 'action', action: 'accept', payload: { orderId: '1' } },
    ]);

    expect(fake.requests[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: 'Aceptar',
            callback_data: JSON.stringify({ action: 'accept', payload: { orderId: '1' } }),
          },
        ],
      ],
    });
  });

  it.each([
    [
      403,
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' },
      'blocked_by_user',
    ],
    [
      429,
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 7 },
      },
      'rate_limited',
    ],
    [
      400,
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      'invalid_recipient',
    ],
    [500, { ok: false, error_code: 500, description: 'Internal Server Error' }, 'unavailable'],
  ] as const)('maps Telegram status %s to %s', async (status, body, kind) => {
    fake.respondWith(status, body);
    const adapter = new TelegramAdapter({ token: '123456:test-token', apiRoot: fake.apiRoot });
    const result = await adapter.sendText(recipient, 'Hola');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(kind);
      if (result.error.kind === 'rate_limited') {
        expect(result.error.retryAfterSeconds).toBe(7);
      }
    }
  });

  it('rejects non-Telegram recipients without calling the API', async () => {
    const adapter = new TelegramAdapter({ token: '123456:test-token', apiRoot: fake.apiRoot });
    const result = await adapter.sendText({ channel: 'whatsapp', channelUserId: '1' }, 'Hola');

    expect(result).toEqual({ ok: false, error: { kind: 'invalid_recipient' } });
    expect(fake.requests).toHaveLength(0);
  });
});
