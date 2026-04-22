import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";
export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const scrapeQueue = new Queue("scrape", { connection });
export const queueEvents = new QueueEvents("scrape", { connection });

export type ScrapeJobData = {
  jobId: string;
  tenantId: string;
  params: Record<string, unknown>;
  portals: ("idealista" | "fotocasa" | "habitaclia")[];
};

export async function enqueueJob(data: ScrapeJobData) {
  await scrapeQueue.add("scrape", data, {
    jobId: data.jobId,
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
  });
}
