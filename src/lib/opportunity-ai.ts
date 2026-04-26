export type OpportunityPriority = "alta" | "media" | "baja";

export type OpportunityAi = {
  version: string;
  source: "rules" | "ollama" | "ollama_fallback" | "disabled";
  model?: string | null;
  score: number;
  priority: OpportunityPriority;
  private_owner_confidence: number;
  private_owner_status: "confirmed" | "candidate" | "rejected" | "unknown";
  summary: string;
  reason: string;
  risks: string[];
  next_action: string;
  suggested_message: string;
  signals: string[];
  duplicate_key: string;
  price_per_m2: number | null;
};

export type OpportunityListing = {
  title?: string | null;
  portal?: string | null;
  price?: number | null;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  operation?: string | null;
  city?: string | null;
  zone?: string | null;
  address?: string | null;
  description?: string | null;
  listing_type?: string | null;
  url?: string | null;
  raw?: unknown;
  [key: string]: unknown;
};

const VERSION = "2026-04-26";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 18_000;

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = normalizeText(process.env[name]);
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rawText(value: unknown): string {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return "";
  }
}

function privateLead(listing: OpportunityListing): Record<string, unknown> | null {
  const raw = asRecord(listing.raw);
  return asRecord(raw?._privateLead);
}

function listingClassification(listing: OpportunityListing): Record<string, unknown> | null {
  const raw = asRecord(listing.raw);
  return asRecord(raw?._listingTypeClassification);
}

function privateConfidence(listing: OpportunityListing): number {
  const lead = privateLead(listing);
  const status = String(lead?.status ?? "");
  const leadConfidence = numberValue(lead?.confidence);
  if (leadConfidence != null) return clamp(leadConfidence, 0, 1);
  if (normalizeText(listing.listing_type) === "particular") return 0.9;
  if (status === "candidate") return 0.62;
  if (status === "rejected" || normalizeText(listing.listing_type) === "agencia") return 0.05;
  return 0.35;
}

function privateStatus(listing: OpportunityListing): OpportunityAi["private_owner_status"] {
  const status = String(privateLead(listing)?.status ?? "");
  if (status === "confirmed" || status === "candidate" || status === "rejected") return status;
  if (normalizeText(listing.listing_type) === "particular") return "confirmed";
  if (normalizeText(listing.listing_type) === "agencia") return "rejected";
  return "unknown";
}

function duplicateKey(listing: OpportunityListing): string {
  const title = normalizeText(listing.title)
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .slice(0, 6)
    .join(" ");
  return [
    title,
    Math.round(Number(listing.price ?? 0) / 5_000) * 5_000 || "?",
    Math.round(Number(listing.surface_m2 ?? 0) / 5) * 5 || "?",
    normalizeText(listing.city || ""),
  ].join("|");
}

function context(listing: OpportunityListing): string {
  const raw = asRecord(listing.raw);
  const lead = privateLead(listing);
  const classification = listingClassification(listing);
  const contactInfo = asRecord(raw?.contactInfo);
  return [
    `portal: ${listing.portal ?? ""}`,
    `titulo: ${listing.title ?? ""}`,
    `precio: ${listing.price ?? ""}`,
    `metros: ${listing.surface_m2 ?? ""}`,
    `habitaciones: ${listing.rooms ?? ""}`,
    `banos: ${listing.bathrooms ?? ""}`,
    `tipo: ${listing.property_type ?? ""}`,
    `operacion: ${listing.operation ?? ""}`,
    `zona: ${listing.zone ?? ""}`,
    `ciudad: ${listing.city ?? ""}`,
    `direccion: ${listing.address ?? ""}`,
    `anunciante: ${listing.listing_type ?? ""}`,
    `privateLead: ${rawText(lead)}`,
    `classification: ${rawText(classification)}`,
    `contact.userType: ${String(contactInfo?.userType ?? "")}`,
    `contact.commercialName: ${String(contactInfo?.commercialName ?? "")}`,
    `descripcion: ${listing.description ?? ""}`,
    `raw: ${rawText(raw?.textPreview ?? raw)}`,
  ].filter((line) => line.replace(/^[^:]+:\s*/, "").trim()).join("\n").slice(0, 4_500);
}

