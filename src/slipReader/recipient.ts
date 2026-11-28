// The receiver of a transfer slip: where it is on the slip, and whether it is one of the shop's names.
// This is the TypeScript twin of section 1 and 3 of supabase/migrations/20261128150000_slip_recipient_check.sql. The DATABASE decides for staff; this copy only lets the customer's
// phone warn them before ordering (it stores, sends and decides nothing). tests/unit/slipRecipient.test.ts runs the SAME cases as supabase/tests/slip_recipient_check.sql
// (tests/unit/fixtures/recipient-cases.json), so the two cannot drift apart unnoticed.
// Pure functions, no imports.

const ch = String.fromCharCode;            // (built from code points: some of these characters would be invisible in the source)
const SARA_AM = new RegExp(ch(0x0e4d) + ch(0x0e32), 'g');
const INVISIBLE = new RegExp('[' + ch(0x200b) + '-' + ch(0x200f) + ch(0xfeff) + ']', 'g');
const MARK = new RegExp('[' + ch(0x0e31) + ch(0x0e34) + '-' + ch(0x0e3a) + ch(0x0e47) + '-' + ch(0x0e4e) + ']');

/** NFC, sara am that OCR splits in two, no zero-width marks, one space, lower case (finance_name_tidy) */
export const tidyName = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFC').replace(SARA_AM, ch(0x0e33)).replace(INVISIBLE, '').replace(/[\s ]+/g, ' ').trim().toLowerCase();
/** one leading title, Thai or English (finance_name_untitle) */
export const untitle = (s: string | null | undefined): string =>
  tidyName(s).replace(/^(?:นางสาว|นาง|นาย|น\.\s*ส\.?|นส\.|ด\.\s*ช\.?|ด\.\s*ญ\.?|คุณ|(?:mrs|mr|ms|miss|dr)(?:\.\s*|\s+))\s*/, '').trim();
