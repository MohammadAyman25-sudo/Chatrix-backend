/**
 * Language-agnostic text normalization used by message search.
 *
 * Every message keeps a normalized copy of its content (`Message.contentNormalized`,
 * maintained by a `pre('save')` hook) and the user's query is normalized the same
 * way before matching, so the comparison happens in a canonical space where
 * spelling differences that carry no search value cancel out. The function is
 * deterministic and per-string, which guarantees that a query found in the raw
 * text is still found in its normalized form.
 *
 * What it folds away:
 * - **Case**: `HELLO` and `hello` are the same query.
 * - **Compatibility forms** (NFKD): full-width `Ｈｅｌｌｏ`, Latin ligatures
 *   (`ﬁ`), and Arabic presentation forms reduce to their base characters.
 * - **Combining marks** (`\p{Mn}`): accents (`café` = `cafe`, `Ångström` =
 *   `angstrom`), Arabic tashkeel (`مَرْحَبًا` = `مرحبا`) and Hebrew niqqud.
 * - **Letter variants**, per script: the Arabic alef family (`أ إ آ ٱ` -> `ا`),
 *   taa marbuta (`ة` -> `ه`), alef maksura (`ى` -> `ي`), hamza carriers
 *   (`ؤ` -> `و`, `ئ` -> `ي`, bare `ء` dropped), the Persian/Urdu twins on the
 *   Arabic letters (`ک` -> `ك`, `ی` -> `ي`), German `ß` -> `ss`, `æ` -> `ae`,
 *   `ø` -> `o`, `đ`/`ð` -> `d`, `þ` -> `th`, `ł` -> `l`, `ı` -> `i`, Greek final
 *   `ς` -> `σ`, Cyrillic `ё` -> `е`, and Arabic-Indic/Persian digits (`٢٠٢٤` ->
 *   `2024`).
 * - **Invisible formatting**: tatweel (`ـ`), the zero-width joiners Persian and
 *   Urdu use (`می‌رود` = `میرود`) and bidi marks.
 * - **Punctuation, symbols and emoji** become a single space, and runs of
 *   whitespace collapse, so `hello,   world!` and `hello world` are identical.
 *
 * Over-folding (two different texts normalizing to the same string) is
 * acceptable: it only widens recall. Under-folding would silently drop
 * legitimate matches, which is why the tables below are conservative about
 * changing a letter's identity but generous about anything that is decoration.
 */

/** Maps Arabic-Indic digits (٠-٩ and ۰-۹) onto ASCII `0`-`9`. */
function toAsciiDigit(digit: string): string {
  const code = digit.charCodeAt(0);
  const base = code < 0x06f0 ? 0x0660 : 0x06f0;
  return String.fromCharCode(0x30 + (code - base));
}

/**
 * Variant folding applied after NFKD, lowercasing and mark removal. Both the
 * stored content and the query run through the same table, so a fold can never
 * lose a match — it can only make two spellings of a word compare equal.
 */
const VARIANT_FOLDING = [
  // Arabic alef family -> bare alef.
  ['أ', 'ا'],
  ['إ', 'ا'],
  ['آ', 'ا'],
  ['ٱ', 'ا'],
  ['ٲ', 'ا'],
  ['ٳ', 'ا'],
  // Taa marbuta / alef maksura (مدرسة -> مدرسه, مصطفى -> مصطفي).
  ['ة', 'ه'],
  ['ى', 'ي'],
  // Hamza carriers keep their carrier; the hamza itself is dropped.
  ['ؤ', 'و'],
  ['ئ', 'ي'],
  ['ء', ''],
  // Persian/Urdu letters that have an Arabic twin (کتاب == كتاب).
  ['ک', 'ك'],
  ['ی', 'ي'],
  // Germanic / Greek / Cyrillic / Latin-extended variants.
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
  ['ı', 'i'],
  ['ς', 'σ'],
  ['ё', 'е'],
] as const;

export function normalizeForSearch(text: string): string {
  let normalized = text
    // Compatibility decomposition: full-width forms, ligatures and Arabic
    // presentation forms collapse to their base characters.
    .normalize('NFKD')
    // Locale-independent case folding. Runs before mark removal so `İ`
    // (I + combining dot) reduces to a plain `i`.
    .toLowerCase()
    // Combining marks (accents, tashkeel, niqqud, …) are removed rather than
    // turned into spaces, so `café` and `cafe` stay adjacent.
    .replace(/\p{Mn}/gu, '')
    // Tatweel plus invisible formatting: ZWJ/ZWNJ, bidi marks, word joiner.
    .replace(/[\u0640\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    // Arabic-Indic and Extended Arabic-Indic (Persian) digits.
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, toAsciiDigit);

  for (const [from, to] of VARIANT_FOLDING) {
    if (normalized.includes(from)) {
      normalized = normalized.split(from).join(to);
    }
  }

  // Anything that is neither a letter nor a number (punctuation, symbols,
  // emoji, leftover marks) becomes one space; whitespace runs collapse too.
  return normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
