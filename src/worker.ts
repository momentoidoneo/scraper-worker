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

function fmtErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export function startWorker() {
  const worker = new Worker<ScrapeJobData>(
    "scrape",
    async (job) => {
      const { jobId, tenantId, params, portals } = job.data;
      console.log(`[worker] start job=${jobId} tenant=${tenantId} portals=${portals.join(",")} params=${JSON.stringify(params)}`);

      const progress: Record<string, { status: string; count: number }> = {};
      for (const p of portals) progress[p] = { status: "queued", count: 0 };

      try {
        for (const portal of portals) {
          const t0 = Date.now();
          progress[portal].status = "running";
          console.log(`[worker] portal=${portal} -> running`);
          try {
            const results = await Promise.race([
              adapters[portal](params, async (batch) => {
                progress[portal].count += batch.length;
                await ingestResults({ jobId, tenantId, results: batch, progress, status: "running" });
              }),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("portal_timeout")), TIMEOUT)),
            ]);
            progress[portal].status = "done";
            progress[portal].count = results.length || progress[portal].count;
            console.log(`[worker] portal=${portal} -> done count=${progress[portal].count} ms=${Date.now() - t0}`);
          } catch (portalErr) {
            progress[portal].status = "error";
            console.error(`[worker] portal=${portal} -> ERROR ms=${Date.now() - t0}\n${fmtErr(portalErr)}`);
            // Continue with the next portal instead of aborting the whole job
            await ingestResults({
              jobId, tenantId, results: [], progress, status: "running",
              error: `${portal}: ${portalErr instanceof Error ? portalErr.message : String(portalErr)}`,
            });
          }
        }
        await ingestResults({ jobId, tenantId, results: [], progress, status: "done" });
        console.log(`[worker] done job=${jobId} progress=${JSON.stringify(progress)}`);
      } catch (e) {
        console.error(`[worker] FATAL job=${jobId}\n${fmtErr(e)}`);
        await ingestResults({
          jobId, tenantId, results: [], progress, status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
    { connection, concurrency: MAX }
  );

  worker.on("failed", (job, err) => console.error(`[worker] failed job=${job?.id}\n${fmtErr(err)}`));
  worker.on("error", (err) => console.error(`[worker] worker-error\n${fmtErr(err)}`));
}
