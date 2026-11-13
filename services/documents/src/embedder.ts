import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 1024;

export interface Embedder {
  /** Stored with every chunk, so a change of model can be detected and re-indexed. */
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can do for from has have how i if in is it its my of on or our so that the their this to was we what when will with you your".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

/**
 * A test double with no model behind it: words and word pairs are hashed into
 * a fixed-size vector. Texts that share words land near each other, and that
 * is all it knows. It is deterministic, free and offline, which makes it right
 * for testing the vector path and for measuring the index. It is never used to
 * answer a real search, and it says nothing about how an embedding model
 * would retrieve.
 */
export function createHashEmbedder(): Embedder {
  function vector(text: string): number[] {
    const values = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const words = tokenize(text);
    const features = [...words, ...words.slice(1).map((word, index) => `${words[index]}_${word}`)];
    for (const feature of features) {
      const digest = createHash("md5").update(feature).digest();
      const slot = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
      values[slot] =
        (values[slot] ?? 0) + (digest[4] !== undefined && digest[4] % 2 === 0 ? 1 : -1);
    }
    const norm = Math.hypot(...values) || 1;
    return values.map((value) => value / norm);
  }
  return {
    model: "hash-1024",
    embed: async (texts) => texts.map(vector),
  };
}

export const toVectorLiteral = (values: number[]) => `[${values.join(",")}]`;
