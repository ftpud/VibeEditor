export type Compatibility = { minimum: number; maximum: number };

export function compatibleClient(client: Compatibility, core: Compatibility): boolean {
  return Number.isInteger(client.minimum) && Number.isInteger(client.maximum)
    && client.minimum <= client.maximum && core.minimum <= core.maximum
    && client.minimum <= core.maximum && core.minimum <= client.maximum;
}

export function readCompatibility(value: unknown): Compatibility | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as { compatibility?: unknown };
  if (!item.compatibility || typeof item.compatibility !== "object") return undefined;
  const compatibility = item.compatibility as Partial<Compatibility>;
  return Number.isInteger(compatibility.minimum) && Number.isInteger(compatibility.maximum) ? compatibility as Compatibility : undefined;
}