/** no spaces, dots, dashes, quotes or mask characters (finance_name_key) */
export const nameKey = (s: string | null | undefined): string => (s ?? '').replace(/[\s.,'"_*•·×:;()-]+/g, '');

const LOOK = ['รธ', 'ลส', 'ดค', 'บป', 'ขช', 'ภถ', 'พฟ', 'ผฝ', 'ผพ', 'ฝฟ', 'ทฑ', 'ณฌ', 'ซช', 'ฎฏ', 'ศส', 'ฐร', 'มน', 'อฮ', 'วร', 'ยข'];
const indel = (c: string) => (MARK.test(c) ? 0.5 : 1);
/** a tone or vowel mark lost or added costs 0.5, a look-alike letter 0.5, anything else 1 (finance_name_dist) */
export function nameDist(a: string, b: string): number {
  if (a === b) return 0;
  const x = [...a], y = [...b]; const n = x.length, m = y.length;
  if (!n) return m; if (!m) return n; if (n > 80 || m > 80) return Math.max(n, m);
  let prev = [0]; for (let j = 1; j <= m; j++) prev.push(prev[j - 1] + indel(y[j - 1]));
  for (let i = 1; i <= n; i++) {
    const cur = [prev[0] + indel(x[i - 1])];
    for (let j = 1; j <= m; j++) {
      const p = x[i - 1], q = y[j - 1];
      const c = p === q ? 0 : LOOK.includes(p + q) || LOOK.includes(q + p) ? 0.5 : MARK.test(p) && MARK.test(q) ? 0.5 : 1;
      cur.push(Math.min(prev[j] + indel(p), cur[j - 1] + indel(q), prev[j - 1] + c));
    }
    prev = cur;
  }
  return prev[m];
}

export interface NameParts { key: string; first: string; rest: string; masked: boolean; prefix: string; script: 'thai' | 'latin' | 'none' }
/** first name, the rest, whether the bank masked the surname ("อ.", "อ***", "TE"), and its visible start (finance_name_parts) */
export function nameParts(s: string | null | undefined): NameParts {
  const v = untitle(s);
  if (!v) return { key: '', first: '', rest: '', masked: false, prefix: '', script: 'none' };
  const t = v.split(' '); const rest = t.slice(1).join(' ').trim();
  const masked = rest !== '' && (/^[^\s0-9]{0,8}[x×*•·.]+$/.test(rest) || [1, 2].includes([...nameKey(rest)].length));
  return { key: nameKey(v), first: nameKey(t[0]), rest: nameKey(rest), masked, prefix: masked ? nameKey(rest.replace(/[x×*•·.]+$/, '')) : '',
    script: /[ก-๛]/.test(v) ? 'thai' : /[a-z]/.test(v) ? 'latin' : 'none' };
}

export interface Holder { holder: string; name: string; digits?: string | null; src?: string }
/** conflict: the name is clearly someone else's but the visible digits look like one of our accounts (a person decides) */
export type Verdict = 'match' | 'partial' | 'near' | 'conflict' | 'other' | 'none';
export interface MatchResult { verdict: Verdict; name_verdict: Verdict; digits_verdict: 'match' | 'other' | 'none'; method: string | null; holder: string | null; distance: number | null }
const len = (s: string) => [...s].length;

/** one name (and the digits printed next to it) against every holder (finance_recipient_match) */
export function matchRecipient(name: string | null | undefined, digits: string | null | undefined, holders: Holder[]): MatchResult {
  const c = nameParts(name); const k = c.key; const d0 = (digits ?? '').replace(/[^0-9]/g, '').slice(0, 20);
  let best = 0, verdict: Verdict = 'none', method: string | null = null, holder: string | null = null, dist: number | null = null, dig: 'match' | 'other' | 'none' = 'none', cmp = false;
  for (const h of holders) {
    if (d0.length >= 3 && h.digits && dig !== 'match') {
      dig = d0.length <= h.digits.length && new RegExp(d0.split('').map((x) => `${x}[0-9]*`).join('')).test(h.digits) ? 'match' : 'other';
      if (dig === 'match') holder = holder ?? h.holder;
    }
    if (len(k) < 3 || !h.name) continue;
    const n = nameParts(h.name);
    if (c.script !== n.script) continue;
    cmp = true;
    const src = h.src ?? 'account';
    if (k === n.key) { if (best < 4) { best = 4; verdict = 'match'; method = src === 'account' ? 'exact' : 'variant'; holder = h.holder; dist = 0; } }
    else if ((c.masked && c.first === n.first && len(c.prefix) >= 1 && n.rest.startsWith(c.prefix)) || (len(k) > len(n.first) && len(n.rest) > 0 && n.key.startsWith(k))) {
      if (best < 3) { best = 3; verdict = 'match'; method = src === 'account' ? 'masked' : 'variant_masked'; holder = h.holder; dist = 0; }
    } else if (k === n.first && c.rest === '') {
      if (best < 2) { best = 2; verdict = 'partial'; method = 'first_name'; holder = h.holder; dist = null; }
    } else {
      const d = c.masked ? nameDist(c.first, n.first) + nameDist(c.prefix, [...n.rest].slice(0, len(c.prefix)).join('')) : nameDist(k, n.key);
      if (d <= 2 && best < 2) { best = 2; verdict = 'near'; method = 'distance'; holder = h.holder; dist = d; }
      else if (d <= 2 && verdict === 'near' && dist !== null && d < dist) { holder = h.holder; dist = d; }
    }
  }
  if (verdict === 'none' && cmp && len(k) >= 4) verdict = 'other';
  const conflict = verdict === 'other' && dig === 'match';
  const v: Verdict = conflict ? 'conflict' : verdict === 'match' || dig === 'match' ? 'match' : verdict === 'partial' || verdict === 'near' ? verdict : verdict === 'other' || dig === 'other' ? 'other' : 'none';
  return { verdict: v, name_verdict: verdict, digits_verdict: dig, method: conflict ? 'conflict' : verdict === 'match' ? method : dig === 'match' ? 'account' : method,
    holder: verdict === 'match' || verdict === 'partial' || verdict === 'near' || dig === 'match' ? holder : null, distance: dist };
}

export interface Candidate { name: string | null; account_hint: string | null; how: 'label' | 'order' }
/** a receiver label AT THE START of a line (a label word inside a name or a memo is not a label); longer labels first, as PostgreSQL takes the longest */
const LABEL = /^[^ก-๛a-z]*(?:(?:โอน(?:เงิน)?|ชื่อ(?:บัญชี)?)\s*)?(?:ไปยัง|ไปที่|ถึง|ผู้รับเงิน|ผู้รับโอน|ชื่อผู้รับ|ผู้รับ|บัญชีปลายทาง|ปลายทาง|โอนให้|โอนเข้า|เข้าบัญชี|to(?![a-z0-9])|receiver|recipient|payee|beneficiary)/i;
const TITLE_TOKEN = /^(นางสาว|นาง|นาย|น\.ส\.?|ด\.[ชญ]\.?|คุณ|mrs\.?|mr\.?|ms\.?|miss)$/;
const SENDER = /^(จาก|ผู้โอน|from|sender)/i;
const TITLED = /^(นางสาว|นาง|นาย|น\.\s*ส\.?|ด\.\s*ช\.?|ด\.\s*ญ\.?|คุณ|(mrs|mr|ms|miss)(\.|\s))/i;
const FIELD = /^(จำนวน|ยอด|ค่าธรรมเนียม|เลขที่|เลขบัญชี|รหัส|วันที่|เวลา|บันทึก|หมายเหตุ|โอนเงิน|สแกน|ธนาคาร|พร้อมเพย์|amount|fee|ref|transaction|date|time|memo|note|bank|promptpay|scan)/i;
const ACC = /([x×*•0-9][x×*•0-9 -]{4,}[0-9][x×*•0-9-]*)/;
const LETTERS2 = /[ก-ฮa-z].*[ก-ฮa-z]/;
const ACC_LABEL = /^(เลขที่บัญชี|เลขบัญชี|บัญชี|account( no\.?)?|a\/c( no\.?)?|พร้อมเพย์|promptpay|e-?wallet)\s*[:：]?/;

/** The receiver by its PLACE on the slip, one candidate per reading (passes separated by a form feed). Never a search of the whole text (finance_recipient_candidates). */
export function recipientCandidates(text: string | null | undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const pass of (text ?? '').slice(0, 12000).split('\f')) {
    const lines = pass.split('\n').map(tidyName).filter(Boolean);
    let nm: string | null = null, acct: string | null = null, how: Candidate['how'] | null = null, k = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (SENDER.test(ln) || !LABEL.test(ln)) continue;
      const m = LABEL.exec(ln)!;
      nm = ln.slice(m[0].length).replace(/^[\s:：-]+|[\s:：-]+$/g, '');
      if (!LETTERS2.test(nm) || /^[x×*•0-9]/.test(nm)) { acct = ACC.exec(nm)?.[1] ?? null; nm = i + 1 < lines.length ? lines[i + 1] : null; k = i + 1; } else k = i;
      how = 'label'; break;
    }
    if (!how) {
      const titled = lines.map((l, i) => (TITLED.test(l) ? i : -1)).filter((i) => i >= 0);
      if (titled.length === 2) { nm = lines[titled[1]]; k = titled[1]; how = 'order'; }
    }
    if (nm !== null && FIELD.test(nm)) nm = null;
    if (nm !== null || acct !== null) {
      acct = acct ?? (nm !== null ? ACC.exec(nm)?.[1] ?? null : null)
        ?? lines.slice(k + 1, k + 3).map((l) => ({ l, a: ACC.exec(l)?.[1] ?? null })).find((x) => x.a !== null && x.l.replace(ACC_LABEL, '').replace(/[x×*•0-9 .-]/g, '').length <= 4)?.a ?? null;
      if (nm !== null) {
        nm = nm.replace(/(\s+(?:[x×*•]{2,}|[x×*•]*[0-9])|\s*(?:ธนาคาร|ธ\.|bank\b|\()).*$/i, '').trim();
        nm = (/^[ก-ฺเ-๎a-z.*•×· ]*/.exec(nm)?.[0] ?? '').trim();                       // up to the first character no name has
        const t = nm.split(' ');
        while (t.length - (TITLE_TOKEN.test(t[0]) ? 1 : 0) > 2 && /^[^x×*•·.]{1,2}$/.test(t[t.length - 1])) t.pop();   // a stray short word after first name and surname
        nm = t.join(' ');
        if (!LETTERS2.test(nm)) nm = null;
      }
      out.push({ name: nm === null ? null : [...nm].slice(0, 80).join(''), account_hint: acct === null ? null : acct.trim().slice(0, 40), how: how ?? 'label' });
    }
  }
  return out;
}

export type RecipientStatus = 'match' | 'mismatch' | 'uncertain' | 'unclear';
export interface RecipientCheck { status: RecipientStatus; holder: string | null; method: string | null; agree: { match: number; other: number; soft: number } }
/** all candidates together; `minAgree` candidates must say "someone else" before it is called not ours (finance_recipient_check) */
export function checkRecipient(cands: { name: string | null; account_hint: string | null }[], holders: Holder[], minAgree = 1): RecipientCheck {
  let nm = 0, no = 0, ns = 0, holder: string | null = null, method: string | null = null;
  for (const c of cands.slice(0, 6)) {
    const r = matchRecipient(c.name, c.account_hint, holders);
    if (r.verdict === 'match') { nm++; holder = holder ?? r.holder; method = method ?? r.method; }
    else if (r.verdict === 'other') no++;
    else if (r.verdict === 'near' || r.verdict === 'partial' || r.verdict === 'conflict') { ns++; holder = holder ?? r.holder; }
  }
  const status: RecipientStatus = nm > 0 && no === 0 ? 'match' : nm === 0 && no >= Math.max(minAgree, 1) && ns === 0 ? 'mismatch' : nm + no + ns > 0 ? 'uncertain' : 'unclear';
  return { status, holder: status === 'match' || status === 'uncertain' ? holder : null, method: status === 'match' ? method : null, agree: { match: nm, other: no, soft: ns } };
}
