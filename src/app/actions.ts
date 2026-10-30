"use server";

import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { z } from "zod";
import type { Submission } from "@/domain/court.ts";
import { auth0 } from "@/lib/auth0.ts";
import { createCase, finishCase, newCaseId, requeueCase } from "@/store.ts";
import { courtSession } from "@/workflows/court-session.ts";

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

const note = z.string().trim().max(500).optional().transform((v) => v || undefined);

const RequestForm = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(20, "Pegá un texto de al menos 20 caracteres.").max(6000, "El texto es demasiado largo (máximo 6000 caracteres).") }),
  z.object({
    kind: z.literal("link"),
    url: z
      .url({ protocol: /^https?$/, error: "Ingresá un enlace válido (http o https)." })
      .refine((u) => !PRIVATE_HOST.test(new URL(u).hostname), "Ingresá un enlace público."),
    note,
  }),
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
  const session = await auth0.getSession();
  if (!session?.user.sub) return { error: "Iniciá sesión para pedir un chequeo." };
  const parsed = RequestForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Revisá los datos." };

  const id = newCaseId();
  let submission: Submission;
  let image: Buffer | undefined;
  const input = parsed.data;
  if (input.kind === "image") {
    image = Buffer.from(await input.image.arrayBuffer());
    submission = { kind: "image", mimeType: input.image.type, note: input.note };
  } else {
    submission = input;
  }
  await createCase(id, submission, image, session.user.sub);
  try {
    await start(courtSession, [id]);
  } catch (err) {
    console.error("could not start court session:", err);
    await finishCase(id, "failed", "No se pudo iniciar la sesión.");
  }
  redirect("/caso/" + id);
}

export async function retryCase(id: string): Promise<void> {
  if (await requeueCase(id)) {
    try {
      await start(courtSession, [id]);
    } catch (err) {
      console.error("could not start court session:", err);
      await finishCase(id, "failed", "No se pudo iniciar la sesión.");
    }
  }
  redirect("/caso/" + id);
}
