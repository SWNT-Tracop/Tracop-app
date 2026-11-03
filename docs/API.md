# API conventions

This document records behavior currently implemented by the API. It is not a statement of planned behavior. The generated endpoint contract is available in [OpenAPI](openapi.json).

## Authentication and sessions

- Routes guarded by the API `AuthGuard` require authentication by default. Explicitly public auth routes do not; the internal Telegram webhook is protected by its configured secret header instead. Authenticated requests send `Authorization: Bearer <accessToken>`.
- Endpoints may restrict roles in addition to requiring authentication. A missing/invalid credential returns HTTP 401; a role mismatch returns HTTP 403.
- `POST /auth/refresh` is public and accepts `refreshToken` and `deviceId` in the JSON body. It returns a new access token and refresh token. Refresh tokens are stored as hashes.
- Rotation binds the token to its device and session family. Reuse of an already rotated token revokes the family and returns an invalid-session error. The access-token lifetime defaults to 900 seconds and refresh-token lifetime to 2,592,000 seconds; both are configurable through environment variables.
- Do not put refresh tokens in URLs or logs.

## HTTP errors

The response body is a JSON object. Depending on the error, it contains:

```json
{ "statusCode": 400, "code": "invalid_cursor", "message": "..." }
```

`statusCode` and `message` are present in the shared error format; `code` is included for domain errors and may be absent otherwise. Validation errors return 400 with a generic message. Unhandled errors return 500 with `{"statusCode":500,"message":"Error interno."}`. A 429 response may also include `Retry-After` in seconds. See the endpoint-specific responses in [OpenAPI](openapi.json).

## Pagination

`GET /lots` (visible-lot search) accepts `limit` from 1 to 50 (default 20) and an optional `cursor`. The response contains `items` and, when another page exists, `nextCursor`. The cursor is opaque and encrypted: return it unchanged as the next request's `cursor`; do not parse or modify it. It is bound to the selected sort order, so changing `sort` while reusing a cursor is invalid.

This cursor convention is implemented for catalog lot search; do not assume all list endpoints are paginated this way.

## IDs and idempotency

- Lot creation validates that its client-supplied ID is UUID v7. Category and product creation also accept a client-supplied ID, but their schemas validate UUID format without enforcing version 7. Do not infer uniform UUID v7 enforcement across create endpoints.
- No general HTTP idempotency-key contract is currently implemented. The Telegram update handler deduplicates processed updates by Telegram `updateId`; this is specific to Telegram webhook processing, not a client API idempotency guarantee.

## Rate limits

Rate limits are configurable; the following are the current default settings:

| Surface | Default limit | Behavior |
| --- | --- | --- |
| Catalog lot search | 60 requests per authenticated user per 60-second window | In-memory limiter; excess requests return 429 and `Retry-After`. |
| Telegram webhook | 20 updates per sender and 300 globally per 60-second window | In-memory limiter; excess updates are dropped without a reply, while the webhook acknowledges the update with HTTP 200. Sender identifiers are HMAC-keyed in the limiter. |
| OTP requests | 3 per phone per 600-second window; 1 per phone per 60-second cooldown | Additional request limits are 30 per IP for OTP requests and 60 per IP for OTP verification, each per 600 seconds. These limits are configurable. |

These defaults are not a guarantee of globally coordinated limits across multiple API instances: the catalog and Telegram limiters are in-memory. The OTP counters use the database-backed identity rate-limit repository.

## Location privacy

Lot search accepts `lat`, `lng`, and `radiusKm` together. Coordinates outside Colombia are rejected when both `lat` and `lng` are supplied. In lot responses, exact lot coordinates and `providerId` are included only for the lot's provider. Other viewers may receive a rounded `distanceKm` when search computed one; this is not an exact location. The search radius is subject to the server-configured maximum. These response rules are specifically enforced by catalog lot serialization and should not be assumed for unrelated endpoints.
