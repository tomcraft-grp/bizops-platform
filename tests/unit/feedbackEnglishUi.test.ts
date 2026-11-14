// Client side of the English context: copy text, parsing, language detection, states, and that every new label has Thai.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COPY_LINK_TTL_SECONDS, ENGLISH_CONTEXT_SECTIONS, FEEDBACK_CATEGORIES, FeedbackIssue, contextState, contextWithAttachments, detectLanguage, englishContextCopy,
  englishContextTemplate, parseContext,
} from '../../src/lib/feedbackApi';
import { SECTIONS } from '../../supabase/functions/feedback-english-context/core';
import { t } from '../../src/lib/i18n';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const CTX = ['## Issue Title', 'Save button does not work', '', '## Background', '- Page: Products', '', '## Expected Behavior', 'Not provided'].join('\n');
const att = (n: number) => ({ file_name: `screenshot-${n}.png`, mime_type: 'image/png', size_bytes: 51200 * n, created_at: '2026-11-15T01:02:03Z', url: `https://files.example/s${n}?token=abc` });

describe('the nine sections', () => {
  it('the browser and the Edge Function use the same list, in the order of the specification', () => {
    expect([...ENGLISH_CONTEXT_SECTIONS]).toEqual([...SECTIONS]);
    expect([...ENGLISH_CONTEXT_SECTIONS]).toEqual(['Issue Title', 'Background', 'Problem Description', 'Expected Behavior', 'Actual Behavior', 'Impact', 'Technical Evidence', 'Implementation Requirements', 'Acceptance Criteria']);
  });
  it('the template for writing by hand has every heading with "Not provided"', () => {
    const tpl = englishContextTemplate();
    expect(tpl.match(/^## /gm)?.length).toBe(9);
    expect(tpl.match(/^Not provided$/gm)?.length).toBe(9);
    expect(parseContext(tpl)?.map((s) => s.title)).toEqual([...SECTIONS]);
  });
  it('parseContext splits the stored text for display, and returns null for free text', () => {
    expect(parseContext(CTX)).toEqual([{ title: 'Issue Title', body: 'Save button does not work' }, { title: 'Background', body: '- Page: Products' }, { title: 'Expected Behavior', body: 'Not provided' }]);
    expect(parseContext('Just a sentence written by hand.')).toBeNull();
    expect(parseContext('')).toBeNull();
    expect(parseContext(null)).toBeNull();
    expect(parseContext(CTX.replace(/\n/g, '\r\n'))?.length).toBe(3);
  });
});

describe('Copy English Context', () => {
  it('copies exactly the stored text, headings and bullets included', () => {
    expect(englishContextCopy({ english_context: `  ${CTX}\n\n` })).toBe(CTX);
    expect(englishContextCopy({ english_context: null })).toBe('');
  });
});

describe('Copy Context + Attachments', () => {
  const now = new Date('2026-11-15T01:00:00Z');
  it('adds a numbered list of the files with their links after the context', () => {
    const out = contextWithAttachments({ id: 'FB-001234', english_context: CTX }, [att(1), att(2)], now);
    expect(out.startsWith(CTX)).toBe(true);
    expect(out).toContain('## Attachments (2)');
    expect(out).toContain('1. screenshot-1.png (image/png, 50 KB, uploaded 2026-11-15) - https://files.example/s1?token=abc');
    expect(out).toContain('2. screenshot-2.png (image/png, 100 KB, uploaded 2026-11-15) - https://files.example/s2?token=abc');
    expect(out.endsWith('\n')).toBe(true);
  });
  it('never claims the images are embedded: it says they are NOT, and when the links stop working', () => {
    const out = contextWithAttachments({ id: 'FB-001234', english_context: CTX }, [att(1)], now);
    expect(out).toMatch(/They are NOT embedded in this text/);
    // every use of "embedded"/"included" in the text must be negated ("NOT embedded"): the images are links, never claimed to be inside the text
    const claims = [...out.matchAll(/embedded|included/gi)].filter((m) => !/NOT $/.test(out.slice(0, m.index)));
    expect(claims).toEqual([]);
    expect([...out.matchAll(/embedded/gi)].length).toBeGreaterThan(0);
    expect(COPY_LINK_TTL_SECONDS).toBe(86400);
    expect(out).toContain('stop working after 2026-11-16 01:00 UTC');
    expect(out).toContain('FB-001234');
  });
  it('says so plainly when there are no attachments', () => {
    const out = contextWithAttachments({ id: 'FB-001234', english_context: CTX }, [], now);
    expect(out).toContain('No files are attached to issue FB-001234.');
    expect(out).not.toContain('NOT embedded');
  });
  it('shows megabytes for big files and keeps a placeholder when a link could not be made', () => {
    const out = contextWithAttachments({ id: 'FB-1', english_context: CTX }, [{ ...att(1), size_bytes: 3 * 1024 * 1024, url: '(link unavailable)' }], now);
    expect(out).toContain('3.0 MB');
    expect(out).toContain('(link unavailable)');
  });
});

describe('states of an issue', () => {
  const base = { english_context_error: null, english_context_started_at: null };
  it('an old issue (no English-context columns at all) is simply "pending"', () => {
    expect(contextState({} as Pick<FeedbackIssue, 'english_context_status'>)).toEqual({ status: 'pending', error: null });
    expect(contextState({ ...base, english_context_status: 'pending' })).toEqual({ status: 'pending', error: null });
  });
  it('shows completed and failed as they are, with the stored reason', () => {
    expect(contextState({ ...base, english_context_status: 'completed' }).status).toBe('completed');
    expect(contextState({ ...base, english_context_status: 'failed', english_context_error: 'AI_NOT_CONFIGURED: no key' })).toEqual({ status: 'failed', error: 'AI_NOT_CONFIGURED: no key' });
  });
  it('"processing" is real for 5 minutes, then counts as failed so the Retry button comes back', () => {
    const now = Date.parse('2026-11-15T01:10:00Z');
    expect(contextState({ ...base, english_context_status: 'processing', english_context_started_at: '2026-11-15T01:08:00Z' }, now).status).toBe('processing');
    const stale = contextState({ ...base, english_context_status: 'processing', english_context_started_at: '2026-11-15T01:04:00Z' }, now);
    expect(stale.status).toBe('failed');
    expect(stale.error).toMatch(/^AI_TIMEOUT/);
    expect(contextState({ ...base, english_context_status: 'processing' }, now).status).toBe('failed');
  });
});

describe('original language label', () => {
  it('Thai, English, mixed and unknown', () => {
    expect(detectLanguage('ปุ่มบันทึกกดไม่ได้ที่หน้าสินค้า')).toBe('th');
    expect(detectLanguage('The save button does not work')).toBe('en');
    expect(detectLanguage('หน้า Products กดบันทึกแล้ว error permission denied สำหรับ SKU FG-000001')).toBe('mixed');
    expect(detectLanguage('12345 !!!')).toBe('unknown');
    expect(detectLanguage('')).toBe('unknown');
  });
});

describe('Thai translations of everything new', () => {
  const keys = [
    // picker
    'Paste your screenshot here (Ctrl+V) or drag and drop images.', 'or click here to choose files', 'Large pictures are shrunk automatically before upload.', 'Processing image…', '{n} attached',
    'Remove all', 'Remove {name}', 'Preview', 'Download', 'Close preview', 'Could not download the file',
    // form (the label, hint and Cancel come from lib/i18n.ts)
    'Description', 'Cancel', "What's the issue, idea, or additional feature you'd like to see on this page?", "Describe what you noticed or what you'd like changed…",
    // sections
    'Original feedback', 'Exactly as the reporter wrote it. This text is never changed.', 'Original language', 'Thai', 'English', 'Thai and English', 'Reporter', 'Submitted on',
    'English technical context', 'A structured English version for developers and coding assistants. The original feedback above is not changed.',
    'Ready', 'Generating…', 'Failed', 'Not generated yet', 'The English version is being prepared…', 'The English version has not been generated for this issue yet.',
    'The English-context service is not set up or cannot be reached. An administrator must add the AI key and deploy the function (docs/feedback-english-context.md). You can still write the English text by hand.',
    'Too many attempts. Try again later, or write the English text by hand.', 'The English text could not be generated. Try again, or write it by hand.',
    'Write only what the report supports. Use "Not provided" where nothing is known.', 'Save English context', 'English context saved', 'Copy English Context', 'Copy Context + Attachments',
    'Regenerate', 'Generate', 'Retry', 'Edit', 'Write by hand', 'Written by hand', 'Generated by AI', 'Replace the hand-written English text?',
    'Generating again overwrites the text that staff wrote. The original feedback is not changed.', 'The English context is already being generated.', 'English context copied to the clipboard',
    'Copied the English context and {n} attachment link(s). Images are linked, not embedded.', 'Could not copy automatically — the text is shown below so you can copy it by hand.',
    'Attachment links are private, expire after 24 hours, and the images are not embedded in the copied text.',
    'Evidence & attachments', '{n} file(s) attached to the original report', 'No screenshots or files were attached.',
  ];
  it('every new label, message and button has a Thai translation', () => {
    const missing = keys.filter((k) => t('th', k) === k);
    expect(missing).toEqual([]);
  });
  it('every literal passed to t() in the new components is in the list above (so nothing new is forgotten)', () => {
    for (const f of ['src/ui/FeedbackContext.tsx', 'src/ui/feedbackParts.tsx', 'src/ui/FeedbackWidget.tsx']) {
      const src = read(f);
      const used = [...src.matchAll(/\bt\(lang, ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)].map((m) => m[1].slice(1, -1).replace(/\\'/g, "'"));
      const forgotten = used.filter((u) => t('th', u) === u && !FEEDBACK_CATEGORIES.some((c) => c.label === u));
      expect(forgotten, f).toEqual([]);
    }
  });
  it('the Thai wording requested for the paste hint is used', () => {
    expect(t('th', 'Paste your screenshot here (Ctrl+V) or drag and drop images.')).toBe('วางภาพหน้าจอได้ทันทีด้วย Ctrl+V หรือลากรูปภาพมาวางที่นี่');
  });
});

describe('the form still shows the untranslated texts of the reported screenshot in Thai', () => {
  it('the widget translates the placeholder (the hint is translated by Field)', () => {
    const w = read('src/ui/FeedbackWidget.tsx');
    expect(w).toMatch(/placeholder=\{t\(lang, "Describe what you noticed or what you'd like changed…"\)\}/);
    expect(t('th', "What's the issue, idea, or additional feature you'd like to see on this page?")).not.toMatch(/^What's/);
  });
});
