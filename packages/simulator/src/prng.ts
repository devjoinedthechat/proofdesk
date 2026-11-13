const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** FNV-1a, used to turn a name into a numeric seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A small seeded generator (mulberry32). The simulator never calls
 * Math.random or reads the clock, so one seed always yields one company.
 */
export class Prng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("Cannot pick from an empty list");
    return item;
  }

  /** An opaque identifier such as `inv_4k9x0m2h7qpd`. */
  id(prefix: string): string {
    let suffix = "";
    for (let i = 0; i < 12; i++) suffix += ID_ALPHABET[this.int(0, ID_ALPHABET.length - 1)];
    return `${prefix}_${suffix}`;
  }
}
