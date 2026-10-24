export type RepeatedPhrase = { phrase: string; count: number };

const ENGLISH_FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have", "he", "her", "hers", "him", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "ours", "she", "that", "the", "their", "them", "there", "they", "this", "those", "to", "was", "we", "were", "with", "you", "your",
]);

/** 本地统计当前章节里反复出现的连续表达，不判断其是否错误。 */
export function findRepeatedPhrases(textRuns: readonly string[], limit = 16): RepeatedPhrase[] {
  const counts = new Map<string, { phrase: string; occurrences: Array<{ source: number; from: number; to: number }> }>();
  const add = (rawPhrase: string, source: number, from: number, to: number) => {
    const key = rawPhrase.toLocaleLowerCase();
    const current = counts.get(key);
    if (current) current.occurrences.push({ source, from, to });
    else counts.set(key, { phrase: rawPhrase, occurrences: [{ source, from, to }] });
  };

  let source = 0;
  for (const text of textRuns) {
    for (const segment of text.split(/[，,。！？!?；;：:\n\r]+/u)) {
      const segmentSource = source++;
      for (const match of segment.matchAll(/[\u3400-\u9fff]+/gu)) {
        const run = match[0];
        const runSource = source++;
        for (let length = 4; length <= Math.min(10, run.length); length += 1) {
          for (let start = 0; start + length <= run.length; start += 1) {
            add(run.slice(start, start + length), runSource, start, start + length);
          }
        }
      }

      const words = [...segment.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/gu)];
      for (let length = 2; length <= Math.min(4, words.length); length += 1) {
        for (let start = 0; start + length <= words.length; start += 1) {
          const phraseWords = words.slice(start, start + length);
          if (phraseWords.every((word) => ENGLISH_FUNCTION_WORDS.has(word[0].toLowerCase()))) continue;
          const first = phraseWords[0];
          const last = phraseWords[phraseWords.length - 1];
          const phrase = segment.slice(first.index!, last.index! + last[0].length);
          if (!/^\S+\s+\S/u.test(phrase)) continue;
          add(phrase, segmentSource, first.index!, last.index! + last[0].length);
        }
      }
    }
  }

  const repeated = [...counts.values()].map((entry) => {
    const lastEndBySource = new Map<number, number>();
    let count = 0;
    entry.occurrences.sort((a, b) => a.source - b.source || a.from - b.from);
    for (const occurrence of entry.occurrences) {
      if ((lastEndBySource.get(occurrence.source) ?? -1) > occurrence.from) continue;
      count += 1;
      lastEndBySource.set(occurrence.source, occurrence.to);
    }
    return { phrase: entry.phrase, count };
  }).filter((entry) => entry.count >= 3);
  const repeatedByKey = new Map(repeated.map((entry) => [entry.phrase.toLocaleLowerCase(), entry]));
  const covered = new Set<string>();
  for (const longer of repeated) {
    if (longer.phrase.includes(" ")) {
      const words = longer.phrase.split(/\s+/u);
      for (let length = 2; length < words.length; length += 1) {
        for (let start = 0; start + length <= words.length; start += 1) {
          const key = words.slice(start, start + length).join(" ").toLocaleLowerCase();
          const shorter = repeatedByKey.get(key);
          if (shorter && shorter.count <= longer.count) covered.add(key);
        }
      }
    } else {
      const chars = [...longer.phrase];
      for (let length = 4; length < chars.length; length += 1) {
        for (let start = 0; start + length <= chars.length; start += 1) {
          const key = chars.slice(start, start + length).join("").toLocaleLowerCase();
          const shorter = repeatedByKey.get(key);
          if (shorter && shorter.count <= longer.count) covered.add(key);
        }
      }
    }
  }
  const maximal = repeated.filter((entry) => !covered.has(entry.phrase.toLocaleLowerCase()));

  return maximal
    .sort((a, b) => (b.count * b.phrase.length) - (a.count * a.phrase.length) || b.count - a.count || b.phrase.length - a.phrase.length)
    .slice(0, Math.max(1, limit));
}
