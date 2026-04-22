const SUPABASE_URL = process.env.SUPABASE_URL!;
const WORKER_TOKEN = process.env.WORKER_TOKEN!;

type IngestPayload = {
  jobId: string;
  tenantId: string;
  results: any[];
  progress: Record<string, { status: string; count: number }>;
  status: "running" | "done" | "error";
  error?: string;
};

export async function ingestResults(payload: IngestPayload) {
  const url = `${SUPABASE_URL}/functions/v1/scraper-ingest-results`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-token": WORKER_TOKEN },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`[ingest] non-2xx ${res.status} for job=${payload.jobId}`);
  } catch (e) {
    console.error(`[ingest] failed for job=${payload.jobId}`, e);
  }
}
