/**
 * The same question, read twice.
 *
 * Sending one page as several overlapping bands is what makes handwriting readable,
 * but the overlap has a cost: a question sitting on a seam appears in two bands, and
 * the model returns it twice — usually with tiny differences, because each band saw a
 * slightly different crop of the same ink. Before this, both copies were kept, so a
 * seven-question sheet produced eight or nine rows and the teacher had to find the
 * duplicate by eye.
 *
 * The comparison is deliberately about the words, not the numbering: readings of the
 * same band rarely agree on the printed number, and disagreeing on it is not evidence
 * of a different question.
 */

/** Words that carry no meaning for comparing two readings of the same line. */
function tokens(text: string): Set<string> {
  const normalised = text
    // Persian and Arabic digits to ASCII, so ۲ and 2 compare equal.
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    // Punctuation, including the Persian comma and the tatweel used to stretch words.
    .replace(/[\u0640\u200c\u200f\u200e]/g, "")
    .replace(/[.,،؛;:!?؟«»"'()\[\]{}ـ\-–—/\\]/g, " ")
    .toLowerCase();
  return new Set(normalised.split(/\s+/).filter((word) => word.length > 1));
}

/** How similar two readings are, 0 to 1 (Jaccard over word sets). */
export function textSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type DuplicateGroup<T> = { kept: T; dropped: T[]; similarity: number };

/**
 * Collapses readings of the same question, keeping the one that carries a key.
 *
 * Two readings of one line differ in a character or two. Two genuinely different
 * questions on a form share almost nothing beyond "است" and "کدام". The threshold sits
 * between those, and the choice of survivor is not arbitrary: the copy that actually
 * has a reference answer is the one worth keeping, because the other copy's silence is
 * a limitation of its crop, not knowledge that the key is empty.
 */
export function dedupeQuestions<T extends { prompt: string; answer: string }>(
  items: T[],
  options: { threshold?: number } = {},
): { kept: T[]; groups: DuplicateGroup<T>[] } {
  const threshold = options.threshold ?? 0.82;
  const kept: T[] = [];
  const groups: DuplicateGroup<T>[] = [];

  for (const item of items) {
    let matched: { index: number; similarity: number } | null = null;
    for (const [index, existing] of kept.entries()) {
      const similarity = textSimilarity(existing.prompt, item.prompt);
      if (similarity >= threshold && (matched === null || similarity > matched.similarity)) {
        matched = { index, similarity };
      }
    }
    if (!matched) {
      kept.push(item);
      continue;
    }
    const existing = kept[matched.index];
    // Keep whichever copy has the key; if both do, keep the one that was read first,
    // because bands arrive in page order and the first reading is the fuller crop.
    if (!existing.answer.trim() && item.answer.trim()) kept[matched.index] = item;
    const group = groups.find((candidate) => candidate.kept === kept[matched.index] || candidate.kept === existing);
    if (group) {
      group.dropped.push(existing === group.kept ? item : existing);
      group.kept = kept[matched.index];
    } else {
      groups.push({ kept: kept[matched.index], dropped: [existing === kept[matched.index] ? item : existing], similarity: matched.similarity });
    }
  }

  return { kept, groups };
}
