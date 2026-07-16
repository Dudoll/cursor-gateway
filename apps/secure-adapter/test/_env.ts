// Must be imported FIRST: the server's csapi/secure.ts pulls in config.ts, which
// validates required env at module load. Provide dummy values so the module graph
// evaluates in tests (these are never used by the secure channel logic under test).
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-chars-long";
process.env.DATABASE_URL ??= "postgres://localhost:5432/test";
process.env.RUNNER_SHARED_SECRET ??= "test-runner-shared-secret-min-32-characters";
