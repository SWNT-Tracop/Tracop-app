-- Least privilege for the runtime role: the API and the worker read and write rows but never
-- change the schema. The roles themselves (and their passwords) are created by
-- scripts/provision-db-roles.ts, so no secret is ever written to a migration file; this
-- migration only grants, and it is a no-op on environments without the roles (tests, demo).
DO $$
DECLARE
  target_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracop_app') THEN
    RAISE NOTICE 'tracop_app does not exist; skipping least-privilege grants.';
    RETURN;
  END IF;

  FOREACH target_schema IN ARRAY ARRAY[
    'shared',
    'identity',
    'catalog',
    'ordering',
    'logistics',
    'payments',
    'notifications',
    'trust',
    'sync',
    'backoffice',
    'ai_assistant',
    'recommendations',
    'messaging'
  ]
  LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = target_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO tracop_app', target_schema);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO tracop_app',
      target_schema
    );
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO tracop_app', target_schema);
    -- Tables and sequences the migrations create from now on get the same grants.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tracop_app',
      target_schema
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO tracop_app',
      target_schema
    );
  END LOOP;
END
$$;
