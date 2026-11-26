/**
 * Staff who run logistics from the backoffice: list every trip, carrier and incident, see exact
 * locations (audited), reassign duplicated orders and resolve incidents. The admin can do
 * everything the operator can, as in every other staff area (ADR-013).
 */
export const LOGISTICS_STAFF_ROLES = ['operator', 'admin'] as const;

export const isLogisticsStaff = (role: string): boolean =>
  (LOGISTICS_STAFF_ROLES as readonly string[]).includes(role);
