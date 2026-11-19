import type { Pool } from 'pg';

export const describePostgres =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

export const resetPostgresFixtures = async (pool: Pool): Promise<void> => {
  await pool.query(`TRUNCATE sync.processed_operations, sync.change_log,
    ordering.order_events, ordering.quotes, ordering.order_lines, ordering.orders,
    catalog.lot_reservations, catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
    identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices,
    identity.channel_links, identity.users, messaging.processed_updates, shared.outbox_events CASCADE`);
};
