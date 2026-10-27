import { Cursor } from "@cursor/sdk";

const result = await Cursor.auth.login({
  apiKeyName: "grokeado-court",
  onLoginUrl: (url) => console.log("LOGIN_URL " + url),
});
console.log("logged in as " + (result.email ?? "unknown") + ", key expires " + new Date(result.apiKeyExpiresAtMs).toISOString());
