export type Chunk = { ordinal: number; heading: string; body: string };

const MAX_CHARS = 700;

/**
 * Splits a Markdown document into retrievable pieces. Every piece carries the
 * path of headings above it, so a paragraph that only makes sense under its
 * heading is still found and still understood when read alone.
 */
export function chunkMarkdown(title: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let buffer: string[] = [];

  const heading = () => [title, ...path.filter(Boolean)].join(" > ");
  const flush = () => {
    const body = buffer.join("\n\n").trim();
    if (body) chunks.push({ ordinal: chunks.length, heading: heading(), body });
    buffer = [];
  };

  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text) continue;
    const match = /^(#{1,4})\s+(.*)$/.exec(text);
    if (match) {
      flush();
      const depth = (match[1] ?? "#").length;
      // The top-level heading repeats the title, so it is not added to the path.
      if (depth === 1) continue;
      path.length = depth - 2;
      path[depth - 2] = (match[2] ?? "").trim();
      continue;
    }
    if (buffer.join("\n\n").length + text.length > MAX_CHARS) flush();
    buffer.push(text);
  }
  flush();
  return chunks;
}
