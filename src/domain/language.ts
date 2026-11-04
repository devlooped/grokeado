export function languageInstruction(language: string): string {
  const name = language.toLowerCase().split("-")[0] === "es" ? "español latinoamericano" : language === "en" ? "inglés" : language;
  return `Idioma del caso: ${name}. Escribí en ese idioma. Conservá las citas textuales originales y señalá claramente las traducciones de citas.`;
}
