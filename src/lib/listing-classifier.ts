export type ListingKind = "particular" | "agencia" | "unknown";

export type ListingTypeClassification = {
  listing_type: ListingKind;
  confidence: number;
  source: "existing" | "field" | "text" | "ollama" | "disabled" | "error";
  reason: string;
  evidence: string[];
};

export type ClassifiableListing = {
  title?: string | null;
  url?: string | null;
  address?: string | null;
  zone?: string | null;
  city?: string | null;
  description?: string | null;
  listing_type?: string | null;
  raw?: unknown;
  [key: string]: unknown;
};

const DEFAULT_MODEL = "qwen2.5:7b-instruct";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_CONTEXT_CHARS = 3_000;

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
    return JSON.stringify(value).slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = normalizeText(process.env[name]);
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function confidenceThreshold(): number {
  const parsed = Number.parseFloat(process.env.LISTING_CLASSIFIER_MIN_CONFIDENCE ?? "0.75");
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.75;
}

export function canonicalListingType(value: unknown): "particular" | "agencia" | null {
  const text = normalizeText(value);
  if (!text) return null;
  if (/\b(particular|private|privado|propietario|owner|privateuser)\b/.test(text)) return "particular";
  if (/\b(agencia|agencias|agency|inmobiliaria|professional|profesional|promotor|promotora|real estate|properties|consulting)\b/.test(text)) {
    return "agencia";
  }
  return null;
}

function listingContext(listing: ClassifiableListing): string {
  const raw = asRecord(listing.raw);
  const contactInfo = asRecord(raw?.contactInfo);
  const values = [
    `portal: ${String(listing.portal ?? "")}`,
    `titulo: ${listing.title ?? ""}`,
    `url: ${listing.url ?? ""}`,
    `direccion: ${listing.address ?? ""}`,
    `zona: ${listing.zone ?? ""}`,
    `ciudad: ${listing.city ?? ""}`,
    `descripcion: ${listing.description ?? ""}`,
    `listing_type: ${listing.listing_type ?? ""}`,
    `raw.listingType: ${String(raw?.listingType ?? "")}`,
    `raw.advertiserType: ${String(raw?.advertiserType ?? "")}`,
    `raw.publisherType: ${String(raw?.publisherType ?? "")}`,
    `raw.userType: ${String(raw?.userType ?? "")}`,
    `raw.privateUser: ${String(raw?.privateUser ?? "")}`,
    `raw.isPrivate: ${String(raw?.isPrivate ?? "")}`,
    `raw.isProfessional: ${String(raw?.isProfessional ?? "")}`,
    `contact.userType: ${String(contactInfo?.userType ?? "")}`,
    `contact.name: ${String(contactInfo?.name ?? "")}`,
    `contact.commercialName: ${String(contactInfo?.commercialName ?? "")}`,
    `raw.text: ${rawText(raw?.textPreview ?? listing.raw)}`,
  ];
  return values.filter((line) => line.replace(/^[^:]+:\s*/, "").trim()).join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function fieldClassification(listing: ClassifiableListing): ListingTypeClassification | null {
  const raw = asRecord(listing.raw);
  const contactInfo = asRecord(raw?.contactInfo);

  const strongFields: Array<[string, unknown]> = [
    ["listing.listing_type", listing.listing_type],
    ["raw.listingType", raw?.listingType],
    ["raw.advertiserType", raw?.advertiserType],
    ["raw.publisherType", raw?.publisherType],
    ["raw.userType", raw?.userType],
    ["raw.sellerType", raw?.sellerType],
    ["contact.userType", contactInfo?.userType],
  ];

  for (const [label, value] of strongFields) {
    const detected = canonicalListingType(value);
    if (detected) {
      return {
        listing_type: detected,
        confidence: 0.98,
        source: label === "listing.listing_type" ? "existing" : "field",
        reason: `Campo explícito ${label}`,
        evidence: [`${label}: ${String(value)}`],
      };
    }
  }

  const booleans: Array<[string, unknown, ListingKind]> = [
    ["raw.privateUser", raw?.privateUser, "particular"],
    ["raw.isPrivate", raw?.isPrivate, "particular"],
    ["raw.isProfessional", raw?.isProfessional, "agencia"],
    ["contact.isProfessional", contactInfo?.isProfessional, "agencia"],
  ];
  for (const [label, value, listingType] of booleans) {
    if (value === true || value === "true") {
      return {
        listing_type: listingType,
        confidence: 0.98,
        source: "field",
        reason: `Campo booleano ${label}`,
        evidence: [`${label}: true`],
      };
    }
  }

  const commercialName = String(contactInfo?.commercialName ?? "").trim();
  if (commercialName) {
    return {
      listing_type: "agencia",
      confidence: 0.9,
      source: "field",
      reason: "El anuncio incluye nombre comercial del anunciante",
      evidence: [`contact.commercialName: ${commercialName}`],
    };
  }

  return null;
}

function textClassification(listing: ClassifiableListing): ListingTypeClassification | null {
  const context = normalizeText(listingContext(listing));
  if (!context) return null;

  const particularPatterns: Array<[RegExp, string]> = [
    [/\b(?:sin|no)\s+agencias\b/, "rechaza agencias"],
    [/\babstenerse\s+agencias\b/, "rechaza agencias"],
    [/\btrato\s+directo\b/, "trato directo"],
    [/\bdirecto\s+(?:con\s+)?(?:propietario|dueno|duena)\b/, "directo con propietario"],
    [/\b(?:particular|propietario|dueno|duena)\s+(?:vende|alquila)\b/, "particular/propietario vende o alquila"],
    [/\b(?:vende|alquila)\s+(?:particular|propietario|dueno|duena)\b/, "vende/alquila particular"],
    [/\bde\s+particular\s+a\s+particular\b/, "de particular a particular"],
  ];
  for (const [pattern, reason] of particularPatterns) {
    if (pattern.test(context)) {
      return {
        listing_type: "particular",
        confidence: 0.88,
        source: "text",
        reason,
        evidence: [reason],
      };
    }
  }

  const agencyPatterns: Array<[RegExp, string]> = [
    [/\bagencia\s+inmobiliaria\b/, "agencia inmobiliaria"],
    [/\binmobiliaria\b/, "inmobiliaria"],
    [/\bpromotor(?:a)?\b/, "promotor/promotora"],
    [/\bprofesional\b/, "profesional"],
    [/\bcommercialname\b/, "nombre comercial"],
    [/\blider\s+de\s+zona\b/, "líder de zona"],
    [/\bcalidad\s+fotocasa\b/, "calidad fotocasa"],
    [/\breal\s+estate\b/, "real estate"],
  ];
  for (const [pattern, reason] of agencyPatterns) {
    if (pattern.test(context)) {
      return {
        listing_type: "agencia",
        confidence: 0.88,
        source: "text",
        reason,
        evidence: [reason],
      };
    }
  }

  return null;
}

function parseOllamaJson(value: unknown): Partial<ListingTypeClassification> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return {
      listing_type: parsed.listing_type === "particular" || parsed.listing_type === "agencia" || parsed.listing_type === "unknown"
        ? parsed.listing_type
        : "unknown",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence ?? 0),
      source: "ollama",
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : "Respuesta de Ollama",
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.map((item) => String(item).slice(0, 160)).slice(0, 4)
        : [],
    };
  } catch {
    return null;
  }
}