function rulesOpportunity(listing: OpportunityListing): OpportunityAi {
  const confidence = privateConfidence(listing);
  const status = privateStatus(listing);
  const price = Number(listing.price ?? 0);
  const surface = Number(listing.surface_m2 ?? 0);
  const pricePerM2 = price > 0 && surface > 0 ? Math.round(price / surface) : null;
  const signals: string[] = [];
  const risks: string[] = [];
  let score = 25;

  if (status === "confirmed") {
    score += 38;
    signals.push("anunciante particular confirmado");
  } else if (status === "candidate") {
    score += 24;
    signals.push("posible particular");
  } else if (status === "rejected") {
    score -= 25;
    risks.push("anunciante profesional o agencia");
  }

  if (confidence >= 0.85) score += 10;
  if (price > 0) signals.push("precio disponible");
  else risks.push("sin precio");

  if (surface > 0) signals.push("superficie disponible");
  else risks.push("sin superficie");

  if (pricePerM2 != null) {
    if (pricePerM2 < 3_000) {
      score += 10;
      signals.push("€/m2 competitivo");
    } else if (pricePerM2 > 7_000) {
      score -= 6;
      risks.push("€/m2 alto");
    }
  }

  if (listing.description && listing.description.length > 160) score += 4;
  if (listing.url) signals.push("enlace al anuncio");
  if (!listing.zone && !listing.address) risks.push("ubicación poco precisa");

  score = clamp(Math.round(score), 0, 100);
  const priority: OpportunityPriority = score >= 72 ? "alta" : score >= 45 ? "media" : "baja";
  const place = [listing.zone, listing.city].filter(Boolean).join(", ") || "zona no especificada";
  const priceText = price > 0 ? `${price.toLocaleString("es-ES")} EUR` : "precio no disponible";
  const summary = `${listing.title || "Inmueble"} en ${place}, ${priceText}.`;
  const nextAction = status === "confirmed" || status === "candidate"
    ? "Revisar el anuncio y contactar al propietario con mensaje personalizado."
    : "Descartar si el objetivo es captar particulares; revisar solo si encaja por precio o zona.";

  return {
    version: VERSION,
    source: "rules",
    model: null,
    score,
    priority,
    private_owner_confidence: confidence,
    private_owner_status: status,
    summary,
    reason: signals.length ? signals.slice(0, 4).join("; ") : "Sin señales destacadas.",
    risks: risks.slice(0, 5),
    next_action: nextAction,
    suggested_message: `Hola, he visto tu anuncio${listing.title ? ` (${listing.title})` : ""}. Trabajo con compradores activos por la zona y puedo darte una valoración sin compromiso. ¿Te encaja que lo comentemos?`,
    signals: signals.slice(0, 8),
    duplicate_key: duplicateKey(listing),
    price_per_m2: pricePerM2,
  };
}

function parseOllamaJson(value: string): Partial<OpportunityAi> | null {
  const candidate = value.trim().startsWith("{") ? value.trim() : value.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as Partial<OpportunityAi>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 6);
}

function mergeOllama(base: OpportunityAi, parsed: Partial<OpportunityAi>, model: string): OpportunityAi {
  const score = clamp(Math.round(numberValue(parsed.score) ?? base.score), 0, 100);
  const priority = parsed.priority === "alta" || parsed.priority === "media" || parsed.priority === "baja"
    ? parsed.priority
    : score >= 72 ? "alta" : score >= 45 ? "media" : "baja";
  const confidence = clamp(numberValue(parsed.private_owner_confidence) ?? base.private_owner_confidence, 0, 1);

  return {
    ...base,
    source: "ollama",
    model,
    score,
    priority,
    private_owner_confidence: confidence,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 260) : base.summary,
    reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 360) : base.reason,
    risks: stringArray(parsed.risks, base.risks),
    next_action: typeof parsed.next_action === "string" && parsed.next_action.trim() ? parsed.next_action.trim().slice(0, 240) : base.next_action,
    suggested_message: typeof parsed.suggested_message === "string" && parsed.suggested_message.trim()
      ? parsed.suggested_message.trim().slice(0, 500)
      : base.suggested_message,
    signals: stringArray(parsed.signals, base.signals),
  };
}

function shouldUseOllama(listing: OpportunityListing, base: OpportunityAi): boolean {
  if (!envFlag("OPPORTUNITY_AI_OLLAMA_ENABLED", true)) return false;
  if (base.private_owner_status === "rejected" && base.score < 35) return false;
  const text = context(listing);
  return text.length > 80;
}

