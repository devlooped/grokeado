export interface CatalogModel {
  id: string;
  name: string;
  type: string;
  tags: string[];
  efforts: string[];
}

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function parseCatalog(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("El catálogo de AI Gateway no tiene el formato esperado.");
  return data.flatMap((entry): CatalogModel[] => {
    const model = entry as Record<string, unknown> | null;
    if (typeof model?.id !== "string") return [];
    const effort = Array.isArray(model.reasoning_options)
      ? (model.reasoning_options as Array<Record<string, unknown>>).find((option) => option?.type === "effort")
      : undefined;
    return [{
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      type: typeof model.type === "string" ? model.type : "",
      tags: strings(model.tags),
      efforts: strings(effort?.values).filter((value) => value !== "none"),
    }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// The public catalog needs no credential and changes rarely.
export async function fetchGatewayModels(): Promise<CatalogModel[]> {
  const response = await fetch(CATALOG_URL, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("El catálogo de AI Gateway respondió " + response.status + ".");
  return parseCatalog(await response.json());
}
