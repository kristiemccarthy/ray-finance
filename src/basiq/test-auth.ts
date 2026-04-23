import { getServerToken } from "./auth.js";

const apiKey = process.env.BASIQ_API_KEY;
if (!apiKey) {
  console.error("BASIQ_API_KEY environment variable is not set.");
  process.exit(1);
}

try {
  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    const token = await getServerToken(apiKey);
    const elapsed = Date.now() - start;
    const source = elapsed > 100 ? "network" : "cache";
    console.log(`Call ${i}: ${token.slice(0, 20)}...  (${elapsed}ms, ${source})`);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
