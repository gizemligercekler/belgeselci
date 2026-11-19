import { AudioChunk, DirectorOverlay } from '../types/studio';

export interface PreprocessorOptions {
  excludeChapterPrefix: boolean;
  maxChunkSize: number;
  model: string;
  voice: string;
  style: string;
}

const ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
const SCALES = ['', 'bin', 'milyon', 'milyar', 'trilyon'];

const MONTHS_TR: Record<number, string> = {
  1: 'Ocak',
  2: 'Şubat',
  3: 'Mart',
  4: 'Nisan',
  5: 'Mayıs',
  6: 'Haziran',
  7: 'Temmuz',
  8: 'Ağustos',
  9: 'Eylül',
  10: 'Ekim',
  11: 'Kasım',
  12: 'Aralık',
};

const WRITTEN_CHAPTER_NUMBERS: Record<string, number> = {
  bir: 1,
  birinci: 1,
  iki: 2,
  ikinci: 2,
  üç: 3,
  üçüncü: 3,
  dört: 4,
  dördüncü: 4,
  beş: 5,
  beşinci: 5,
  altı: 6,
  altıncı: 6,
  yedi: 7,
  yedinci: 7,
  sekiz: 8,
  sekizinci: 8,
  dokuz: 9,
  dokuzuncu: 9,
  on: 10,
  onuncu: 10,
  'on bir': 11,
  onbir: 11,
  'on birinci': 11,
  'on iki': 12,
  oniki: 12,
  'on ikinci': 12,
};

const ROMAN_MAP: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
  XXI: 21,
};

const TURKISH_ABBREVIATIONS = new Set([
  'dr.',
  'prof.',
  'doç.',
  'yrd.',
  'm.ö.',
  'm.s.',
  'hz.',
  'vb.',
  'vs.',
  't.c.',
  'bkz.',
  's.a.v.',
  'r.a.',
  'a.s.',
  'yy.',
  'krş.',
  'st.',
  'no.',
  'ö.',
  'd.',
  'c.',
  's.',
]);

const ORDINAL_CONTEXT_WORDS =
  /^(yüzyıl|yy|asır|ayet|bölüm|sıra|kez|defa|kere|kişi|kat|sınıf|madde|savaş|dönem|cilt|kitap|sayfa|nüsha|yıl|gün|ay|hafta|derece|adım|aşama|nesil|kuşak|halife|papa|kral|sultan|imparator|meclis|konsil|dünya|mevsim|parça|sahne)/i;

export function turkishToLower(str: string): string {
  return str.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

export function turkishCapitalizeFirst(str: string): string {
  if (!str) return str;
  const first = str.charAt(0);
  const rest = str.slice(1);
  if (first === 'i') return 'İ' + rest;
  if (first === 'ı') return 'I' + rest;
  return first.toLocaleUpperCase('tr-TR') + rest;
}

export function turkishTitleCase(str: string): string {
  return str
    .split(/\s+/)
    .map((w) => turkishCapitalizeFirst(w))
    .join(' ');
}

export function integerToTurkish(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `eksi ${integerToTurkish(Math.abs(n))}`;
  if (n === 0) return 'sıfır';

  const parts: string[] = [];
  let remaining = Math.floor(n);
  let scaleIndex = 0;

  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) {
      const groupWords = threeDigitsToTurkish(group);
      const scale = SCALES[scaleIndex] || '';
      if (scaleIndex === 1 && group === 1) {
        parts.unshift('bin');
      } else if (scale) {
        parts.unshift(`${groupWords} ${scale}`);
      } else {
        parts.unshift(groupWords);
      }
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex += 1;
  }

  return parts.join(' ').trim();
}

function threeDigitsToTurkish(n: number): string {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  const out: string[] = [];

  if (h === 1) out.push('yüz');
  else if (h > 1) out.push(`${ONES[h]} yüz`);

  if (t > 0) out.push(TENS[t]);
  if (o > 0) out.push(ONES[o]);

  return out.join(' ');
}

