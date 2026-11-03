export type CaseUser = { sub?: string; email?: string; email_verified?: boolean };

export const BETA_MESSAGE = "Che.bot está en beta. Para pedir un chequeo, enviá un correo a hola@che.bot.";

export function canRequestCase(user: CaseUser | null | undefined): boolean {
  return !!user?.sub && user.email_verified === true && user.email?.toLowerCase() === "daniel@cazzulino.com";
}
