"use server";

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Submission } from "@/domain/court.ts";
import { createCase, getCase, newCaseId, requeueCase, UPLOADS_DIR } from "@/store.ts";

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const note = z.string().trim().max(500).optional().transform((v) => v || undefined);

const RequestForm = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(20, "Pegá un texto de al menos 20 caracteres.").max(6000, "El texto es demasiado largo (máximo 6000 caracteres).") }),
  z.object({ kind: z.literal("link"), url: z.url({ protocol: /^https?$/, error: "Ingresá un enlace válido (http o https)." }), note }),
  z.object({
    kind: z.literal("image"),
    image: z
      .instanceof(File, { error: "Elegí una imagen." })
      .refine((f) => f.size > 0, "Elegí una imagen.")
      .refine((f) => f.size <= MAX_IMAGE_BYTES, "La imagen no puede superar 4 MB.")
      .refine((f) => f.type in IMAGE_TYPES, "Formatos aceptados: PNG, JPG, WEBP o GIF."),
    note,
  }),
]);

export type RequestState = { error?: string };

export async function requestFactCheck(_prev: RequestState, formData: FormData): Promise<RequestState> {
  const parsed = RequestForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Revisá los datos." };

  const id = newCaseId();
  let submission: Submission;
  const input = parsed.data;
  if (input.kind === "image") {
    const file = id + "." + IMAGE_TYPES[input.image.type as keyof typeof IMAGE_TYPES];
    mkdirSync(UPLOADS_DIR, { recursive: true });
    writeFileSync(path.join(/*turbopackIgnore: true*/ UPLOADS_DIR, file), Buffer.from(await input.image.arrayBuffer()));
    submission = { kind: "image", file, mimeType: input.image.type, note: input.note };
  } else {
    submission = input;
  }
  createCase(id, submission);
  redirect("/caso/" + id);
}

export async function retryCase(id: string): Promise<void> {
  if (getCase(id)?.status === "failed") requeueCase(id);
  redirect("/caso/" + id);
}
