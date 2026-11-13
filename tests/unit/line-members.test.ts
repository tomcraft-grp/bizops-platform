import { describe, expect, it } from 'vitest';
import { ctx, tx, codeOf } from '../helpers';
import { linkLineMember } from '../../src/domain/master';

describe('LINE members: linking a real member to a local customer record', () => {
  it('creates a retail customer on first use, carrying the LINE ID, name and phone', () => {
    tx((d) => {
      const before = d.customers.length;
      const id = linkLineMember(d, ctx, { lineUserId: 'U1234567890abcdef', name: 'สมชาย', phone: '0812345678' });
      expect(d.customers.length).toBe(before + 1);
      const c = d.customers.find((x) => x.id === id)!;
      expect(c).toMatchObject({ lineUserId: 'U1234567890abcdef', name: 'สมชาย', phone: '0812345678', group: 'retail' });
    });
  });

  it('is idempotent: the same LINE account always maps to the same record, refreshing name and phone', () => {
    tx((d) => {
      const a = linkLineMember(d, ctx, { lineUserId: 'Uabc', name: 'Old name', phone: '0811111111' });
      const count = d.customers.length;
      const b = linkLineMember(d, ctx, { lineUserId: 'Uabc', name: 'New name', phone: '0822222222' });
      expect(b).toBe(a);
      expect(d.customers.length).toBe(count);
      expect(d.customers.find((x) => x.id === a)).toMatchObject({ name: 'New name', phone: '0822222222' });
    });
  });

  it('is not blocked when a demo customer already uses the same phone number', () => {
    tx((d) => {
      const demo = d.customers.find((c) => c.phone && !c.lineUserId)!;
      const id = linkLineMember(d, ctx, { lineUserId: 'Udup', name: 'Real member', phone: demo.phone });
      expect(id).not.toBe(demo.id);
      expect(d.customers.find((x) => x.id === id)!.phone).toBe(demo.phone);
    });
  });

  it('falls back to a placeholder name and rejects a missing LINE ID', () => {
    tx((d) => {
      const id = linkLineMember(d, ctx, { lineUserId: 'Unoname', name: '  ', phone: null });
      expect(d.customers.find((x) => x.id === id)).toMatchObject({ name: 'LINE member', phone: '' });
      expect(codeOf(() => linkLineMember(d, ctx, { lineUserId: '' }))).toBe('INVALID');
    });
  });
});
