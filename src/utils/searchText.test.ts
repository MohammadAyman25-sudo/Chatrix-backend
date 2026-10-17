import { describe, expect, it } from 'vitest';
import { normalizeForSearch } from './searchText.js';

describe('normalizeForSearch', () => {
  it('folds case', () => {
    expect(normalizeForSearch('Hello WORLD')).toBe('hello world');
    expect(normalizeForSearch('İstanbul')).toBe('istanbul');
  });

  it('strips accents and other combining marks', () => {
    expect(normalizeForSearch('Café Ñoño Ångström')).toBe('cafe nono angstrom');
    // Precomposed and decomposed spellings normalize identically.
    expect(normalizeForSearch('caf\u00e9')).toBe(normalizeForSearch('cafe\u0301'));
  });

  it('folds compatibility forms, ligatures and full-width characters', () => {
    expect(normalizeForSearch('Straße')).toBe('strasse');
    expect(normalizeForSearch('STRASSE')).toBe(normalizeForSearch('straße'));
    expect(normalizeForSearch('ﬁle')).toBe('file');
    expect(normalizeForSearch('Ｈｅｌｌｏ')).toBe('hello');
  });

  it('folds the Arabic alef family', () => {
    for (const alef of ['أ', 'إ', 'آ', 'ٱ', 'ا']) {
      expect(normalizeForSearch(alef)).toBe('ا');
    }
    expect(normalizeForSearch('أحمد')).toBe('احمد');
    expect(normalizeForSearch('إسلام')).toBe('اسلام');
    expect(normalizeForSearch('آمن')).toBe('امن');
  });

  it('strips Arabic tashkeel and tatweel', () => {
    expect(normalizeForSearch('مَرْحَبًا')).toBe('مرحبا');
    expect(normalizeForSearch('مـرحبا')).toBe('مرحبا');
    expect(normalizeForSearch('مرحبا')).toBe(normalizeForSearch('مَرْحَبًا'));
  });

  it('folds taa marbuta, alef maksura and hamza carriers', () => {
    expect(normalizeForSearch('مدرسة')).toBe('مدرسه');
    expect(normalizeForSearch('مصطفى')).toBe('مصطفي');
    expect(normalizeForSearch('سؤل')).toBe('سول');
    expect(normalizeForSearch('سئل')).toBe('سيل');
    expect(normalizeForSearch('سأل')).toBe('سال');
  });

  it('folds Persian/Urdu letters onto their Arabic twins', () => {
    expect(normalizeForSearch('کتاب')).toBe('كتاب');
    expect(normalizeForSearch('یک')).toBe('يك');
    // Zero-width non-joiner does not break the word.
    expect(normalizeForSearch('می\u200cرود')).toBe('ميرود');
    expect(normalizeForSearch('میرود')).toBe(normalizeForSearch('می\u200cرود'));
  });

  it('strips Hebrew niqqud', () => {
    expect(normalizeForSearch('שָׁלוֹם')).toBe('שלום');
  });

  it('folds digits across scripts', () => {
    expect(normalizeForSearch('٢٠٢٤')).toBe('2024');
    expect(normalizeForSearch('۲۰۲۴')).toBe('2024');
  });

  it('folds Greek final sigma and Cyrillic yo', () => {
    expect(normalizeForSearch('ΣΟΦΟΣ')).toBe(normalizeForSearch('σοφος'));
    expect(normalizeForSearch('ёлка')).toBe('елка');
  });

  it('treats punctuation, symbols and whitespace as separators', () => {
    expect(normalizeForSearch('hello,   world!')).toBe('hello world');
    expect(normalizeForSearch('  hi \n there  ')).toBe('hi there');
    expect(normalizeForSearch('مرحبا، العالم')).toBe('مرحبا العالم');
    expect(normalizeForSearch('C++')).toBe('c');
    expect(normalizeForSearch('hi 😊')).toBe('hi');
  });

  it('returns an empty string when nothing searchable remains', () => {
    expect(normalizeForSearch('!!!')).toBe('');
    expect(normalizeForSearch('😊')).toBe('');
    expect(normalizeForSearch('   ')).toBe('');
  });

  it('is idempotent', () => {
    for (const sample of ['Café', 'مَرْحَبًا', 'Straße', '٢٠٢٤', 'mi\u200crod']) {
      const once = normalizeForSearch(sample);
      expect(normalizeForSearch(once)).toBe(once);
    }
  });

  it('keeps raw substrings as substrings after normalization', () => {
    const samples: Array<[stored: string, query: string]> = [
      ['Hello World', 'wor'],
      ['مرحبا بالعالم', 'بالعالم'],
      ['آمنة بالأمل', 'امل'],
      ['Café au lait', 'lait'],
      ['straße', 'strasse'],
      ['สวัสดีครับ', 'สวัสดี'],
      ['שָׁלוֹם עוֹלָם', 'עולם'],
    ];
    for (const [stored, query] of samples) {
      expect(normalizeForSearch(stored).includes(normalizeForSearch(query))).toBe(true);
    }
  });
});
