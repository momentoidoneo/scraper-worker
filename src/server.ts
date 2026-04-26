import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { enqueueJob } from "./queue.js";
import { startHeartbeat } from "./heartbeat.js";
import { startWorker } from "./worker.js";

const WORKER_TOKEN = process.env.WORKER_TOKEN!;
if (!WORKER_TOKEN) throw new Error("WORKER_TOKEN required");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BUILD_COMMIT =
  process.env.SOURCE_COMMIT ||
  process.env.GIT_COMMIT ||
  process.env.COMMIT_SHA ||
  process.env.COOLIFY_GIT_COMMIT ||
  null;

function envFlag(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function workerInfo() {
  return {
    ok: true,
    service: "inmoos-scraper-worker",
    version: process.env.WORKER_VERSION ?? "1.1.0",
    commit: BUILD_COMMIT,
    capabilities: {
      idealistaSegmentedSearch: true,
      idealistaBalancedPriceBands: true,
      privateCandidateFallback: true,
      opportunityAi: envFlag("OPPORTUNITY_AI_ENABLED", true),
    },
  };
}

const JobSchema = z.object({
  jobId: z.string(),
  tenantId: z.string(),
  params: z.record(z.any()),
  portals: z.array(z.enum(["idealista", "fotocasa", "habitaclia"])),
});

const app = new Hono();

app.get("/", (c) => c.json(workerInfo()));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/diagnostics", (c) => {
  if (c.req.header("x-worker-token") !== WORKER_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return c.json({
    ...workerInfo(),
    config: {
      workerId: process.env.WORKER_ID ?? null,
      supabaseConfigured: Boolean(process.env.SUPABASE_URL),
      apifyConfigured: Boolean(process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN),
      idealista: {
        actorId: process.env.APIFY_IDEALISTA_ACTOR_ID?.trim() || "dz_omar~idealista-scraper-api",
        desiredResults: envInt("APIFY_IDEALISTA_DESIRED_RESULTS", 180, 10, 240),
        maxResultsPerSearch: envInt("APIFY_IDEALISTA_MAX_RESULTS_PER_SEARCH", 100, 10, 100),
        segmentedSearch: envFlag("APIFY_IDEALISTA_SEGMENTED_SEARCH", true),
        concurrency: envInt("APIFY_IDEALISTA_CONCURRENCY", 3, 1, 6),
        detailEnrichment: envFlag("IDEALISTA_DETAIL_ENRICHMENT_ENABLED", true),
      },
      privateSearch: {
        classifierEnabled: envFlag("LISTING_CLASSIFIER_ENABLED", true),
        detailEnrichmentEnabled: envFlag("PRIVATE_DETAIL_ENRICHMENT_ENABLED", true),
        detailEnrichmentMaxResults: envInt("PRIVATE_DETAIL_ENRICHMENT_MAX_RESULTS", 80, 0, 120),
        particularCandidatesEnabled: envFlag("PARTICULAR_CANDIDATES_ENABLED", true),
        particularCandidateMinConfidence: Number.parseFloat(process.env.PARTICULAR_CANDIDATE_MIN_CONFIDENCE ?? "0.5"),
      },
      opportunityAi: {
        enabled: envFlag("OPPORTUNITY_AI_ENABLED", true),
        maxOllamaResults: envInt("OPPORTUNITY_AI_MAX_OLLAMA_RESULTS", 18, 0, 200),
      },
    },
  });
});

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
