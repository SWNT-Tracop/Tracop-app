import pino from 'pino';

const maskPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  return digits.length < 4 ? '***' : `***${digits.slice(-4)}`;
};

export const maskSensitiveFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(maskSensitiveFields);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => {
      if (/otp|token|secret|authorization|refresh|password/i.test(key)) return [key, '[REDACTED]'];
      if (/^(ip|remoteaddress|remote_address|x-forwarded-for|xforwardedfor)$/i.test(key))
        return [key, '[REDACTED]'];
      if (key === 'phone' && typeof fieldValue === 'string') return [key, maskPhone(fieldValue)];
      return [key, maskSensitiveFields(fieldValue)];
    }),
  );
};

export const createLogger = (
  environment: string,
  destination?: pino.DestinationStream,
): pino.Logger =>
  pino(
    {
      level: environment === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'otp',
          '*.otp',
          'code',
          '*.code',
          'token',
          '*.token',
          'accessToken',
          'refreshToken',
          '*.accessToken',
          '*.refreshToken',
          'authorization',
          'req.headers.authorization',
          'phone',
          '*.phone',
          'req.body.phone',
          'ip',
          '*.ip',
          'req.ip',
          'remoteAddress',
          '*.remoteAddress',
          'req.socket.remoteAddress',
          'x-forwarded-for',
          '*.x-forwarded-for',
          'req.headers["x-forwarded-for"]',
          'botToken',
          '*.botToken',
          'webhookSecret',
          '*.webhookSecret',
          'secretToken',
          '*.secretToken',
          'channelUserId',
          '*.channelUserId',
          'channel_user_id',
          '*.channel_user_id',
          'chatId',
          '*.chatId',
          'chat_id',
          '*.chat_id',
          'phoneNumber',
          '*.phoneNumber',
          'phone_number',
          '*.phone_number',
          'contact',
          '*.contact',
          'text',
          '*.text',
          'message',
          '*.message',
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
