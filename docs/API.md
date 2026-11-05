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

| Surface            | Default limit                                                         | Behavior                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog lot search | 60 requests per authenticated user per 60-second window               | In-memory limiter; excess requests return 429 and `Retry-After`.                                                                                                          |
| Telegram webhook   | 20 updates per sender and 300 globally per 60-second window           | In-memory limiter; excess updates are dropped without a reply, while the webhook acknowledges the update with HTTP 200. Sender identifiers are HMAC-keyed in the limiter. |
| OTP requests       | 3 per phone per 600-second window; 1 per phone per 60-second cooldown | Additional request limits are 30 per IP for OTP requests and 60 per IP for OTP verification, each per 600 seconds. These limits are configurable.                         |

These defaults are not a guarantee of globally coordinated limits across multiple API instances: the catalog and Telegram limiters are in-memory. The OTP counters use the database-backed identity rate-limit repository.

## Location privacy

Lot search accepts `lat`, `lng`, and `radiusKm` together. Coordinates outside Colombia are rejected when both `lat` and `lng` are supplied. In lot responses, exact lot coordinates and `providerId` are included only for the lot's provider. Other viewers may receive a rounded `distanceKm` when search computed one; this is not an exact location. The search radius is subject to the server-configured maximum. These response rules are specifically enforced by catalog lot serialization and should not be assumed for unrelated endpoints.

## Lot photos

All photo-management routes require authentication and the `producer` or `supplier` role. The caller must own the lot. Photo reads are included in lot responses as `photos: [{ id, position, url }]`; search/list responses include at most the first ready photo, while lot detail includes all ready photos. There are no separate `mediaRef` or `objectKey` response fields.

| Method and path                            | Purpose                                           | Request / result                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /lots/{id}/photos`                   | Reserve a photo and prepare a direct upload       | Body: `{ "photoId": "<UUID v7>" }`. Returns `state: "pending"` and `uploadPolicy: { url, fields, expiresAt }`; send the file to the returned URL using the returned POST fields. A retry may return `processing` or `ready` without a new policy. |
| `POST /lots/{id}/photos/{photoId}/confirm` | Validate/process the uploaded image               | No body. Returns `pending`/`processing`/`ready` state. A ready result means the processed photo is available in lot reads.                                                                                                                        |
| `DELETE /lots/{id}/photos/{photoId}`       | Soft-delete the photo and request object deletion | No body; returns `{ "status": "deleted" }`.                                                                                                                                                                                                       |
| `PATCH /lots/{id}/photos/order`            | Set the complete order of ready photos            | Body: `{ "photoIds": ["<photo UUID>", ...] }`; returns `{ "status": "ordered" }`.                                                                                                                                                                 |

Upload policies are size-limited and expire; supported input formats are JPEG, PNG, and WebP, and processed output is always WebP. Photo counts, byte/pixel/dimension limits, expiries, processing lease, and upload rate limits are configurable; see [README](../README.md#lot-photos). Presigned URLs and object keys are sensitive temporary access material. The upload key is necessarily returned as `fields.key`, and the random processed-object key is embedded in the presigned download URL; clients must not log or persist these URLs beyond their intended use. Responses do not expose independent media-reference/object-key properties. Exact lot coordinates and `providerId` are not exposed to third-party viewers; those fields are included only for the lot's provider, as described above. Do not infer privacy behavior for unrelated endpoints.
