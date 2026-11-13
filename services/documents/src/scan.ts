export type Finding = { rule: string; excerpt: string };

/**
 * Patterns that have no business in a help-centre article: text addressed to
 * an automated agent, or text that tries to change what it may do. Each is a
 * heuristic. A determined author can write around all of them, so this scan
 * lowers the volume of obvious poison and is not a guarantee.
 */
const RULES: [string, RegExp][] = [
  [
    "addresses_the_agent",
    /\b(note|instruction|message)s? (to|for) (the )?(support )?(agent|assistant|ai|model)\b/i,
  ],
  [
    "override_instructions",
    /\b(ignore|disregard|override|forget) (all |any |the )?(previous|prior|above|earlier|system|other) (instructions|rules|policy|policies|prompt)/i,
  ],
  ["fake_system_message", /(^|\n)\s*(system|assistant)\s*(:|override|message)/i],
  [
    "unconditional_refund",
    /\b(always|must|required to|shall) (issue|approve|grant|give|process) (a |any |all |the )?(full )?refunds?\b/i,
  ],
  [
    "regardless_of_policy",
    /\bregardless of (the |its |their )?(policy|window|age|limit|approval)/i,
  ],
  ["conceal", /\bdo not (mention|tell|reveal|disclose) (this|that|the)\b/i],
  ["names_internal_tools", /\b(create_refund|resolve_ticket|list_invoices|system prompt)\b/i],
];

export function scanDocument(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, pattern] of RULES) {
    const match = pattern.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 30);
      findings.push({
        rule,
        excerpt: text.slice(start, match.index + match[0].length + 30).trim(),
      });
    }
  }
  return findings;
}
