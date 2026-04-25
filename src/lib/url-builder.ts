// Slugify: normaliza ciudad para usarla en URLs de portales.
// Quita tildes, pasa a minúsculas, espacios -> guiones.
export function slugifyCity(city: string): string {
  return city
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export type SearchParams = {
  operation: "compra" | "alquiler" | "alquiler_temporal" | string;
  property_type: "piso" | "casa" | "local" | string;
  property_types: string[];
  city: string;
  zones: string[];
  price_min?: number;
  price_max?: number;
  surface_min?: number;
  surface_max?: number;
  rooms_min?: number;
  bathrooms_min?: number;
  listing_type?: "particular" | "agencia" | "ambos" | "any" | string;
  extras: string[];
  freshness?: "24h" | "7d" | "30d" | "any" | string;
};

export type RawSearchParams = Record<string, unknown>;

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function stringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      const arr = value
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim());
      if (arr.length) return arr;
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
}

function canonicalPropertyType(value: string | undefined): string {
  const text = (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (["casa", "casas", "chalet", "chalets", "house", "villa"].some((v) => text.includes(v))) return "casa";
  if (["local", "locales", "premises"].some((v) => text.includes(v))) return "local";
  if (["oficina", "oficinas", "office"].some((v) => text.includes(v))) return "oficina";
  if (["garaje", "garajes", "garage", "parking"].some((v) => text.includes(v))) return "garaje";
  if (["duplex"].some((v) => text.includes(v))) return "duplex";
  if (["atico", "penthouse"].some((v) => text.includes(v))) return "atico";
  if (["estudio", "studio", "loft"].some((v) => text.includes(v))) return "estudio";
  if (["piso", "pisos", "flat", "apartment", "apartamento"].some((v) => text.includes(v))) return "piso";
  return value ?? "piso";
}

export function normalizeSearchParams(raw: RawSearchParams): SearchParams {
  const propertyTypes = stringArray(raw.propertyTypes, raw.property_types, raw.property_type);
  const normalizedPropertyTypes = propertyTypes.map(canonicalPropertyType).filter(Boolean);
  return {
    operation: stringValue(raw.operation, "compra"),
    property_type: normalizedPropertyTypes[0] ?? "piso",
    property_types: normalizedPropertyTypes.length ? normalizedPropertyTypes : ["piso"],
    city: stringValue(raw.city, "Madrid"),
    zones: stringArray(raw.zones, raw.zone),
    price_min: numberValue(raw.priceMin, raw.price_min),
    price_max: numberValue(raw.priceMax, raw.price_max),
    surface_min: numberValue(raw.surfaceMin, raw.surface_min),
    surface_max: numberValue(raw.surfaceMax, raw.surface_max),
    rooms_min: numberValue(raw.roomsMin, raw.rooms_min),
    bathrooms_min: numberValue(raw.bathroomsMin, raw.bathrooms_min),
    listing_type: stringValue(raw.listingType, stringValue(raw.listing_type, "ambos")),
    extras: stringArray(raw.features, raw.extras),
    freshness: stringValue(raw.adAge, stringValue(raw.freshness, "any")),
  };
}

function idealistaFilters(p: SearchParams): string {
  const filters: string[] = [];
  if (p.property_type === "piso") filters.push("solo-pisos");
  if (p.price_min) filters.push(`precio-desde_${p.price_min}`);
  if (p.price_max) filters.push(`precio-hasta_${p.price_max}`);
  if (p.surface_min) filters.push(`metros-cuadrados-mas-de_${p.surface_min}`);
  if (p.surface_max) filters.push(`metros-cuadrados-menos-de_${p.surface_max}`);
  if (p.rooms_min) filters.push(`de-${p.rooms_min}-dormitorios`);
  return filters.length ? `con-${filters.join(",")}/` : "";
}

// --- IDEALISTA ---
// https://www.idealista.com/venta-viviendas/barcelona-barcelona/
// https://www.idealista.com/alquiler-viviendas/madrid-madrid/
export function buildIdealistaUrl(input: RawSearchParams): string {
  const p = normalizeSearchParams(input);
  const op = p.operation === "alquiler" || p.operation === "alquiler_temporal" ? "alquiler-viviendas" : "venta-viviendas";
  const slug = slugifyCity(p.city);
  const query = p.price_max ? "?ordenado-por=precios-asc" : "";
  return `https://www.idealista.com/${op}/${slug}-${slug}/${idealistaFilters(p)}${query}`;
}

// --- FOTOCASA ---
// https://www.fotocasa.es/es/comprar/viviendas/barcelona-capital/todas-las-zonas/l
export function buildFotocasaUrl(input: RawSearchParams): string {
  const p = normalizeSearchParams(input);
  const op = p.operation === "alquiler" || p.operation === "alquiler_temporal" ? "alquiler" : "comprar";
  const type = p.property_type === "casa" ? "casas" : p.property_type === "local" ? "locales" :
    p.property_type === "oficina" ? "oficinas" : p.property_type === "garaje" ? "garajes" : "viviendas";
  const slug = slugifyCity(p.city);
  const qs = new URLSearchParams();
  if (p.price_min) qs.set("minPrice", String(p.price_min));
  if (p.price_max) qs.set("maxPrice", String(p.price_max));
  if (p.surface_min) qs.set("minSurface", String(p.surface_min));
  if (p.surface_max) qs.set("maxSurface", String(p.surface_max));
  if (p.rooms_min) qs.set("minRooms", String(p.rooms_min));
  const query = qs.toString();
  return `https://www.fotocasa.es/es/${op}/${type}/${slug}-capital/todas-las-zonas/l${query ? `?${query}` : ""}`;
}

// --- HABITACLIA ---
// https://www.habitaclia.com/pisos-barcelona.htm
// https://www.habitaclia.com/alquiler-pisos-barcelona.htm
export function buildHabitacliaUrl(input: RawSearchParams): string {
  const p = normalizeSearchParams(input);
  const slug = slugifyCity(p.city);
  const isRental = p.operation === "alquiler" || p.operation === "alquiler_temporal";
  const type = p.property_type === "casa" ? "casas" : p.property_type === "local" ? "locales" : "pisos";
  const cheapSuffix = !isRental && p.price_max && type === "pisos" ? "-baratos" : "";
  const prefix = isRental ? `alquiler-${type}` : `${type}${cheapSuffix}`;
  return `https://www.habitaclia.com/${prefix}-${slug}.htm`;
}
