// The name of a case language, in English, for the prompts of the models.
// Spanish always means Latin American Spanish.
export function languageName(language: string): string {
  const tag = language.trim();
  if (tag.toLowerCase().split("-")[0] === "es") return "Latin American Spanish";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) return name;
  } catch { /* An unknown tag is named by itself. */ }
  return tag;
}

// The first rule of every prompt the app writes. The prompts are in English;
// everything a model writes is in the case language, quotations included.
export function languageRule(language: string): string {
  const name = languageName(language);
  return `LANGUAGE RULE: The case language is ${name}. These instructions are in English, but everything you write must be in ${name}: replies, tool arguments, analyses, drafts and quotations. When you quote a source, a search result or a post in another language, translate the quotation faithfully into ${name}; never keep it in its original language. Identifiers, URLs, numbers, tool names, enum values and JSON keys stay exactly as they are.`;
}
