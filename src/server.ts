import { createServer } from "http";

import { createApp } from "./app";
import { env } from "./config/env";
import { attachSocketServer } from "./socket";

const app = createApp();
const server = createServer(app);
attachSocketServer(server);

server.listen(env.PORT, () => {
  console.log(
    `[backend-klinik-sofeng] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`\n[backend-klinik-sofeng] received ${signal}, shutting down...`);
  server.close((err) => {
    if (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
