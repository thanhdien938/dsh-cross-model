-- Run as a PostgreSQL administrator after dsh_coordination v4 migration.
-- Replace dsh_owner_adapter_login with the deployment login role.
GRANT USAGE ON SCHEMA dsh_coordination TO dsh_owner_adapter_login;
GRANT SELECT ON dsh_coordination.schema_migrations TO dsh_owner_adapter_login;
GRANT SELECT, INSERT, UPDATE ON dsh_coordination.owner_command TO dsh_owner_adapter_login;
GRANT SELECT, INSERT, UPDATE ON dsh_coordination.owner_interaction TO dsh_owner_adapter_login;
GRANT SELECT, INSERT ON dsh_coordination.owner_decision TO dsh_owner_adapter_login;
REVOKE ALL ON dsh_coordination.work_items, dsh_coordination.coordinator_leadership,
  dsh_coordination.worker_incarnations, dsh_coordination.coordinator_incarnations,
  dsh_coordination.cancellation_requests FROM dsh_owner_adapter_login;
