// Plain English translation of a feedback report, done ON THE STAFF COMPUTER with the translator built into Chrome (the Translator API, Chrome 138+):
// free, no key, no AI service, and the text never leaves the computer. The result is saved in the english_context column by staff (source 'translation').
// The pure parts (protecting identifiers, line handling, formatting) are unit-tested with a fake translator (tests/unit/feedbackTranslate.test.ts);
// the real translator model could not be downloaded in the test browser, so its translation QUALITY has not been verified here.

export const hasThai = (s: string) => /[\u0E00-\u0E7F]/.test(s);

// Things a translator must not touch: code in backticks, URLs, routes (/orders), codes such as FG-000001 / FB-001013 / INV-202611-00268, and quoted
// messages (error texts are kept word for word, even a Thai one, so a developer can search for them).
const PROTECTED_SRC = '`[^`\\n]+`|https?:\\/\\/[^\\s)]+|"[^"\\n]+"|\u201C[^\u201D\\n]+\u201D|(?<![\\w/])\\/[A-Za-z][A-Za-z0-9_\\-./]*|\\b[A-Z][A-Z0-9]{1,5}-[A-Za-z0-9-]*\\d[A-Za-z0-9-]*';
const protectedRe = () => new RegExp(PROTECTED_SRC, 'g');

/** The pieces of a line that must come out of the translation exactly as they went in. */
export const protectedTokens = (line: string): string[] => [...line.matchAll(protectedRe())].map((m) => m[0]);

/** True when there is Thai text left once the protected pieces are set aside (a line that is only English, numbers or a quoted message needs no translation). */
const needsTranslation = (line: string) => hasThai(line.replace(protectedRe(), ' '));

type TranslateFn = (text: string) => Promise<string>;

/** Second try for a line the translator damaged: translate only the Thai runs between the protected pieces and leave everything else exactly as it was. */
async function translateAroundTokens(line: string, tr: TranslateFn): Promise<string> {
  const parts = line.split(new RegExp(`(${PROTECTED_SRC})`, 'g'));          // text, token, text, token, ...
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1 || !hasThai(p)) { out.push(p); continue; }
    const lead = /^\s*/.exec(p)![0], trail = /\s*$/.exec(p)![0];
    const t = (await tr(p.trim())).trim();
    out.push(lead + (t || p.trim()) + trail);
  }
  return out.join('');
}

async function translateLine(line: string, tr: TranslateFn): Promise<string> {
  if (!needsTranslation(line)) return line;
  const tokens = protectedTokens(line);
  const whole = (await tr(line)).trim();
  if (whole && tokens.every((t) => whole.includes(t))) return whole;            // every identifier survived
  return translateAroundTokens(line, tr);                                       // otherwise keep them safe by translating around them
}

/** Translates a multi-line text line by line (line breaks are kept; lines that need nothing come back untouched). */
export async function translateText(text: string, tr: TranslateFn): Promise<string> {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) out.push(await translateLine(line, tr));
  return out.join('\n');
}

/** The stored form: the title, then the description. Plain English, no sections. */
export const formatTranslation = (title: string, description: string) => `Title: ${title.trim()}\n\n${description.trim()}`;

export async function translateIssueText(issue: { title: string; description: string }, tr: TranslateFn): Promise<string> {
  const title = await translateText(issue.title, tr);
  const description = await translateText(issue.description, tr);
  return formatTranslation(title, description);
}

/** A link that opens the text in Google Translate in a new tab (only when a person clicks it): the fallback for browsers without the built-in translator. */
export const googleTranslateUrl = (text: string, max = 1500) => `https://translate.google.com/?sl=th&tl=en&op=translate&text=${encodeURIComponent(text.slice(0, max))}`;

// ------------------------------------------------------------------------------------------------ the browser's translator
export type TranslatorState = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface BrowserTranslator { translate(text: string): Promise<string>; destroy?(): void }
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<BrowserTranslator>;
}
const api = () => (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
const PAIR = { sourceLanguage: 'th', targetLanguage: 'en' };

/** What this browser can do: 'available' = the Thai language pack is already on the computer; 'downloadable' = one click will download it first. */
export async function translatorState(): Promise<TranslatorState> {
  const T = api();
  if (!T) return 'unsupported';
  try {
    const a = await T.availability(PAIR);
    return a === 'available' || a === 'downloadable' || a === 'downloading' ? a : 'unavailable';
  } catch { return 'unavailable'; }
}

/**
 * Translates a report with the browser's translator. The first time, Chrome downloads the Thai language pack, which it only allows right after a click
 * (call this from a click handler); `onProgress` receives the download progress 0..1.
 */
export async function translateInBrowser(issue: { title: string; description: string }, onProgress?: (fraction: number) => void): Promise<string> {
  const T = api();
  if (!T) throw new Error('This browser has no built-in translator (use Chrome 138 or newer on a computer)');
  const tr = await T.create({ ...PAIR, monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(Number((e as unknown as { loaded: number }).loaded) || 0)); } })
    .catch((e: Error) => { throw new Error(e?.name === 'NotAllowedError' ? 'Click the button again: the browser only downloads the language pack right after a click' : `The translator could not start: ${e?.message ?? e}`); });
  try { return await translateIssueText(issue, (s) => tr.translate(s)); } finally { tr.destroy?.(); }
}
