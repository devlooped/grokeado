export const LOCAL_DATABASE = "grokeado_local_fixture";

// Validate the effective Next.js environment, not just a line in .env.local.
// Never include a connection string in errors: it may contain production secrets.
export function requireLocalDatabase(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env.DATABASE_URL;
  if (!value) throw new Error("Local database preflight: DATABASE_URL must be explicit; POSTGRES_URL fallback is not allowed.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Local database preflight: invalid DATABASE_URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== `/${LOCAL_DATABASE}` || url.username !== "grokeado" ||
      !url.password || (url.port && url.port !== "5432") || url.search || url.hash) {
    throw new Error("Local database preflight: require loopback:5432, user grokeado, database grokeado_local_fixture, and no URL options.");
  }
  return value;
}
