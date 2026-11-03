import { randomInt } from "node:crypto";

// Argentine licence-plate style: AA-NNN-AA, 26^4 * 10^3 = 456,976,000 ids.
export const CASE_ID_PATTERN = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function newCaseId(random: (max: number) => number = randomInt): string {
  const letter = () => LETTERS[random(LETTERS.length)];
  const digit = () => String(random(10));
  return letter() + letter() + "-" + digit() + digit() + digit() + "-" + letter() + letter();
}

export function isCaseId(id: string): boolean {
  return CASE_ID_PATTERN.test(id);
}
