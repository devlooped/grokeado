import type { SourceBlock } from "./sources.ts";

// The normalization of groundResearch (evals/tiers/core.ts): no accents, lower
// case, punctuation and runs of space to one space.
export function normalizeQuoteText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// The text a reader sees in a Markdown block: an image is not text, and a link
// is its label, without its target or title, so that a quote across a link
// still matches.
export function readableText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, " ")
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<(?:https?|mailto):[^>\s]*>/g, " ");
}

// A shorter quote would match too many passages to attest anything.
const MIN_QUOTE_CHARS = 20;
const MIN_SEGMENT_CHARS = 8;

// The blocks that contain a quote, or undefined. The quote must be contained,
// once normalized, in the blocks taken in order; a quote that elides text with
// an ellipsis matches segment by segment, in order. No fuzzy score: a
// paraphrase, a translation or an invented quote does not match.
export function matchQuote(blocks: readonly SourceBlock[], quote: string): { blockIds: string[] } | undefined {
  const segments = quote.split(/…|\.{3,}|\[\s*(?:…|\.{3})\s*\]/u).map(normalizeQuoteText).filter(Boolean);
  if (!segments.length || segments.join(" ").length < MIN_QUOTE_CHARS || segments.some((segment) => segment.length < MIN_SEGMENT_CHARS)) return undefined;
  const normalized = blocks.map((block) => normalizeQuoteText(readableText(block.text)));
  const starts: number[] = [];
  let text = "";
  for (const block of blocks) {
    if (text) text += " ";
    starts.push(text.length);
    text += normalized[starts.length - 1];
  }
  const covered = new Set<number>();
  let from = 0;
  for (const segment of segments) {
    const at = text.indexOf(segment, from);
    if (at < 0) return undefined;
    const end = at + segment.length;
    blocks.forEach((block, index) => {
      const start = starts[index]!, stop = start + normalized[index]!.length;
      if (start < end && stop > at) covered.add(index);
    });
    from = end;
  }
  return { blockIds: [...covered].sort((a, b) => a - b).map((index) => blocks[index]!.id) };
}
