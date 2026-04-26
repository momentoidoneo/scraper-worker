import { Worker } from "bullmq";
import { connection, type ScrapeJobData } from "./queue.js";
import { ingestResults } from "./ingest.js";
import { scrapeIdealista } from "./adapters/idealista.js";
import { scrapeFotocasa } from "./adapters/fotocasa.js";
import { scrapeHabitaclia } from "./adapters/habitaclia.js";
import { enrichListingType } from "./lib/listing-classifier.js";
import { enrichListingDetailsForPrivateSearch } from "./lib/listing-detail-enricher.js";
import { enrichOpportunityBatch } from "./lib/opportunity-ai.js";
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
  if (min == null && max == null) return true;
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

type ScrapedListing = {
  title?: string | null;
  price?: number | null;
  url?: string | null;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  listing_type?: string | null;
  operation?: string | null;
  city?: string | null;
  zone?: string | null;
  address?: string | null;
  description?: string | null;
  published_at?: string | null;
  raw?: unknown;
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeText(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function rawText(value: unknown): string {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  try {
    return JSON.stringify(value).slice(0, 8000);
  } catch {
    return "";
  }
}

function searchableText(result: ScrapedListing): string {
  return normalizeText([
    result.title,
    result.url,
    result.address,
    result.zone,
    result.city,
    result.description,
    rawText(result.raw),
  ].filter((value) => value != null && value !== "").join(" "));
}

const PROPERTY_ALIASES: Record<string, string[]> = {
  piso: ["piso", "pisos", "flat", "flats", "apartment", "apartamento", "apartamentos"],
  casa: ["casa", "casas", "house", "houses", "chalet", "chalets", "villa", "villas", "countryhouse", "terracedhouse"],
  local: ["local", "locales", "premises", "commercial"],
  oficina: ["oficina", "oficinas", "office", "offices"],
  garaje: ["garaje", "garajes", "garage", "garages", "parking"],
  duplex: ["duplex"],
  atico: ["atico", "aticos", "penthouse", "penthouses"],
  estudio: ["estudio", "estudios", "studio", "studios", "loft", "lofts"],
};

const PROPERTY_PATTERNS: Array<[string, RegExp]> = [
  ["duplex", /\bduplex(?:es)?\b/],
  ["atico", /\b(?:atico|aticos|penthouse|penthouses)\b/],
  ["estudio", /\b(?:estudio|estudios|studio|studios|loft|lofts)\b/],
  ["piso", /\b(?:piso|pisos|flat|flats|apartment|apartments|apartamento|apartamentos)\b/],
  ["local", /\b(?:local|locales|premises|commercial)\b/],
  ["oficina", /\b(?:oficina|oficinas|office|offices)\b/],
  ["garaje", /\b(?:garaje|garajes|garage|garages|parking)\b/],
  ["casa", /\b(?:casa|casas|house|houses|chalet|chalets|villa|villas|countryhouse|country house|terracedhouse|terraced house)\b/],
];

function canonicalPropertyType(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  return PROPERTY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function requestedPropertyTypes(params: ReturnType<typeof normalizeSearchParams>): string[] {
  const propertyTypes = params.property_types?.length ? params.property_types : [params.property_type];
  return propertyTypes
    .map((propertyType) => canonicalPropertyType(propertyType) ?? normalizeText(propertyType))
    .filter(Boolean);
}

function propertyMatches(result: ScrapedListing, params: ReturnType<typeof normalizeSearchParams>): boolean {
  const requested = requestedPropertyTypes(params);
  if (requested.length === 0) return true;

  const raw = asRecord(result.raw);
  const candidates = [
    result.property_type,
    raw?.extendedPropertyType,
    raw?.propertyType,
    raw?.type,
    result.title,
    result.url,
  ];
  const detected = candidates
    .map((candidate) => canonicalPropertyType(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));

  if (detected.length > 0) return detected.some((propertyType) => requested.includes(propertyType));

  const haystack = searchableText(result);
  return requested.some((propertyType) =>
    (PROPERTY_ALIASES[propertyType] ?? [propertyType]).some((alias) => haystack.includes(normalizeText(alias)))
  );
}

function canonicalListingType(value: unknown): "particular" | "agencia" | null {
  const text = normalizeText(value);
  if (!text) return null;
  if (/\b(particular|private|privado|propietario|owner)\b/.test(text)) return "particular";
  if (/\b(agencia|agencias|agency|inmobiliaria|professional|profesional|promotor|promotora|real estate|properties|consulting)\b/.test(text)) return "agencia";
  return null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = normalizeText(process.env[name]);
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function privateCandidateThreshold(): number {
  const parsed = Number.parseFloat(process.env.PARTICULAR_CANDIDATE_MIN_CONFIDENCE ?? "0.5");
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.5;
}

function isPrivateLeadCandidate(raw: Record<string, unknown> | null): boolean {
  if (!envFlag("PARTICULAR_CANDIDATES_ENABLED", true)) return false;
  const privateLead = asRecord(raw?._privateLead);
  if (!privateLead || privateLead.status !== "candidate") return false;
  const confidence = typeof privateLead.confidence === "number"
    ? privateLead.confidence
    : Number(privateLead.confidence ?? 0);
  return Number.isFinite(confidence) && confidence >= privateCandidateThreshold();
}

function listingTypeMatches(result: ScrapedListing, requested: string | undefined): boolean {
  const desired = canonicalListingType(requested);
  const requestedText = normalizeText(requested);
  if (!desired || requestedText === "ambos" || requestedText === "any" || requestedText === "todos") return true;

  const raw = asRecord(result.raw);
  const classifier = asRecord(raw?._listingTypeClassification);
  if (classifier) {
    const classified = canonicalListingType(classifier.listing_type);
    const confidence = typeof classifier.confidence === "number"
      ? classifier.confidence
      : Number(classifier.confidence ?? 0);
    const threshold = Number.parseFloat(process.env.LISTING_CLASSIFIER_MIN_CONFIDENCE ?? "0.75");
    if (classified === desired && Number.isFinite(confidence) && confidence >= threshold) return true;
    if (desired === "particular" && isPrivateLeadCandidate(raw)) return true;
    return false;
  }

  const contactInfo = asRecord(raw?.contactInfo);
  const detected = [
    result.listing_type,
    raw?.listingType,
    raw?.advertiserType,
    raw?.publisherType,
    raw?.userType,
    contactInfo?.userType,
    contactInfo?.commercialName,
    contactInfo?.name,
    searchableText(result),
  ]
    .map((candidate) => canonicalListingType(candidate))
    .find((candidate): candidate is "particular" | "agencia" => Boolean(candidate));

  return detected === desired;
}

function zoneMatches(result: ScrapedListing, zones: string[]): boolean {
  if (!zones.length) return true;
  const haystack = searchableText(result);
  return zones.some((zone) => haystack.includes(normalizeText(zone)));
}

function freshnessLimitDays(value: string | undefined): number | null {
  const freshness = normalizeText(value);
  if (!freshness || freshness === "any" || freshness === "todos") return null;
  if (freshness === "24h" || freshness === "24horas") return 1;
  const match = freshness.match(/^(\d+)d$/);
  if (match) return Number(match[1]);
  if (freshness.includes("7")) return 7;
  if (freshness.includes("30")) return 30;
  return null;
}

function parsePublishedAt(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function inferAgeDays(text: string): number | null {
  if (!text) return null;
  if (/\b(hoy|today|nuevo|newproperty true)\b/.test(text)) return 0;
  if (/\b(ayer|yesterday)\b/.test(text)) return 1;

  let match = text.match(/hace\s*(\d+)\s*(?:hora|horas|h)\b/);
  if (match) return Number(match[1]) / 24;

  match = text.match(/(?:hace|actualizado hace|publicado hace)?\s*(\d+)\s*(?:dia|dias|d)\b/);
  if (match) return Number(match[1]);

  match = text.match(/mas de\s*(\d+)\s*(?:mes|meses)\b/);
  if (match) return (Number(match[1]) * 30) + 1;

  match = text.match(/(?:hace|actualizado hace|publicado hace)?\s*(\d+)\s*(?:semana|semanas)\b/);
  if (match) return Number(match[1]) * 7;

  match = text.match(/(?:hace|actualizado hace|publicado hace)?\s*(\d+)\s*(?:mes|meses)\b/);
  if (match) return Number(match[1]) * 30;

  return null;
}

function freshnessMatches(result: ScrapedListing, freshness: string | undefined): boolean {
  const limitDays = freshnessLimitDays(freshness);
  if (limitDays == null) return true;

  const publishedAt = parsePublishedAt(result.published_at);
  if (publishedAt != null) {
    const ageMs = Date.now() - publishedAt;
    return ageMs >= 0 && ageMs <= limitDays * 24 * 60 * 60 * 1000;
  }

  const raw = asRecord(result.raw);
  if (raw?.newProperty === true) return true;

  const inferredDays = inferAgeDays(searchableText(result));
  return inferredDays != null ? inferredDays <= limitDays : false;
}

function rejectionReason(result: ScrapedListing, params: ReturnType<typeof normalizeSearchParams>): string | null {
  if (!inRange(result.price, params.price_min, params.price_max)) return "price";
  if (!inRange(result.surface_m2, params.surface_min, params.surface_max)) return "surface";
  if (!inRange(result.rooms, params.rooms_min, undefined)) return "rooms";
  if (!inRange(result.bathrooms, params.bathrooms_min, undefined)) return "bathrooms";
  if (!propertyMatches(result, params)) return "property_type";
  if (!listingTypeMatches(result, params.listing_type)) return "listing_type";
  if (!zoneMatches(result, params.zones)) return "zone";
  if (!freshnessMatches(result, params.freshness)) return "freshness";
  return null;
}

function finalPropertyType(result: ScrapedListing, params: ReturnType<typeof normalizeSearchParams>): string | null {
  const current = canonicalPropertyType(result.property_type);
  const requested = requestedPropertyTypes(params);
  if (current && requested.includes(current)) return current;
  if (requested.length === 1 && propertyMatches(result, params)) return requested[0];
  return result.property_type ?? params.property_type ?? null;
}

function finalListingType(result: ScrapedListing, params: ReturnType<typeof normalizeSearchParams>): string | null {
  const current = canonicalListingType(result.listing_type);
  if (current) return current;
  const desired = canonicalListingType(params.listing_type);
  return desired ?? result.listing_type ?? null;
}

async function enrichListingTypesForFilter(
  results: ScrapedListing[],
  params: ReturnType<typeof normalizeSearchParams>,
  portal: string,
): Promise<ScrapedListing[]> {
  const desired = canonicalListingType(params.listing_type);
  const requestedText = normalizeText(params.listing_type);
  if (!desired || requestedText === "ambos" || requestedText === "any" || requestedText === "todos") {
    return results;
  }

  const candidateResults = desired === "particular"
    ? await enrichListingDetailsForPrivateSearch(results, portal)
    : results;
  const enriched: ScrapedListing[] = [];
  const stats: Record<string, number> = {};
  const privateLeadStats: Record<string, number> = {};
  for (const result of candidateResults) {
    const classified = await enrichListingType(result);
    const raw = asRecord(classified.raw);
    const classification = asRecord(raw?._listingTypeClassification);
    const privateLead = asRecord(raw?._privateLead);
    const source = String(classification?.source ?? "none");
    const listingType = String(classification?.listing_type ?? "none");
    const key = `${source}:${listingType}`;
    stats[key] = (stats[key] ?? 0) + 1;
    const leadStatus = String(privateLead?.status ?? "none");
    privateLeadStats[leadStatus] = (privateLeadStats[leadStatus] ?? 0) + 1;
    enriched.push(classified);
  }

  if (results.length) {
    console.log(`[classifier] portal=${portal} requested=${desired} stats=${JSON.stringify(stats)}`);
    console.log(`[private-leads] portal=${portal} stats=${JSON.stringify(privateLeadStats)}`);
  }

  return enriched;
}

async function applySearchFilters(
  results: ScrapedListing[],
  params: ReturnType<typeof normalizeSearchParams>,
  portal: string,
): Promise<ScrapedListing[]> {
  const enrichedResults = await enrichListingTypesForFilter(results, params, portal);
  const rejected: Record<string, number> = {};
  const filtered = enrichedResults.filter((result) => {
    const reason = rejectionReason(result, params);
    if (reason) {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      return false;
    }
    return true;
  });

  if (Object.keys(rejected).length) {
    console.log("[filters] rejected=" + JSON.stringify(rejected));
  }

  return filtered;
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
            const filteredResults = await applySearchFilters(results as ScrapedListing[], params, portal);
            if (filteredResults.length !== results.length) {
              console.log(`[worker] portal=${portal} filtered ${results.length} -> ${filteredResults.length}`);
            }
            const normalizedResults = filteredResults.map((r) => ({
              ...r,
              property_type: finalPropertyType(r, params),
              listing_type: finalListingType(r, params),
              operation: r.operation ?? params.operation,
              city: r.city ?? params.city,
              zone: r.zone ?? params.zones[0] ?? null,
            }));
            const enrichedResults = await enrichOpportunityBatch(normalizedResults);
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