export function integerToTurkishOrdinal(n: number): string {
  const base = integerToTurkish(n);
  if (!base) return '';

  // Handle softening and vowel harmony for last word
  const words = base.split(' ');
  const last = words[words.length - 1];

  const ordinalMap: Record<string, string> = {
    sıfır: 'sıfırıncı',
    bir: 'birinci',
    iki: 'ikinci',
    üç: 'üçüncü',
    dört: 'dördüncü',
    beş: 'beşinci',
    altı: 'altıncı',
    yedi: 'yedinci',
    sekiz: 'sekizinci',
    dokuz: 'dokuzuncu',
    on: 'onuncu',
    yirmi: 'yirminci',
    otuz: 'otuzuncu',
    kırk: 'kırkıncı',
    elli: 'ellinci',
    altmış: 'altmışıncı',
    yetmiş: 'yetmişinci',
    seksen: 'sekseninci',
    doksan: 'doksanıncı',
    yüz: 'yüzüncü',
    bin: 'bininci',
    milyon: 'milyonuncu',
    milyar: 'milyarıncı',
  };

  words[words.length - 1] = ordinalMap[last] || `${last}inci`;
  return words.join(' ');
}

function attachTurkishSuffixToNumberWord(word: string, rawSuffix: string): string {
  const suffix = turkishToLower(rawSuffix);
  if (!suffix) return word;

  // Check if suffix is an ordinal suffix like 'nci, 'ıncı, 'inci, 'uncu, 'üncü
  if (/^(nc[ıiuü]|[ıiuü]nc[ıiuü])$/.test(suffix)) {
    const tokens = word.split(' ');
    const last = tokens[tokens.length - 1];
    // Re-use ordinal table if exact match
    if (last === 'dört') {
      tokens[tokens.length - 1] = 'dörd' + (suffix.startsWith('n') ? 'üncü' : suffix);
      return tokens.join(' ');
    }
  }

  // Softening: dört -> dörd when suffix starts with a vowel
  const startsWithVowel = /^[aeıioöuü]/.test(suffix);
  let base = word;
  if (startsWithVowel && /(^|\s)dört$/.test(base)) {
    base = base.replace(/dört$/, 'dörd');
  }

  return `${base}${suffix}`;
}

function ensureSentencePunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/[.!?…]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function isTechnicalParenthetical(inner: string): boolean {
  const t = inner.trim();
  if (!t) return true;
  if (/^\*.*\*$/.test(t)) return true;
  // Manuscript / scholarly / biblical / English / death-year patterns
  if (/^(1Q|2Q|4Q|11Q|DAM\b|P\d+\b|YHWH\b|Codex\b|Tanakh\b|Old Testament|New Testament|LXX\b|MT\b|Dead Sea)/i.test(t)) {
    return true;
  }
  if (/^(ö\.|d\.|bkz\.|krş\.|cf\.|ca\.|M\.Ö\.|M\.S\.)/i.test(t)) return true;
  if (/\b(Luka|Matta|Markos|Yuhanna|Tekvin|Çıkış|Mezmurlar|İşaya|Yaratılış)\s+\d+:\d+/i.test(t)) {
    return true;
  }
  if (/\b(Codex|Papyrus|Ms\.|folio|fol\.)\b/i.test(t)) return true;
  if (/^[A-Za-z0-9\s\-.:;/,]+$/.test(t) && (/\d+:\d+/.test(t) || /\b[0-9]+[A-Z][a-zA-Z0-9-]*\b/.test(t))) {
    return true;
  }
  return false;
}

