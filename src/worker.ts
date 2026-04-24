import { Worker } from "bullmq";
import { connection, type ScrapeJobData } from "./queue.js";
import { ingestResults } from "./ingest.js";
import { scrapeIdealista } from "./adapters/idealista.js";
import { scrapeFotocasa } from "./adapters/fotocasa.js";
import { scrapeHabitaclia } from "./adapters/habitaclia.js";
import { normalizeSearchParams, type RawSearchParams } from "./lib/url-builder.js";
import { recordJobDone } from "./heartbeat.js";

const MAX = parseInt(process.env.MAX_CONCURRENT_JOBS ?? "3", 10);
const TIMEOUT = parseInt(process.env.JOB_TIMEOUT_MS ?? "300000", 10);

const adapters = {
  idealista: scrapeIdealista,
  fotocasa: scrapeFotocasa,
  habitaclia: scrapeHabitaclia,
} as const;

function fmtErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function inRange(value: number | null | undefined, min?: number, max?: number): boolean {
  if (value == null) return true;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

type ScrapedListing = {
  price?: number | null;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  operation?: string | null;
  city?: string | null;
  zone?: string | null;
  [key: string]: unknown;
};

function applySearchFilters(results: ScrapedListing[], params: ReturnType<typeof normalizeSearchParams>): ScrapedListing[] {
  return results.filter((result) => (
    inRange(result.price, params.price_min, params.price_max) &&
    inRange(result.surface_m2, params.surface_min, params.surface_max) &&
    inRange(result.rooms, params.rooms_min, undefined) &&
    inRange(result.bathrooms, params.bathrooms_min, undefined)
  ));
}

export function startWorker() {
  const worker = new Worker<ScrapeJobData>(
    "scrape",
    async (job) => {
      const { jobId, tenantId, portals } = job.data;
      const params = normalizeSearchParams(job.data.params as RawSearchParams);
      const jobStartedAt = Date.now();

      console.log(`[worker] start job=${jobId} tenant=${tenantId} portals=${portals.join(",")} params=${JSON.stringify(params)}`);

      const progress: Record<string, { status: string; count: number }> = {};
      for (const p of portals) progress[p] = { status: "queued", count: 0 };

      try {
        await ingestResults({ jobId, tenantId, results: [], progress, status: "running" });

        for (const portal of portals) {
          const t0 = Date.now();
          progress[portal].status = "running";
          console.log(`[worker] portal=${portal} -> running`);
          await ingestResults({ jobId, tenantId, results: [], progress, status: "running" });
          try {
            const results = await Promise.race([
              adapters[portal](params),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("portal_timeout")), TIMEOUT)),
            ]);
            const filteredResults = applySearchFilters(results as ScrapedListing[], params);
            if (filteredResults.length !== results.length) {
              console.log(`[worker] portal=${portal} filtered ${results.length} -> ${filteredResults.length}`);
            }
            const enrichedResults = filteredResults.map((r) => ({
              ...r,
              property_type: r.property_type ?? params.property_type,
              operation: r.operation ?? params.operation,
              city: r.city ?? params.city,
              zone: r.zone ?? params.zones[0] ?? null,
            }));
            progress[portal].status = "done";
            progress[portal].count = enrichedResults.length;
            await ingestResults({ jobId, tenantId, results: enrichedResults, progress, status: "running" });
            console.log(`[worker] portal=${portal} -> done count=${progress[portal].count} ms=${Date.now() - t0}`);
          } catch (portalErr) {
            progress[portal].status = "error";
            console.error(`[worker] portal=${portal} -> ERROR ms=${Date.now() - t0}\n${fmtErr(portalErr)}`);
            await ingestResults({
              jobId, tenantId, results: [], progress, status: "running",
              error: `${portal}: ${portalErr instanceof Error ? portalErr.message : String(portalErr)}`,
            });
          }
        }
        await ingestResults({ jobId, tenantId, results: [], progress, status: "done" });
        recordJobDone(Date.now() - jobStartedAt, true);
        console.log(`[worker] done job=${jobId} progress=${JSON.stringify(progress)}`);
      } catch (e) {
        console.error(`[worker] FATAL job=${jobId}\n${fmtErr(e)}`);
        await ingestResults({
          jobId, tenantId, results: [], progress, status: "error",
          error: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
        recordJobDone(Date.now() - jobStartedAt, false);
        throw e;
      }
    },
    { connection, concurrency: MAX }
  );

  worker.on("failed", (job, err) => console.error(`[worker] failed job=${job?.id}\n${fmtErr(err)}`));
    worker.on("error", (err) => console.error(`[worker] worker-error\n${fmtErr(err)}`));
}
