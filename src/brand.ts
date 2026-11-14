// The ONE place that defines the platform's name and identity. Screens, the HTML shell (title, favicon, meta tags), downloads
// and documents read from here, so renaming the platform again is a change to this file only.
//
// Deliberately NOT derived from this file (renaming them would orphan data that already exists on users' devices or servers):
//   * the browser database name `bizops-platform` (src/lib/idb.ts) and the `bizops.*` localStorage / sessionStorage keys,
//   * the Supabase table `bizops_feedback_issues`, and the web path `/bizops-platform/` (Supabase redirect URLs, LINE LIFF).
// tests/unit/brand.test.ts fails if the old name appears anywhere else.
export const BRAND = {
  /** Full platform name: titles, headings, emails, footers. */
  name: 'Tom-Craft Platform',
  /** Short name: tight spaces (sidebar, LINE entry page), file names. */
  shortName: 'Tom-Craft',
  /** One line used for the HTML description. */
  tagline: 'Business operations and commerce management',
  /** Brand colour of the favicon (the app UI colour comes from the --brand CSS variable, which is already this blue). */
  color: '#2a78d6',
  /** Letters shown in the logo mark and the favicon. */
  monogram: 'TC',
  /** Prefix of downloaded files, e.g. tom-craft-backup-2026-11-14.json. */
  filePrefix: 'tom-craft',
} as const;

/** Square logo mark as SVG text (rounded square + monogram). Used for the favicon. */
export const brandMarkSvg = (): string =>
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${BRAND.color}'/>` +
  `<text x='16' y='21.5' text-anchor='middle' font-family='Segoe UI,Helvetica,Arial,sans-serif' font-size='15' font-weight='700' letter-spacing='-0.5' fill='white'>${BRAND.monogram}</text></svg>`;

export const faviconDataUrl = (): string => `data:image/svg+xml,${encodeURIComponent(brandMarkSvg())}`;

/** "© 2026 Tom-Craft Platform" */
export const copyrightLine = (year: number = new Date().getFullYear()): string => `© ${year} ${BRAND.name}`;