async function classifyWithOllama(listing: ClassifiableListing): Promise<ListingTypeClassification> {
  if (!envFlag("LISTING_CLASSIFIER_ENABLED", true) || !envFlag("OLLAMA_LISTING_CLASSIFIER_ENABLED", true)) {
    return {
      listing_type: "unknown",
      confidence: 0,
      source: "disabled",
      reason: "Clasificador desactivado por configuración",
      evidence: [],
    };
  }

  const ollamaUrl = (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const model = process.env.OLLAMA_MODEL ?? process.env.LISTING_CLASSIFIER_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = Number.parseInt(process.env.LISTING_CLASSIFIER_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

  const prompt = [
    "Clasifica si este anuncio inmobiliario parece publicado por un particular o por una agencia/profesional.",
    "Usa solo evidencia del texto/campos. Si no hay evidencia clara, responde unknown.",
    "No asumas particular por ausencia de nombre comercial.",
    "Devuelve exclusivamente JSON con esta forma:",
    "{\"listing_type\":\"particular|agencia|unknown\",\"confidence\":0.0,\"reason\":\"...\",\"evidence\":[\"...\"]}",
    "",
    listingContext(listing),
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
          {
            role: "system",
            content: "Eres un clasificador conservador de anuncios inmobiliarios. Respondes solo JSON válido.",
          },
          { role: "user", content: prompt },
        ],
        options: {
          temperature: 0,
          num_predict: 180,
        },
      }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`ollama_non_2xx:${res.status}:${body.slice(0, 200)}`);
    const parsed = JSON.parse(body) as { message?: { content?: string }, response?: string };
    const content = parsed.message?.content ?? parsed.response ?? "";
    const classification = parseOllamaJson(content);
    if (!classification) throw new Error(`ollama_bad_json:${content.slice(0, 200)}`);

    const confidence = Number.isFinite(classification.confidence)
      ? Math.min(Math.max(Number(classification.confidence), 0), 1)
      : 0;
    return {
      listing_type: classification.listing_type ?? "unknown",
      confidence,
      source: "ollama",
      reason: classification.reason ?? "Respuesta de Ollama",
      evidence: classification.evidence ?? [],
    };
  } catch (err) {
    return {
      listing_type: "unknown",
      confidence: 0,
      source: "error",
      reason: err instanceof Error ? err.message : String(err),
      evidence: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function classifyListingType(listing: ClassifiableListing): Promise<ListingTypeClassification> {
  const field = fieldClassification(listing);
  if (field) return field;

  const text = textClassification(listing);
  if (text) return text;

  return await classifyWithOllama(listing);
}

export async function enrichListingType<T extends ClassifiableListing>(listing: T): Promise<T> {
  const classification = await classifyListingType(listing);
  const threshold = confidenceThreshold();
  const accepted =
    classification.listing_type !== "unknown" &&
    classification.confidence >= threshold;

  const raw = asRecord(listing.raw) ?? { value: listing.raw };
  return {
    ...listing,
    listing_type: accepted ? classification.listing_type : listing.listing_type,
    raw: {
      ...raw,
      _listingTypeClassification: classification,
    },
  };
}
