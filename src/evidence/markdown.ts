import MarkdownIt from "markdown-it";

export interface EvidencePreview {
  title: string;
  body: string;
  pages: readonly number[];
  language: string;
}

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const markdown = new MarkdownIt({ html: false, linkify: false });
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url) => {
  if (!defaultValidateLink(url) || /[\x00-\x20\\]/.test(url) || url.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return !scheme || /^(https?|mailto)$/i.test(scheme[1]!);
};
// Images are evidence text, never browser-initiated requests.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  escape(renderer.renderInlineAsText(tokens[index]!.children ?? [], options, env));

markdown.inline.ruler.before("link", "evidence_anchor", (state, silent) => {
  const match = /^\[p(?:\.(\d+)|(\d+):b(\d+))\]/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push("evidence_anchor", "", 0);
    token.meta = { page: Number(match[1] ?? match[2]), block: match[3] === undefined ? undefined : Number(match[3]) };
  }
  state.pos += match[0].length;
  return true;
});
markdown.renderer.rules.evidence_anchor = (tokens, index, _options, env) => {
  const { page, block } = tokens[index]!.meta as { page: number; block?: number };
  const ids = (env as { ids: Set<string> }).ids;
  const pageId = `p${page}`;
  const blockId = block === undefined ? undefined : `${pageId}:b${block}`;
  const pageAnchor = ids.has(pageId) ? "" : `<span id="${pageId}"></span>`;
  ids.add(pageId);
  const blockAnchor = blockId && !ids.has(blockId) ? `<span id="${blockId}"></span>` : "";
  if (blockId) ids.add(blockId);
  return `${pageAnchor}${blockAnchor}<span class="page">${block === undefined ? `Página ${page}` : `[p${page}:b${block}]`}</span>`;
};

export function renderEvidenceMarkdown({ title, body, pages, language }: EvidencePreview): string {
  const env = { ids: new Set<string>() };
  const content = markdown.render(body, env);
  const missing = [...new Set(pages)].filter((page) => Number.isSafeInteger(page) && page >= 0 && !env.ids.has(`p${page}`))
    .map((page) => `<span id="p${page}"></span>`).join("");
  return `<!doctype html><html lang="${escape(language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title || "Documento de evidencia")} · CheBot</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:70rem;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}.page{font-weight:700}table{border-collapse:collapse}th,td{border:1px solid;padding:.3rem}</style><main>${missing}${content}</main></html>`;
}
