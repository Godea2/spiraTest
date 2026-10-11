const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
};

function decodeEntity(entity: string): string {
  if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? " ";
  const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/**
 * Spira stores descriptions and steps as HTML. This keeps the words and the line structure
 * (paragraphs, line breaks, list items) as plain text, so it can be shown without rendering HTML.
 */
export function richText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
