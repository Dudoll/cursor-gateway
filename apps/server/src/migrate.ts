/**
 * One-shot schema migration entrypoint.
 * Deploy: node apps/server/dist/migrate.js && SKIP_INLINE_MIGRATE=1 node apps/server/dist/index.js
 */
import { migrate, pool } from "./db.js";

async function main() {
  const started = Date.now();
  await migrate();
  console.log(JSON.stringify({ ok: true, migrateMs: Date.now() - started }));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
