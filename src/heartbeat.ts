import { scrapeQueue } from "./queue.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const WORKER_TOKEN = process.env.WORKER_TOKEN!;
const WORKER_ID = process.env.WORKER_ID ?? "worker-eu-1";
const VERSION = process.env.WORKER_VERSION ?? "1.0.0";
const INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "30000", 10);

let jobsLast24h = 0;
let successCount = 0;
let totalLatency = 0;
let totalDone = 0;

export function recordJobDone(latencyMs: number, success: boolean) {
  jobsLast24h++;
  if (success) successCount++;
  totalLatency += latencyMs;
  totalDone++;
}

export function startHeartbeat() {
  const url = `${SUPABASE_URL}/functions/v1/worker-heartbeat`;
  const send = async () => {
    try {
      const counts = await scrapeQueue.getJobCounts("waiting", "active");
      const body = {
        workerId: WORKER_ID,
        version: VERSION,
        queueDepth: counts.waiting ?? 0,
        activeJobs: counts.active ?? 0,
        metrics: {
          jobsLast24h,
          successRate: totalDone === 0 ? 1 : successCount / totalDone,
          avgLatencyMs: totalDone === 0 ? 0 : Math.round(totalLatency / totalDone),
        },
      };
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-token": WORKER_TOKEN },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.warn("[heartbeat] failed", e);
    }
  };
  setInterval(send, INTERVAL);
  send();
}
