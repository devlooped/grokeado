import { databaseConfigured, getModelSettings } from "../store.ts";
import { resolveModels, type ModelConfig, type ModelSetting } from "./models.ts";

// Without a database (unit tests, some scripts) every role uses its default.
export async function loadModelSettings(): Promise<ModelSetting[]> {
  return databaseConfigured() ? getModelSettings() : [];
}

export async function loadModels(): Promise<ModelConfig> {
  return resolveModels(await loadModelSettings());
}
