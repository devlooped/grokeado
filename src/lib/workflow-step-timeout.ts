import { readFile, writeFile } from "node:fs/promises";

// The SDK generates a combined workflow/step function. Vercel reads this file
// after the Next build; preserve its queue trigger while setting its duration.
export async function configureWorkflowStepTimeout(file: string, value: string | undefined): Promise<void> {
  const seconds = value === undefined ? 600 : Number(value);
  if ((value !== undefined && !/^[1-9]\d*$/.test(value)) || !Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error("STEP_TIMEOUT must be a positive whole number of seconds");
  }
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!config.workflows || !Array.isArray(config.workflows.experimentalTriggers)) {
    throw new Error("Unexpected generated workflow function configuration");
  }
  config.workflows.maxDuration = seconds;
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
}
