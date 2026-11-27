-- Proof that the deploy pipeline applies migrations (docs/deploy.md, Migrations). It changes nothing: it only
-- sets the lock timeout every migration must set.
set lock_timeout = '3s';
