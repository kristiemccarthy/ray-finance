// One-off script to create a Basiq user.
// Run with:
//   BASIQ_API_KEY=... npx tsx src/basiq/create-user.ts
// Optional overrides:
//   BASIQ_USER_EMAIL=...  BASIQ_USER_MOBILE=+614...
// Delete this file once the userId has been captured into ~/.ray/config.json.

import { BasiqClient } from "./client.js";
import type { BasiqUser } from "./types.js";

const DEFAULT_EMAIL = "kristie+ray-sandbox@example.com";
const DEFAULT_MOBILE = "+61400000000";

async function main(): Promise<void> {
  const apiKey = process.env.BASIQ_API_KEY;
  if (!apiKey) {
    console.error(
      "BASIQ_API_KEY environment variable is not set. Set it and re-run.",
    );
    process.exit(1);
  }

  const email = process.env.BASIQ_USER_EMAIL ?? DEFAULT_EMAIL;
  const mobile = process.env.BASIQ_USER_MOBILE ?? DEFAULT_MOBILE;

  const client = new BasiqClient({ apiKey });

  const user = await client.post<BasiqUser>("/users", { email, mobile });

  console.log("Basiq user created:");
  console.log(`  userId: ${user.id}`);
  console.log(`  email:  ${user.email}`);
  console.log(`  mobile: ${user.mobile}`);
  console.log("");
  console.log(
    "Save this userId. Add it to your Ray config as basiqUserId in ~/.ray/config.json",
  );
}

main().catch((err) => {
  console.error("Failed to create Basiq user:");
  console.error(err);
  process.exit(1);
});
