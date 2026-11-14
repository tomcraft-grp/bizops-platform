import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, brandMarkSvg, copyrightLine, faviconDataUrl } from '../../src/brand';

const root = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|css|html|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');
const SCANNED = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'supabase', 'auth')), ...['index.html', 'README.md', 'package.json', 'vite.config.ts'].map((f) => path.join(root, f))];

/** Internal identifiers that keep the old spelling ON PURPOSE: renaming them would orphan existing user data or break links. */
const INTERNAL = [
  /bizops\.(theme|lang|collapsed|recovery|cust|intro|expenses\.guide)\b/gi, // localStorage / sessionStorage keys already stored on users' devices
  /bizops-platform/gi,                                                       // browser database name, repository / folder, web path /bizops-platform/ (Supabase redirects, LINE LIFF)
  /bizops_feedback_issues/gi,                                                // Supabase table
  /\[bizops\]/gi,                                                            // developer console prefix
  /bizops\.\*/gi,                                                            // README note about the storage keys
];

describe('platform branding', () => {
  it('defines the platform as Tom-Craft Platform (short name Tom-Craft) in one place', () => {
    expect(BRAND.name).toBe('Tom-Craft Platform');
    expect(BRAND.shortName).toBe('Tom-Craft');
    expect(BRAND.name.startsWith(BRAND.shortName)).toBe(true);
    expect(BRAND.monogram).toBe('TC');
    expect(BRAND.filePrefix).toBe('tom-craft');
  });

  it('builds the favicon from the same constants', () => {
    const svg = decodeURIComponent(faviconDataUrl().replace('data:image/svg+xml,', ''));
    expect(svg).toBe(brandMarkSvg());
    expect(svg).toContain(`>${BRAND.monogram}</text>`);
    expect(svg).toContain(BRAND.color);
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('writes the copyright line with the platform name and a year', () => {
    expect(copyrightLine(2026)).toBe('© 2026 Tom-Craft Platform');
    expect(copyrightLine()).toMatch(/^© \d{4} Tom-Craft Platform$/);
  });

  it('the HTML shell takes everything from the brand file (no literal name)', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toContain('<title>{{brand.name}}</title>');
    expect(html).toContain('href="{{brand.favicon}}"');
    expect(html).not.toMatch(/bizops/i);
    expect(html).not.toMatch(/tom-?craft/i);
  });

  it('no screen, file or document uses the old name except the internal identifiers that must keep it', () => {
    const offenders: string[] = [];
    for (const f of SCANNED) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        let rest = line;
        for (const re of INTERNAL) rest = rest.replace(re, '');
        if (/bizops/i.test(rest)) offenders.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the old demo-business name is no longer a default shown to users', () => {
    const schema = fs.readFileSync(path.join(root, 'src/devapp/schema.ts'), 'utf8');
    expect(schema).toContain('export function defaultLayout(title: string = BRAND.shortName)');
    expect(schema).not.toContain("title = 'Sabaidee'");
  });

  it('the new name is never typed into a screen: only src/brand.ts spells it out', () => {
    const hits: string[] = [];
    for (const f of walk(path.join(root, 'src'))) {
      if (rel(f) === 'src/brand.ts') continue;
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => { if (/tom[- ]?craft/i.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
    }
    expect(hits).toEqual([]);
  });

  it('every sign-in / error page, the sidebar, the phone expenses header, the loading screen and the backup file read the brand file', () => {
    const uses = (file: string, token: string) => expect(fs.readFileSync(path.join(root, file), 'utf8'), `${file} should use ${token}`).toContain(token);
    for (const p of ['Login', 'ForgotPassword', 'ResetPassword', 'Unauthorized', 'LiffEntry']) { uses(`src/pages/auth/${p}.tsx`, 'BRAND.name'); uses(`src/pages/auth/${p}.tsx`, 'AuthLayout'); }
    uses('src/ui/Shell.tsx', 'BRAND.shortName'); uses('src/ui/Shell.tsx', 'BrandMark');
    uses('src/expenses/ExpensesPage.tsx', 'BRAND.name');
    uses('src/main.tsx', 'BRAND.name');
    uses('src/pages/Admin.tsx', 'BRAND.filePrefix');
    uses('src/ui/Brand.tsx', 'copyrightLine');
  });

  it('keeps the data keys that already exist on users\' devices', () => {
    expect(fs.readFileSync(path.join(root, 'src/lib/idb.ts'), 'utf8')).toContain("const DB_NAME = 'bizops-platform'");
    const store = fs.readFileSync(path.join(root, 'src/domain/store.ts'), 'utf8');
    for (const k of ['bizops.theme', 'bizops.lang', 'bizops.collapsed']) expect(store).toContain(`'${k}'`);
    expect(fs.readFileSync(path.join(root, 'src/lib/feedbackApi.ts'), 'utf8')).toContain("from('bizops_feedback_issues')");
  });
});
