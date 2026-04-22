import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { enqueueJob } from "./queue.js";
import { startHeartbeat } from "./heartbeat.js";
import { startWorker } from "./worker.js";

const WORKER_TOKEN = process.env.WORKER_TOKEN!;
if (!WORKER_TOKEN) throw new Error("WORKER_TOKEN required");

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const JobSchema = z.object({
  jobId: z.string(),
  tenantId: z.string(),
  params: z.record(z.any()),
  portals: z.array(z.enum(["idealista", "fotocasa", "habitaclia"])),
});

const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "inmoos-scraper-worker", version: process.env.WORKER_VERSION }));
app.get("/health", (c) => c.json({ ok: true }));

app.post("/jobs", async (c) => {
  if (c.req.header("x-worker-token") !== WORKER_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json();
  const parsed = JobSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);

  await enqueueJob(parsed.data);
  return c.json({ ok: true, queued: true }, 202);
});

startWorker();
startHeartbeat();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] listening on :${info.port}`);
});
