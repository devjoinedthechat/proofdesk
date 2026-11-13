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
 * A stand-in embedder with no model behind it: words and word pairs are hashed
 * into a fixed-size vector. Texts that share words land near each other, and
 * that is all it knows. It is deterministic, free and offline, which makes it
 * right for tests and for measuring the index. It is not a measure of how
 * well a real embedding model would retrieve.
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

/**
 * Voyage AI embeddings. Untested here: no Voyage key was available when this
 * was written, so only its request shape is checked, against a fake endpoint.
 */
export function createVoyageEmbedder(options: {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}): Embedder {
  const model = options.model ?? "voyage-3.5";
  const send = options.fetch ?? fetch;
  return {
    model,
    async embed(texts, kind) {
      const response = await send("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          input: texts,
          model,
          input_type: kind,
          output_dimension: EMBEDDING_DIMENSIONS,
        }),
      });
      if (!response.ok) throw new Error(`Voyage embeddings failed with status ${response.status}`);
      const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
      return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}

export const toVectorLiteral = (values: number[]) => `[${values.join(",")}]`;
