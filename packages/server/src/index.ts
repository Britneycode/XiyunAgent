import { serve } from "@hono/node-server";
import { openDb, DATA_DIR } from "./db.ts";
import { MemoryStore } from "./memory.ts";
import { ProviderStore } from "./providers.ts";
import { createApp } from "./app.ts";

const port = Number(process.env.XIYUN_PORT ?? 3777);
const db = openDb();
const app = createApp(db, new MemoryStore(db), new ProviderStore(DATA_DIR));

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`xiyun server listening on http://127.0.0.1:${info.port}`);
});
