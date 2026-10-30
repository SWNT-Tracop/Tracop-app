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
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
