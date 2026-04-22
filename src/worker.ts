import { Worker } from "bullmq";
import { connection, type ScrapeJobData } from "./queue.js";
import { ingestResults } from "./ingest.js";
import { scrapeIdealista } from "./adapters/idealista.js";
import { scrapeFotocasa } from "./adapters/fotocasa.js";
import { scrapeHabitaclia } from "./adapters/habitaclia.js";

const MAX = parseInt(process.env.MAX_CONCURRENT_JOBS ?? "3", 10);
const TIMEOUT = parseInt(process.env.JOB_TIMEOUT_MS ?? "300000", 10);

const adapters = {
  idealista: scrapeIdealista,
  fotocasa: scrapeFotocasa,
  habitaclia: scrapeHabitaclia,
} as const;

export function startWorker() {
  const worker = new Worker<ScrapeJobData>(
    "scrape",
    async (job) => {
      const { jobId, tenantId, params, portals } = job.data;
      console.log(`[worker] start job=${jobId} portals=${portals.join(",")}`);

      const progress: Record<string, { status: string; count: number }> = {};
      for (const p of portals) progress[p] = { status: "queued", count: 0 };

      try {
        for (const portal of portals) {
          progress[portal].status = "running";
          const results = await Promise.race([
            adapters[portal](params, async (batch) => {
              progress[portal].count += batch.length;
              await ingestResults({ jobId, tenantId, results: batch, progress, status: "running" });
            }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("portal_timeout")), TIMEOUT)),
          ]);
          progress[portal].status = "done";
          progress[portal].count = results.length || progress[portal].count;
        }
        await ingestResults({ jobId, tenantId, results: [], progress, status: "done" });
        console.log(`[worker] done job=${jobId}`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[worker] error job=${jobId}`, err);
        await ingestResults({ jobId, tenantId, results: [], progress, status: "error", error: err });
        throw e;
      }
    },
    { connection, concurrency: MAX }
  );

  worker.on("failed", (job, err) => console.error(`[worker] failed ${job?.id}`, err.message));
}
