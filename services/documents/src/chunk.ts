export type Chunk = { ordinal: number; heading: string; body: string };

const MAX_CHARS = 700;

/**
 * The document's blocks: runs of lines with an empty line between them. Done
 * line by line and not with a pattern, so the cost is the document's length
 * whatever it contains.
 */
function blocks(markdown: string): string[] {
  const found: string[] = [];
  let lines: string[] = [];
  for (const line of [...markdown.split("\n"), ""]) {
    if (line.trim() !== "") {
      lines.push(line);
    } else if (lines.length > 0) {
      found.push(lines.join("\n"));
      lines = [];
    }
  }
  return found;
}

/**
 * A block that is a heading: one to four `#`, white space, and one line of
 * text. Read in steps, each of which looks at the block once.
 */
function headingOf(block: string): { depth: number; text: string } | null {
  const depth = /^#{1,4}/.exec(block)?.[0].length ?? 0;
  const rest = block.slice(depth);
  if (depth === 0 || !/^\s/.test(rest)) return null;
  const text = rest.trim();
  return text.includes("\n") ? null : { depth, text };
}

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

  for (const block of blocks(markdown)) {
    const text = block.trim();
    if (!text) continue;
    const found = headingOf(text);
    if (found) {
      flush();
      const { depth } = found;
      // The top-level heading repeats the title, so it is not added to the path.
      if (depth === 1) continue;
      path.length = depth - 2;
      path[depth - 2] = found.text;
      continue;
    }
    if (buffer.join("\n\n").length + text.length > MAX_CHARS) flush();
    buffer.push(text);
  }
  flush();
  return chunks;
}