async function ollamaOpportunity(listing: OpportunityListing, base: OpportunityAi): Promise<OpportunityAi> {
  if (!shouldUseOllama(listing, base)) return base;

  const ollamaUrl = (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const model = process.env.OPPORTUNITY_AI_MODEL ?? process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct";
  const timeoutMs = envInt("OPPORTUNITY_AI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 2_000, 60_000);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  const prompt = [
    "Analiza este anuncio inmobiliario para un CRM de captación.",
    "Devuelve solo JSON válido. Sé conservador con particulares: usa los campos si existen.",
    "Prioriza oportunidades donde parezca haber propietario particular, precio interesante, urgencia o facilidad de contacto.",
    "No inventes datos de contacto.",
    "Forma exacta:",
    "{\"score\":0,\"priority\":\"alta|media|baja\",\"private_owner_confidence\":0.0,\"summary\":\"...\",\"reason\":\"...\",\"risks\":[\"...\"],\"next_action\":\"...\",\"suggested_message\":\"...\",\"signals\":[\"...\"]}",
    "",
    "Score base por reglas:",
    JSON.stringify(base),
    "",
    "Anuncio:",
    context(listing),
  ].join("\n");

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: "Eres un analista inmobiliario conservador. Respondes exclusivamente JSON válido." },
          { role: "user", content: prompt },
        ],
        options: { temperature: 0.1, num_predict: 260 },
      }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`ollama_non_2xx:${res.status}:${body.slice(0, 200)}`);
    const payload = JSON.parse(body) as { message?: { content?: string }, response?: string };
    const parsed = parseOllamaJson(payload.message?.content ?? payload.response ?? "");
    if (!parsed) throw new Error("ollama_bad_json");
    return mergeOllama(base, parsed, model);
  } catch (err) {
    return {
      ...base,
      source: "ollama_fallback",
      model,
      risks: [...base.risks, `Ollama no disponible: ${err instanceof Error ? err.message : String(err)}`].slice(0, 5),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichOpportunityAi<T extends OpportunityListing>(listing: T): Promise<T> {
  if (!envFlag("OPPORTUNITY_AI_ENABLED", true)) {
    const raw = asRecord(listing.raw) ?? { value: listing.raw };
    return {
      ...listing,
      raw: {
        ...raw,
        _opportunityAi: {
          version: VERSION,
          source: "disabled",
          score: 0,
          priority: "baja",
          private_owner_confidence: 0,
          private_owner_status: "unknown",
          summary: "",
          reason: "Opportunity AI desactivado",
          risks: [],
          next_action: "",
          suggested_message: "",
          signals: [],
          duplicate_key: duplicateKey(listing),
          price_per_m2: null,
        } satisfies OpportunityAi,
      },
    };
  }

  const base = rulesOpportunity(listing);
  const analysis = await ollamaOpportunity(listing, base);
  const raw = asRecord(listing.raw) ?? { value: listing.raw };
  return {
    ...listing,
    raw: {
      ...raw,
      _opportunityAi: analysis,
    },
  };
}

export async function enrichOpportunityBatch<T extends OpportunityListing>(listings: T[]): Promise<T[]> {
  const maxOllama = envInt("OPPORTUNITY_AI_MAX_OLLAMA_RESULTS", 18, 0, 200);
  const concurrency = envInt("OPPORTUNITY_AI_CONCURRENCY", 2, 1, 8);
  const baseListings = listings.map((listing) => {
    const base = rulesOpportunity(listing);
    const raw = asRecord(listing.raw) ?? { value: listing.raw };
    return {
      ...listing,
      raw: { ...raw, _opportunityAi: base },
    };
  });

  const candidates = baseListings
    .map((listing, index) => ({ listing, index, ai: asRecord(asRecord(listing.raw)?._opportunityAi) as OpportunityAi | null }))
    .filter(({ listing, ai }) => ai && shouldUseOllama(listing, ai))
    .sort((a, b) => (b.ai?.score ?? 0) - (a.ai?.score ?? 0))
    .slice(0, maxOllama);

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) {
      const current = candidates[next];
      next += 1;
      const enriched = await enrichOpportunityAi(current.listing);
      baseListings[current.index] = enriched;
    }
  });
  await Promise.all(workers);
  return baseListings;
}
