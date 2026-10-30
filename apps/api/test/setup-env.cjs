const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const state = JSON.parse(
  readFileSync(join(tmpdir(), 'tracop-identity-test-container.json'), 'utf8'),
);
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: state.connectionString,
  JWT_SECRET: 'test-jwt-secret-not-for-real-use-000000000000',
  JWT_ISSUER: 'tracop',
  JWT_AUDIENCE: 'tracop-api',
  JWT_CLOCK_TOLERANCE_SECONDS: '5',
  OTP_HMAC_SECRET: 'test-otp-hmac-secret-not-for-real-use-00000000',
  RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-hmac-not-for-real-use-0000000',
  PRIVACY_POLICY_VERSION: 'v0-draft',
  ALLOWED_COUNTRY_CODES: '57',
  TRUST_PROXY: 'false',
  OTP_SENDER: 'console',
});
