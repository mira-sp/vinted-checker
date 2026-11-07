// Must be the first import: ES modules run in import order, and other modules
// read environment variables when they load.
import "dotenv/config";
import { buildApp } from "./app.js";
import { warmUp } from "./embeddings.js";
import { webSearchEnabled } from "./matching.js";

const port = Number(process.env.PORT ?? 3000);
const app = await buildApp({ port });

app.log.info({ webSearch: webSearchEnabled() }, "Google Vision web search");

await app.listen({ port, host: "127.0.0.1" });

// Load the CLIP model in the background so the first paste isn't slow.
warmUp()
  .then(() => app.log.info("CLIP model ready"))
  .catch((err) => app.log.error({ err }, "CLIP model failed to load (needs internet on first run)"));