function convertNumbersAndSymbols(text: string): string {
  let out = text;

  // 1. Special word replacements (Rule 5)
  out = out.replace(/Hype['’]?layarak/gi, 'hayplayarak');
  out = out.replace(/Süper\s+TEŞEKKÜR/g, 'Süper Teşekkür');
  out = out.replace(/\bKATIL\b/g, 'Katıl');
  out = out.replace(/\bHz\.\s*/g, 'Hazreti ');
  out = out.replace(/Karbon[\s-]+14\b/gi, 'Karbon on dört');

  // 2. Parentheticals (Rule 6)
  out = out.replace(/\(([^()]{1,180})\)/g, (_match, inner: string) => {
    if (isTechnicalParenthetical(inner)) {
      return '';
    }
    const cleanInner = inner.trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    if (!cleanInner) return '';
    return `, ${cleanInner},`;
  });

  // Clean spacing around commas created by parenthetical conversion
  out = out.replace(/\s+,/g, ',');
  out = out.replace(/,\s*,+/g, ',');
  out = out.replace(/,\s*([.!?…;:])/g, '$1');

  // 3. Roman numeral titles (Rule 7a)
  out = out.replace(
    /\b(Papa|Kral|İmparator|Sultan|Çar|Kraliçe|Prens|Dük)\s+(XXI|XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)\./gi,
    (_m, title: string, roman: string) => {
      const val = ROMAN_MAP[roman.toUpperCase()];
      if (!val) return _m;
      return `${title} ${turkishTitleCase(integerToTurkishOrdinal(val))}`;
    }
  );
  // Standalone Roman numeral ordinals before nouns (e.g. "II. Dünya Savaşı", "XVI. yüzyıl")
  out = out.replace(
    /\b(XXI|XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II)\.\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)/g,
    (_m, roman: string, nextWord: string) => {
      const val = ROMAN_MAP[roman.toUpperCase()];
      if (!val) return _m;
      const ord = integerToTurkishOrdinal(val);
      const formatted = /^[A-ZÇĞİÖŞÜ]/.test(nextWord) ? turkishTitleCase(ord) : ord;
      return `${formatted} ${nextWord}`;
    }
  );

  // 4. Full dates DD.MM.YYYY (Rule 7b)
  out = out.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (_m, dStr: string, mStr: string, yStr: string) => {
    const d = parseInt(dStr, 10);
    const m = parseInt(mStr, 10);
    const y = parseInt(yStr, 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${integerToTurkish(d)} ${MONTHS_TR[m]} ${integerToTurkish(y)}`;
    }
    return _m;
  });

  // 5. Verse ranges e.g. 22:43-44 and single verse 22:43 (Rule 7c)
  out = out.replace(/\b(\d{1,3}):(\d{1,3})\s*[-–—]\s*(\d{1,3})\b/g, (_m, a: string, b: string, c: string) => {
    return `${integerToTurkish(parseInt(a, 10))}, ${integerToTurkish(parseInt(b, 10))} ila ${integerToTurkish(parseInt(c, 10))}`;
  });
  out = out.replace(/\b(\d{1,3}):(\d{1,3})\b/g, (_m, a: string, b: string) => {
    return `${integerToTurkish(parseInt(a, 10))}, ${integerToTurkish(parseInt(b, 10))}`;
  });

  // 6. Ordinal ranges e.g. 24-26. ayetlerinde (Rule 7d)
  out = out.replace(/\b(\d{1,4})\s*[-–—]\s*(\d{1,4})\.\s+([a-zçğıöşü]+)/gi, (_m, a: string, b: string, nextWord: string) => {
    return `${integerToTurkishOrdinal(parseInt(a, 10))} ila ${integerToTurkishOrdinal(parseInt(b, 10))} ${nextWord}`;
  });

  // 7. Number / year ranges e.g. 68-70, 1914-1918 (Rule 7e)
  out = out.replace(/\b(\d{1,4})\s*[-–—]\s*(\d{1,4})\b/g, (_m, a: string, b: string) => {
    return `${integerToTurkish(parseInt(a, 10))} ila ${integerToTurkish(parseInt(b, 10))}`;
  });

  // 8. Percentage e.g. %95'ten or %95
  out = out.replace(/%(\d+(?:\.\d{3})*|\d+)(?:['’]([a-zçğıöşü]+))?/gi, (_m, numRaw: string, suf?: string) => {
    const cleanedNum = parseInt(numRaw.replace(/\./g, ''), 10);
    const spoken = `yüzde ${integerToTurkish(cleanedNum)}`;
    return suf ? attachTurkishSuffixToNumberWord(spoken, suf) : spoken;
  });

  // 9. Suffixed numbers with optional thousands separator e.g. 1930'larda, 5.800'den, 4'ü (Rule 7g)
  out = out.replace(/\b(\d{1,3}(?:\.\d{3})+|\d+)['’]([a-zçğıöşü]+)\b/gi, (_m, numRaw: string, suf: string) => {
    const val = parseInt(numRaw.replace(/\./g, ''), 10);
    const spoken = integerToTurkish(val);
    return attachTurkishSuffixToNumberWord(spoken, suf);
  });

  // 10. Thousands-separated integers e.g. 138.000, 1.250.000 (Rule 7h)
  out = out.replace(/\b(\d{1,3}(?:\.\d{3})+)\b/g, (_m, numRaw: string) => {
    const val = parseInt(numRaw.replace(/\./g, ''), 10);
    return integerToTurkish(val);
  });

  // 11. Decimals e.g. 3.5 -> üç nokta beş (Rule 7f)
  out = out.replace(/\b(\d+)\.(\d{1,2})\b/g, (_m, whole: string, frac: string) => {
    const fracSpoken = frac.startsWith('0')
      ? frac
          .split('')
          .map((d) => integerToTurkish(parseInt(d, 10)))
          .join(' ')
      : integerToTurkish(parseInt(frac, 10));
    return `${integerToTurkish(parseInt(whole, 10))} nokta ${fracSpoken}`;
  });

  // 12. Turkish ordinals (safe around sentence endings!) (Rule 7i)
  out = out.replace(/\b(\d{1,3})\.(\s+)([A-Za-zÇĞİÖŞÜçğıöşü]+)/g, (_m, numStr: string, ws: string, nextWord: string) => {
    const val = parseInt(numStr, 10);
    const isLowerNext = /^[a-zçğıöşü]/.test(nextWord);
    const isKnownOrdinalNoun = ORDINAL_CONTEXT_WORDS.test(nextWord);
    if ((isLowerNext || isKnownOrdinalNoun) && val >= 1 && val <= 100) {
      return `${integerToTurkishOrdinal(val)}${ws}${nextWord}`;
    }
    return `${integerToTurkish(val)}.${ws}${nextWord}`;
  });

  // 13. All remaining standalone integers (Rule 7j)
  out = out.replace(/\b(\d+)\b/g, (_m, numStr: string) => {
    if (numStr.length > 12) return numStr;
    return integerToTurkish(parseInt(numStr, 10));
  });

  // 14. Capitalize sentence starts properly with Turkish rules (i -> İ, ı -> I)
  out = out.replace(/(^|[.!?…]\s+|<\w+\s+pause>\s+)([a-zçğıöşü])/g, (_m, prefix: string, ch: string) => {
    return `${prefix}${turkishCapitalizeFirst(ch)}`;
  });

  // Collapse extra spaces while keeping newlines
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}

const CHAPTER_HEADING_REGEX =
  /^\s*#{0,4}\s*B[ÖO]L[ÜU]M\s+(\d+|birinci|ikinci|üçüncü|dördüncü|beşinci|altıncı|yedinci|sekizinci|dokuzuncu|onuncu|on\s*birinci|on\s*ikinci|on\s*bir|on\s*iki|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on)\s*[:\-—–]\s*(.+)$/iu;

interface ParsedSection {
  isChapterStart: boolean;
  chapterTitle: string;
  paragraphs: string[];
  overlays: DirectorOverlay[];
}

function extractDirectorTagsFromLine(
  line: string,
  sectionIndex: number,
  tagCounter: { count: number }
): { cleanedLine: string; overlays: DirectorOverlay[]; bolumTitle?: string } {
  const overlays: DirectorOverlay[] = [];
  let bolumTitle: string | undefined;

  const cleanedLine = line.replace(
    /\[\[\s*(BOLUM|BÖLÜM|AYET|ETIKET|ETİKET)\s*:\s*([^\]]+?)\s*\]\]/gi,
    (rawTag, rawKind: string, payload: string) => {
      const upperKind = rawKind.toUpperCase();
      tagCounter.count += 1;
      const id = `ov_${sectionIndex}_${tagCounter.count}`;

      if (upperKind === 'AYET') {
        const pipeIdx = payload.indexOf('|');
        const label = pipeIdx >= 0 ? payload.slice(0, pipeIdx).trim() : 'Ayet';
        const text = pipeIdx >= 0 ? payload.slice(pipeIdx + 1).trim() : payload.trim();
        overlays.push({
          id,
          kind: 'ayet',
          label,
          text,
          rawTag,
          positionRatio: 0.5,
        });
      } else if (upperKind === 'ETIKET' || upperKind === 'ETİKET') {
        overlays.push({
          id,
          kind: 'etiket',
          label: 'Referans',
          text: payload.trim(),
          rawTag,
          positionRatio: 0.5,
        });
      } else {
        const titleText = payload.trim();
        bolumTitle = titleText;
        overlays.push({
          id,
          kind: 'bolum',
          label: 'Bölüm',
          text: titleText,
          rawTag,
          positionRatio: 0.05,
        });
      }
      return '';
    }
  );

  return { cleanedLine, overlays, bolumTitle };
}

function splitIntoTurkishSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let current = '';
  const tokens = paragraph.split(/(\s+)/);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    current += tok;

    // Only check non-whitespace tokens for sentence endings
    if (!/\s+/.test(tok)) {
      const trimmedLower = turkishToLower(tok.replace(/^["'“‘(]+|["'”’)]+$/g, ''));
      const endsWithPunct = /[.!?…]["'”’)]*$/.test(tok);

      if (endsWithPunct && !TURKISH_ABBREVIATIONS.has(trimmedLower)) {
        // Also avoid splitting on single-letter initials like "A." or "M."
        const isSingleInitial = /^[a-zçğıöşü]\.$/i.test(trimmedLower);
        if (!isSingleInitial) {
          const nextNonSpace = tokens[i + 2] || '';
          const nextStartsSentence =
            !nextNonSpace ||
            /^[A-ZÇĞİÖŞÜ"“‘<]/.test(nextNonSpace) ||
            /^<short pause>|^<long pause>/i.test(nextNonSpace);
          if (nextStartsSentence) {
            sentences.push(current.trim());
            current = '';
          }
        }
      }
    }
  }

  if (current.trim()) {
    sentences.push(current.trim());
  }

  return sentences.filter(Boolean);
}

export async function computeChunkCacheHash(
  model: string,
  voice: string,
  style: string,
  cleanedText: string
): Promise<string> {
  const payload = `${model.trim()}|${voice.trim()}|${style.trim()}|${cleanedText.trim()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const bytes = Array.from(new Uint8Array(hashBuffer));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback deterministic FNV-1a 64-like hex if subtle crypto is unavailable
  let h1 = 0xdeadbeef ^ data.length;
  let h2 = 0x41c6ce57 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    h1 = Math.imul(h1 ^ data[i], 2654435761);
    h2 = Math.imul(h2 ^ data[i], 1597334677);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function cleanSingleTextBlock(raw: string, excludeChapterPrefix: boolean): string {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const processedLines: string[] = [];
  const tagCounter = { count: 0 };

  for (const originalLine of lines) {
    const trimmed = originalLine.trim();
    if (!trimmed) {
      processedLines.push('');
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      continue;
    }

    const { cleanedLine } = extractDirectorTagsFromLine(originalLine, 0, tagCounter);
    const lineTrimmed = cleanedLine.trim();
    if (!lineTrimmed) continue;

    const chapterMatch = lineTrimmed.match(CHAPTER_HEADING_REGEX);
    if (chapterMatch) {
      const rawNum = turkishToLower(chapterMatch[1].replace(/\s+/g, ' ').trim());
      const title = chapterMatch[2].replace(/\*\*|\*|__|`/g, '').trim();
      if (excludeChapterPrefix) {
        processedLines.push(`${ensureSentencePunctuation(convertNumbersAndSymbols(title))} <short pause>`);
      } else {
        const numVal = /^\d+$/.test(rawNum)
          ? parseInt(rawNum, 10)
          : WRITTEN_CHAPTER_NUMBERS[rawNum] || 1;
        const ordTitle = turkishTitleCase(integerToTurkishOrdinal(numVal));
        processedLines.push(
          `${ordTitle} Bölüm: ${ensureSentencePunctuation(convertNumbersAndSymbols(title))} <short pause>`
        );
      }
      continue;
    }

    let cleaned = lineTrimmed
      .replace(/^>\s*/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');

    if (/^##\s+/.test(cleaned)) {
      const heading = cleaned.replace(/^##\s+/, '').trim();
      processedLines.push(`${ensureSentencePunctuation(convertNumbersAndSymbols(heading))} <long pause>`);
    } else if (/^#\s+/.test(cleaned)) {
      const heading = cleaned.replace(/^#\s+/, '').trim();
      processedLines.push(`${ensureSentencePunctuation(convertNumbersAndSymbols(heading))} <long pause>`);
    } else if (/^#{3,6}\s+/.test(cleaned)) {
      const heading = cleaned.replace(/^#{3,6}\s+/, '').trim();
      processedLines.push(`${ensureSentencePunctuation(convertNumbersAndSymbols(heading))} <short pause>`);
    } else {
      processedLines.push(convertNumbersAndSymbols(cleaned));
    }
  }

  return processedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function preprocessTurkishScript(
  rawScript: string,
  options: PreprocessorOptions,
  existingChunks: AudioChunk[] = []
): Promise<AudioChunk[]> {
  // Rule 1: Strip BOM, normalize CRLF, remove horizontal rules
  const normalized = rawScript.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection = {
    isChapterStart: false,
    chapterTitle: 'Giriş',
    paragraphs: [],
    overlays: [],
  };

  let rawBufferForSection: string[] = [];
  const sectionRawTexts: string[] = [];
  const tagCounter = { count: 0 };

  const pushCurrentSection = () => {
    if (currentSection.paragraphs.length > 0 || currentSection.overlays.length > 0) {
      sections.push(currentSection);
      sectionRawTexts.push(rawBufferForSection.join('\n').trim());
    }
    rawBufferForSection = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip horizontal rules
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      continue;
    }

    if (!trimmed) {
      rawBufferForSection.push('');
      continue;
    }

    // Rule 2: Extract director overlay tags ([[AYET]], [[ETIKET]], [[BOLUM]])
    const { cleanedLine, overlays, bolumTitle } = extractDirectorTagsFromLine(
      line,
      sections.length,
      tagCounter
    );

    if (bolumTitle && currentSection.paragraphs.length === 0) {
      currentSection.chapterTitle = bolumTitle;
      currentSection.isChapterStart = true;
    }
    if (overlays.length > 0) {
      currentSection.overlays.push(...overlays);
    }

    const afterTags = cleanedLine.trim();
    if (!afterTags) {
      rawBufferForSection.push(line);
      continue;
    }

    // Rule 3: Chapter heading rule (numeric AND written Turkish numbers)
    const chapterMatch = afterTags.match(CHAPTER_HEADING_REGEX);
    if (chapterMatch) {
      pushCurrentSection();

      const rawNum = turkishToLower(chapterMatch[1].replace(/\s+/g, ' ').trim());
      const cleanHeadingTitle = chapterMatch[2].replace(/\*\*|\*|__|`/g, '').trim();

      let spokenHeading: string;
      if (options.excludeChapterPrefix) {
        // Strictly omit "BÖLÜM 2:" / "BÖLÜM iki:" prefix — read ONLY title
        spokenHeading = `${ensureSentencePunctuation(convertNumbersAndSymbols(cleanHeadingTitle))} <short pause>`;
      } else {
        const numVal = /^\d+$/.test(rawNum)
          ? parseInt(rawNum, 10)
          : WRITTEN_CHAPTER_NUMBERS[rawNum] || 1;
        const ordTitle = turkishTitleCase(integerToTurkishOrdinal(numVal));
        spokenHeading = `${ordTitle} Bölüm: ${ensureSentencePunctuation(convertNumbersAndSymbols(cleanHeadingTitle))} <short pause>`;
      }

      currentSection = {
        isChapterStart: true,
        chapterTitle: cleanHeadingTitle,
        paragraphs: [spokenHeading],
        overlays: [
          {
            id: `ov_ch_${sections.length + 1}`,
            kind: 'bolum',
            label: 'Bölüm',
            text: cleanHeadingTitle,
            rawTag: trimmed,
            positionRatio: 0.04,
          },
        ],
      };
      rawBufferForSection = [line];
      continue;
    }

    // Rule 4: Markdown heading cleanup + bold/italic removal
    let cleanBody = afterTags
      .replace(/^>\s*/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');

    let spokenParagraph = '';
    if (/^##\s+/.test(cleanBody)) {
      const h = cleanBody.replace(/^##\s+/, '').trim();
      spokenParagraph = `${ensureSentencePunctuation(convertNumbersAndSymbols(h))} <long pause>`;
    } else if (/^#\s+/.test(cleanBody)) {
      const h = cleanBody.replace(/^#\s+/, '').trim();
      spokenParagraph = `${ensureSentencePunctuation(convertNumbersAndSymbols(h))} <long pause>`;
    } else if (/^#{3,6}\s+/.test(cleanBody)) {
      const h = cleanBody.replace(/^#{3,6}\s+/, '').trim();
      spokenParagraph = `${ensureSentencePunctuation(convertNumbersAndSymbols(h))} <short pause>`;
    } else {
      spokenParagraph = convertNumbersAndSymbols(cleanBody);
    }

    if (spokenParagraph.trim()) {
      currentSection.paragraphs.push(spokenParagraph.trim());
      rawBufferForSection.push(line);
    }
  }

  pushCurrentSection();

  // Rule 8: Smart Turkish Text Splitter (pack paragraphs/sentences up to maxChunkSize per chapter section)
  const maxLen = Math.max(400, options.maxChunkSize || 2500);
  const existingByHash = new Map<string, AudioChunk>();
  for (const c of existingChunks) {
    if (c.cacheHash && c.audioBlobId) {
      existingByHash.set(c.cacheHash, c);
    }
  }

  const finalChunks: AudioChunk[] = [];
  let globalIndex = 0;

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    const secRaw = sectionRawTexts[sIdx] || '';
    const packedTexts: string[] = [];
    let buffer = '';

    for (const para of sec.paragraphs) {
      if (!para.trim()) continue;

      if (buffer.length === 0) {
        if (para.length <= maxLen) {
          buffer = para;
        } else {
          // Split long paragraph by Turkish sentences
          const sentences = splitIntoTurkishSentences(para);
          for (const sent of sentences) {
            if (buffer.length === 0) {
              buffer = sent;
            } else if (buffer.length + 1 + sent.length <= maxLen) {
              buffer = `${buffer} ${sent}`;
            } else {
              packedTexts.push(buffer.trim());
              buffer = sent;
            }
          }
        }
      } else if (buffer.length + 2 + para.length <= maxLen) {
        buffer = `${buffer}\n\n${para}`;
      } else {
        packedTexts.push(buffer.trim());
        if (para.length <= maxLen) {
          buffer = para;
        } else {
          buffer = '';
          const sentences = splitIntoTurkishSentences(para);
          for (const sent of sentences) {
            if (buffer.length === 0) {
              buffer = sent;
            } else if (buffer.length + 1 + sent.length <= maxLen) {
              buffer = `${buffer} ${sent}`;
            } else {
              packedTexts.push(buffer.trim());
              buffer = sent;
            }
          }
        }
      }
    }

    if (buffer.trim()) {
      packedTexts.push(buffer.trim());
    }

    for (let pIdx = 0; pIdx < packedTexts.length; pIdx++) {
      globalIndex += 1;
      const cleanedText = packedTexts[pIdx];
      const cacheHash = await computeChunkCacheHash(
        options.model,
        options.voice,
        options.style,
        cleanedText
      );

      const cached = existingByHash.get(cacheHash);
      // Distribute section overlays to the first chunk (or proportionally if multiple)
      const chunkOverlays =
        pIdx === 0
          ? sec.overlays.map((ov, idx) => ({
              ...ov,
              positionRatio:
                ov.kind === 'bolum'
                  ? 0.04
                  : Math.min(0.85, (idx + 1) / (sec.overlays.length + 1)),
            }))
          : [];

      finalChunks.push({
        id: cached?.id || `chunk_${globalIndex}_${cacheHash.slice(0, 8)}`,
        index: globalIndex,
        isChapterStart: pIdx === 0 && sec.isChapterStart,
        chapterTitle: sec.chapterTitle,
        rawText: pIdx === 0 ? secRaw : cleanedText,
        cleanedText,
        overlays: chunkOverlays,
        cacheHash,
        generatedHash: cached?.generatedHash,
        audioBlobId: cached?.audioBlobId,
        durationSec: cached?.durationSec,
        status: cached?.audioBlobId ? 'cached' : 'idle',
      });
    }
  }

  return finalChunks;
}
