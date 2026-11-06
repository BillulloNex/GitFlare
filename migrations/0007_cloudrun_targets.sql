-- ─── Google Cloud Run deploy targets ────────────────────────────
--
-- deploy_targets.type gains 'cloudrun'. The runner clones the commit and runs
-- `gcloud run deploy --source .` with a service-account key that is stored
-- encrypted (v1:, ENCRYPTION_KEY) per target, or falls back to the runner's
-- GCP_SERVICE_ACCOUNT_KEY when the target has none.
--
-- PRODUCTION GUARD: SQLite has no `ADD COLUMN IF NOT EXISTS`; check
-- PRAGMA table_info(deploy_targets) before applying by hand.

ALTER TABLE deploy_targets ADD COLUMN gcp_project_id TEXT;
ALTER TABLE deploy_targets ADD COLUMN gcp_region TEXT;
ALTER TABLE deploy_targets ADD COLUMN gcp_service TEXT;
ALTER TABLE deploy_targets ADD COLUMN gcp_service_account_key_encrypted TEXT;

-- Public URL of the deployed service, when the target reports one (Cloud Run).
ALTER TABLE deployments ADD COLUMN service_url TEXT;
