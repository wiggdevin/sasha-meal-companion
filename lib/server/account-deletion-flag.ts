/**
 * Self-serve account deletion lands dark: `POST /api/account/delete` answers 404 `not_enabled` and
 * Settings hides the "Delete account" row until `ACCOUNT_DELETION_ENABLED=1`. Turn it on only after
 * migration 20261231230000_delete_account is applied to that environment's database.
 *
 * Its own module with no imports (the lib/server/taste-flag.ts pattern), so
 * `GET /api/account/delete/enabled` reads the switch without importing the deletion code.
 */
export function accountDeletionEnabled(): boolean {
  return process.env.ACCOUNT_DELETION_ENABLED === "1";
}
