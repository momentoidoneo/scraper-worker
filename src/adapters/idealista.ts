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
  listing_type?: "particular" | "agencia" | null;
  operation?: string | null;
  address?: string | null;
  zone?: string | null;
  city?: string | null;
  images?: string[];
  description?: string | null;
  published_at?: string | null;
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
  const parsed = Number.parseInt(process.env.APIFY_IDEALISTA_DESIRED_RESULTS ?? "100", 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(10, Math.min(parsed, 100));
}

function segmentedSearchEnabled(): boolean {
  const value = (process.env.APIFY_IDEALISTA_SEGMENTED_SEARCH ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function priceBandsFor(operation: string): Array<{ price_min?: number; price_max?: number }> {
  const rental = operation === "alquiler" || operation === "alquiler_temporal" || operation === "rent";
  if (rental) {
    return [
      { price_max: 800 },
      { price_min: 800, price_max: 1200 },
      { price_min: 1200, price_max: 1800 },
      { price_min: 1800, price_max: 3000 },
      { price_min: 3000 },
    ];
  }

  return [
    { price_max: 150000 },
    { price_min: 150000, price_max: 250000 },
    { price_min: 250000, price_max: 400000 },
    { price_min: 400000, price_max: 700000 },
    { price_min: 700000, price_max: 1200000 },
    { price_min: 1200000 },
  ];
}

function intersectPriceBand(
  band: { price_min?: number; price_max?: number },
  params: SearchParams,
): { price_min?: number; price_max?: number } | null {
  const min = Math.max(band.price_min ?? Number.NEGATIVE_INFINITY, params.price_min ?? Number.NEGATIVE_INFINITY);
  const max = Math.min(band.price_max ?? Number.POSITIVE_INFINITY, params.price_max ?? Number.POSITIVE_INFINITY);

  if (Number.isFinite(min) && Number.isFinite(max) && min >= max) return null;
  return {
    price_min: Number.isFinite(min) ? min : undefined,
    price_max: Number.isFinite(max) ? max : undefined,
  };
}

function searchUrls(params: SearchParams, totalDesiredResults: number): Array<{ url: string; desiredResults: number }> {
  if (!segmentedSearchEnabled() || totalDesiredResults < 30) {
    return [{ url: buildIdealistaUrl(params), desiredResults: totalDesiredResults }];
  }

  const segments = priceBandsFor(params.operation)
    .map((band) => intersectPriceBand(band, params))
    .filter((band): band is { price_min?: number; price_max?: number } => Boolean(band));

  if (segments.length <= 1) {
    return [{ url: buildIdealistaUrl(params), desiredResults: totalDesiredResults }];
  }

  const perSegment = Math.max(10, Math.ceil(totalDesiredResults / segments.length));
  return segments.map((segment) => ({
    url: buildIdealistaUrl({ ...params, ...segment }),
    desiredResults: perSegment,
  }));
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

function dateValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const timestamp = Date.parse(String(value));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

function normalize(value: unknown): string {
  return stringValue(value)?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() ?? "";
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

function mapPropertyType(...values: unknown[]): string | null {
  const text = values.map(normalize).join(" ");
  if (!text) return null;
  const patterns: Array<[string, RegExp]> = [
    ["duplex", /\bduplex(?:es)?\b/],
    ["atico", /\b(?:atico|aticos|penthouse|penthouses)\b/],
    ["estudio", /\b(?:estudio|estudios|studio|studios|loft|lofts)\b/],
    ["piso", /\b(?:piso|pisos|flat|flats|apartment|apartments|apartamento|apartamentos)\b/],
    ["local", /\b(?:local|locales|premises|commercial)\b/],
    ["oficina", /\b(?:oficina|oficinas|office|offices)\b/],
    ["garaje", /\b(?:garaje|garajes|garage|garages|parking)\b/],
    ["casa", /\b(?:casa|casas|house|houses|chalet|chalets|villa|villas|countryhouse|country house|terracedhouse|terraced house)\b/],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function mapListingType(...values: unknown[]): "particular" | "agencia" | null {
  const text = values.map(normalize).join(" ");
  if (!text) return null;
  if (/\b(particular|private|privado|propietario|owner)\b/.test(text)) return "particular";
  if (/\b(agencia|agency|inmobiliaria|professional|profesional|promotor|promotora|real estate|properties)\b/.test(text)) return "agencia";
  return null;
}

function publishedAt(item: ApifyItem): string | null {
  return dateValue(item.publishedDate, item.publicationDate, item.date, item.createdAt, item.updatedAt, item.modificationDate, item.updateDate) ??
    (item.newProperty === true ? new Date().toISOString() : null);
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
  const contactInfo = item.contactInfo ?? {};

  return {
    external_id: id ?? url ?? crypto.randomUUID(),
    portal: "idealista",
    title,
    price: numberValue(item.price, priceInfo.amount, item.priceAmount),
    url: url ?? `https://www.idealista.com/inmueble/${id}/`,
    surface_m2: numberValue(characteristics.constructedArea, characteristics.usableArea, item.size, item.surface),
    rooms: numberValue(characteristics.roomNumber, item.rooms, item.bedrooms),
    bathrooms: numberValue(characteristics.bathNumber, item.bathrooms),
    property_type: mapPropertyType(item.extendedPropertyType, item.propertyType, title, url) ?? params.property_type,
    listing_type: mapListingType(item.listingType, item.advertiserType, item.publisherType, item.userType, contactInfo.userType, contactInfo.commercialName, contactInfo.name),
    operation: mapOperation(item.operation, params.operation),
    address,
    zone: stringValue(location.district, location.neighborhood, item.district, params.zones[0]) ?? null,
    city: stringValue(location.municipality, location.administrativeAreaLevel2, item.city) ?? params.city,
    images,
    description: stringValue(item.description, item.comment, item.comments),
    published_at: publishedAt(item),
    raw: item,
  };
}

export async function scrapeIdealista(params: SearchParams): Promise<Listing[]> {
  const token = requiredToken();
  const targetResults = desiredResults();
  const searches = searchUrls(params, targetResults);
  const seenListings = new Set<string>();
  const searchListings: Listing[][] = [];
  let itemCount = 0;

  console.log(`[idealista] apify actor=${ACTOR_ID} searches=${searches.length} desiredTotal=${targetResults}`);
  for (const search of searches) {
    const payload = {
      Property_urls: [{ url: search.url }],
      desiredResults: search.desiredResults,
    };

    console.log(`[idealista] apify url=${search.url} desiredResults=${payload.desiredResults}`);
    const items = await fetchApifyItems(payload, token);
    itemCount += items.length;
    const listingsForSearch: Listing[] = [];
    for (const item of items) {
      const listing = mapListing(item, params);
      if (!listing) continue;
      const key = listing.external_id || listing.url;
      if (seenListings.has(key)) continue;
      seenListings.add(key);
      listingsForSearch.push(listing);
    }
    searchListings.push(listingsForSearch);
  }

  const listings: Listing[] = [];
  for (let index = 0; listings.length < targetResults; index += 1) {
    let added = false;
    for (const group of searchListings) {
      const listing = group[index];
      if (!listing) continue;
      listings.push(listing);
      added = true;
      if (listings.length >= targetResults) break;
    }
    if (!added) break;
  }

  console.log(`[idealista] apifyItems=${itemCount} uniqueListings=${seenListings.size} listings=${listings.length}`);
  return listings;
}
