import type { Pool } from 'pg';

export const describePostgres =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

export const resetPostgresFixtures = async (pool: Pool): Promise<void> => {
  await pool.query(`TRUNCATE recommendations.alert_matches, recommendations.price_alerts,
    recommendations.counted_orders, recommendations.buyer_history, recommendations.price_observations,
    recommendations.product_source_mappings, recommendations.reference_prices,
    recommendations.reference_imports,
    ai_assistant.lot_drafts, ai_assistant.inbox, ai_assistant.usage,
    ai_assistant.monthly_budget, identity.ai_consent_events,
    trust.ratings, trust.reputations, trust.carrier_delivery_stats, trust.counted_deliveries,
    trust.verifications,
    backoffice.audit_log, backoffice.parameters,
    notifications.deliveries, notifications.inbox,
    notifications.preferences, payments.ledger_entries, payments.ledger_transactions,
    payments.settlements, payments.payment_events, payments.payments,
    sync.processed_operations, sync.change_log,
    logistics.checkins, logistics.incidents, logistics.trip_stops, logistics.trips, logistics.carriers,
    ordering.order_events, ordering.quotes, ordering.order_lines, ordering.orders,
    catalog.lot_reservations, catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
    identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices,
    identity.channel_links, identity.users, identity.rate_limit_counters,
    messaging.processed_updates, shared.worker_heartbeats, shared.outbox_events CASCADE`);
};
