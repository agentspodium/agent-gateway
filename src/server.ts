// Process entrypoint: reads env, builds the app, listens.

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config });

app
  .listen({ host: "0.0.0.0", port: config.port })
  .then(() => {
    console.log(`agent-gateway listening on :${config.port}, ACCOUNT_API=${config.accountApiUrl}`);
  })
  .catch((err) => {
    console.error("agent-gateway failed to start:", err);
    process.exit(1);
  });
