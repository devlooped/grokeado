import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClaimsTable, extractClaimRows } from "@/components/claims-table.tsx";
import { ModelSettingsForm, type ModelRow } from "@/components/model-settings-form.tsx";
import { loadModelSettings } from "@/court/model-config.ts";
import { MODEL_ROLES, modelEffort, resolveModels } from "@/court/models.ts";
import { auth0 } from "@/lib/auth0.ts";
import { isAdmin } from "@/lib/case-access.ts";
import { fetchGatewayModels } from "@/lib/gateway-catalog.ts";

export const metadata: Metadata = { title: "Administración · Che bot", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const session = await auth0.getSession();
  // Hidden rather than forbidden: the route does not exist for anyone else.
  if (!isAdmin(session?.user)) notFound();
  const [settings, catalog] = await Promise.all([
    loadModelSettings(),
    fetchGatewayModels().catch((err: unknown) => {
      console.warn("Gateway catalog unavailable:", err);
      return undefined;
    }),
  ]);
  const models = resolveModels(settings);
  const rows: ModelRow[] = MODEL_ROLES.map((role) => ({
    ...role,
    modelId: models[role.key].id,
    effort: role.configurableEffort ? modelEffort(models[role.key]) : null,
    overridden: settings.some((setting) => setting.role === role.key),
  }));
  const options = (catalog ?? []).filter((model) => model.type === "language" || model.type === "image");

  return (
    <div className="mx-auto max-w-4xl space-y-12 pt-10">
      <section>
        <h1 className="font-display text-4xl leading-none">Administración</h1>
        <p className="mt-2 text-sm text-ink-soft">Sesión y configuración de los modelos que usa cada función.</p>
      </section>

      <section aria-labelledby="claims-heading">
        <h2 id="claims-heading" className="border-b border-rule pb-2 font-display text-2xl leading-none">Sesión activa</h2>
        <div className="mt-3">
          <ClaimsTable rows={extractClaimRows(session!.user)} />
        </div>
      </section>

      <section aria-labelledby="models-heading">
        <h2 id="models-heading" className="border-b border-rule pb-2 font-display text-2xl leading-none">Modelos</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Cada caso toma una copia de esta configuración al abrir la sesión; los casos en curso no cambian.
          {!catalog && " El catálogo de AI Gateway no respondió: solo se valida el formato de los IDs."}
        </p>
        <ModelSettingsForm rows={rows} catalog={options} />
      </section>
    </div>
  );
}
