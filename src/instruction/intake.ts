import { resolveCaseLanguage } from "../court/language.ts";
import type { ModelConfig } from "../court/models.ts";
import type { Submission, SubmissionContext } from "../domain/court.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { imageDescriber } from "../evidence/describe.ts";
import type { Recognize } from "../evidence/extract.ts";
import { sha256 } from "../evidence/validate.ts";
import { getImage, saveCaseLanguage } from "../store.ts";
import { SourceService, type SourceDependencies } from "./sources.ts";

type IntakeDependencies = {
  sources: SourceDependencies;
  artifacts: ArtifactStore;
  getImage: typeof getImage;
  saveLanguage: typeof saveCaseLanguage;
  detect: typeof resolveCaseLanguage;
  describe: Recognize;
};

export async function collectInstruction(caseId: string, original: Submission, models: ModelConfig, simulated: boolean, dependencies: Omit<IntakeDependencies, "describe"> & { describe?: Recognize }): Promise<{ submission: Submission; context?: SubmissionContext; language: string }> {
  const deps = { ...dependencies, describe: dependencies.describe ?? imageDescriber(models["image.description"], original.kind === "text" ? undefined : original.note, caseId) };
  const host = new SourceService(caseId, "und", deps.sources);
  const { resolvedLanguage: _resolved, ...submitted } = original;
  await deps.artifacts.write(caseId, new Map([["instruction/base/submission.json", JSON.stringify(submitted)]]));
  let context: SubmissionContext | undefined;
  if (original.kind === "link") {
    const inspected = await host.inspect(original.url);
    context = { title: inspected.document.title, finalUrl: inspected.acquisition.finalUrl, tool: inspected.document.tool, excerpt: inspected.blocks.map((block) => block.text).join("\n\n").slice(0, 16_000) };
  } else if (original.kind === "image") {
    const image = await deps.getImage(caseId);
    if (!image) throw new Error("Submitted image unavailable; no raw-image fallback is permitted");
    await deps.artifacts.write(caseId, new Map([["instruction/base/original.bin", image.bytes]]));
    const described = await host.hostStage(`intake-description:${sha256(image.bytes)}`, "intake-description", async () => {
      const description = await deps.describe(image.bytes, image.mimeType);
      if (!description.text.trim()) throw new Error("Image description unavailable");
      await deps.artifacts.write(caseId, new Map([["instruction/base/description.json", JSON.stringify(description)]]));
      return description;
    });
    context = { title: "", tool: described.tool, excerpt: described.text };
  }
  const language = await host.hostStage(`case-language:${sha256(JSON.stringify([submitted, context, models.language]))}`, "case-language", () => deps.detect(caseId, original, context, simulated, undefined, models.language));
  await deps.saveLanguage(caseId, language);
  const reader = new SourceService(caseId, language, deps.sources);
  let submission: Submission;
  if (original.kind === "text") {
    submission = { ...original, resolvedLanguage: language, text: (await reader.normalize("", original.text)).body };
  } else {
    const note = original.note ? (await reader.normalize("", original.note)).body : undefined;
    submission = { ...original, resolvedLanguage: language, ...(note ? { note } : {}) };
    if (original.kind === "link") {
      const read = await reader.read({ url: original.url, maxChars: 16_000 });
      if (read.status !== "ready") throw new Error(`Submitted source ${read.status}; instruction cannot start`);
      context = { title: read.title, finalUrl: context?.finalUrl, tool: "shared-source", excerpt: read.blocks.map((block) => block.text).join("\n\n") };
    } else if (context) {
      const normalized = await reader.normalize(context.title, context.excerpt);
      context = { ...context, title: normalized.title, excerpt: normalized.body };
    }
  }
  const projection = { submission, ...(context ? { context } : {}), language };
  await deps.artifacts.write(caseId, new Map([["instruction/base/case-language.json", JSON.stringify(projection)]]));
  return projection;
}
