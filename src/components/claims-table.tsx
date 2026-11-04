export function formatClaimValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function extractClaimRows(claims: Record<string, unknown> | null | undefined): { key: string; value: string }[] {
  if (!claims) return [];
  const entries = Object.entries(claims).filter(([, value]) => value !== undefined);
  const priority = ["sub", "email", "email_verified", "roles"];
  entries.sort(([a], [b]) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? priority.length : ai) - (bi === -1 ? priority.length : bi);
    return a.localeCompare(b);
  });
  return entries.map(([key, value]) => ({ key, value: formatClaimValue(value) }));
}

export function ClaimsTable({ rows }: { rows: { key: string; value: string }[] }) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead>
        <tr className="border-b border-rule font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            Claim
          </th>
          <th scope="col" className="py-1.5 font-medium">
            Valor
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-rule/60 font-mono">
        {rows.map(({ key, value }) => (
          <tr key={key} className="align-top">
            <th scope="row" className="py-1.5 pr-3 font-medium break-all text-ink-soft">
              {key}
            </th>
            <td className="py-1.5 break-all text-ink">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
