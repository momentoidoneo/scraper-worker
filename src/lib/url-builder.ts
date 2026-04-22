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
  operation: "compra" | "alquiler" | string;
  property_type: "piso" | "casa" | "local" | string;
  city: string;
};

// --- IDEALISTA ---
// https://www.idealista.com/venta-viviendas/barcelona-barcelona/
// https://www.idealista.com/alquiler-viviendas/madrid-madrid/
export function buildIdealistaUrl(p: SearchParams): string {
  const op = p.operation === "alquiler" ? "alquiler-viviendas" : "venta-viviendas";
  const slug = slugifyCity(p.city);
  // Idealista usa "ciudad-provincia". Si solo tenemos ciudad, repetimos
  // (funciona para capitales de provincia: barcelona-barcelona, madrid-madrid...)
  return `https://www.idealista.com/${op}/${slug}-${slug}/`;
}
