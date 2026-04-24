import { buildIdealistaUrl, type SearchParams } from "../lib/url-builder.js";

export type Listing = {
  external_id: string;
  portal: "idealista";
  title: string;
  price: number | null;
  url: string;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  operation?: string | null;
  address?: string | null;
  zone?: string | null;
  city?: string | null;
  images?: string[];
  description?: string | null;
  raw?: any;
};

type ApifyItem = Record<string, any>;

const ACTOR_ID = process.env.APIFY_IDEALISTA_ACTOR_ID?.trim() || "dz_omar~idealista-scraper-api";
const STANDBY_URL = process.env.APIFY_IDEALISTA_STANDBY_URL?.trim() || "";
const REQUEST_TIMEOUT = Number.parseInt(process.env.APIFY_IDEALISTA_TIMEOUT_MS ?? "240000", 10);

function requiredToken(): string {
  const token = process.env.APIFY_TOKEN?.trim() || process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    throw new Error("idealista_apify_not_configured: set APIFY_TOKEN in worker .env.runtime");
  }
  return token;
}

function desiredResults(): number {
  const parsed = Number.parseInt(process.env.APIFY_IDEALISTA_DESIRED_RESULTS ?? "20", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(10, Math.min(parsed, 100));
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function absoluteIdealistaUrl(value: unknown): string | null {
  const url = stringValue(value);
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `https://www.idealista.com${url.startsWith("/") ? url : `/${url}`}`;
}

function parseNdjson(text: string): ApifyItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function fetchApifyItems(payload: Record<string, unknown>, token: string): Promise<ApifyItem[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    if (STANDBY_URL) {
      const res = await fetch(STANDBY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`apify_standby_non_2xx:${res.status}:${text.slice(0, 300)}`);
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [parsed];
      } catch {
        return parseNdjson(text);
      }
    }

    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`apify_non_2xx:${res.status}:${text.slice(0, 300)}`);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [parsed];
  } finally {
    clearTimeout(timeout);
  }
}

function mapOperation(value: unknown, fallback: string): string {
  const op = stringValue(value)?.toLowerCase();
  if (op === "rent" || op === "alquiler") return "alquiler";
  if (op === "sale" || op === "venta" || op === "compra") return "compra";
  return fallback;
}

function mapListing(item: ApifyItem, params: SearchParams): Listing | null {
  if (item.error || item.errors) return null;

  const id = stringValue(item.propertyCode, item.adid, item.propertyId, item.id, item.identifier, item.externalReference);
  const url = absoluteIdealistaUrl(item.detailWebLink ?? item.url ?? item.webLink);
  if (!id && !url) return null;

  const characteristics = item.moreCharacteristics ?? item.characteristics ?? {};
  const location = item.ubication ?? item.location ?? {};
  const priceInfo = item.priceInfo ?? {};
  const multimedia = item.multimedia ?? {};
  const rawImages = Array.isArray(multimedia.images) ? multimedia.images : Array.isArray(item.images) ? item.images : [];
  const images = [item.thumbnail, ...rawImages]
    .map((image: any) => stringValue(image?.url, image?.src, image))
    .filter((value: string | null): value is string => Boolean(value));

  const address = stringValue(
    location.title,
    location.address,
    item.address,
    item.suggestedTexts?.subtitle,
  );
  const title = stringValue(
    item.suggestedTexts?.title,
    item.title,
    item.displayTitle,
    address,
    item.description,
  ) ?? "(sin título)";

  return {
    external_id: id ?? url ?? crypto.randomUUID(),
    portal: "idealista",
    title,
    price: numberValue(item.price, priceInfo.amount, item.priceAmount),
    url: url ?? `https://www.idealista.com/inmueble/${id}/`,
    surface_m2: numberValue(characteristics.constructedArea, characteristics.usableArea, item.size, item.surface),
    rooms: numberValue(characteristics.roomNumber, item.rooms, item.bedrooms),
    bathrooms: numberValue(characteristics.bathNumber, item.bathrooms),
    property_type: stringValue(item.extendedPropertyType, item.propertyType) ?? params.property_type,
    operation: mapOperation(item.operation, params.operation),
    address,
    zone: stringValue(location.district, location.neighborhood, item.district, params.zones[0]) ?? null,
    city: stringValue(location.municipality, location.administrativeAreaLevel2, item.city) ?? params.city,
    images,
    description: stringValue(item.description, item.comment, item.comments),
    raw: item,
  };
}

export async function scrapeIdealista(params: SearchParams): Promise<Listing[]> {
  const token = requiredToken();
  const url = buildIdealistaUrl(params);
  const payload = {
    Property_urls: [{ url }],
    desiredResults: desiredResults(),
  };

  console.log(`[idealista] apify actor=${ACTOR_ID} url=${url} desiredResults=${payload.desiredResults}`);
  const items = await fetchApifyItems(payload, token);
  const listings = items
    .map((item) => mapListing(item, params))
    .filter((listing): listing is Listing => Boolean(listing));

  console.log(`[idealista] apifyItems=${items.length} listings=${listings.length}`);
  return listings;
}
