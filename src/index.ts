import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { createApp } from "./app.js";

// The API and seeding work without a key; only agent processing needs it.
if (!config.anthropicApiKey) {
  console.warn(
    "⚠ ANTHROPIC_API_KEY is not set — submitting and listing issues works, but agent " +
      "processing will fail until you set it (see .env.example).",
  );
}

const { repo, worker } = createApp();

const app = buildServer(repo);
const server = app.listen(config.port, () => console.log(`API listening on :${config.port}`));

void worker.start();

// Graceful shutdown: stop claiming new jobs, finish the in-flight one, close.
// Anything still leased is reclaimed on next startup via lease expiry.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    server.close(() => process.exit(0));
  });
}
