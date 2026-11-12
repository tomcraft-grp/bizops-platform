import type { ID, MediaFile } from '../domain/types';
import { act, useStore } from '../domain/store';
import { nid } from '../domain/core';
import { ingest, retentionYears, storeIngest, loadMediaUrl } from '../lib/media';
import { blobGet, blobDel } from '../lib/idb';

/** Upload pipeline: validate real content type → checksum → optimise → store blob → async "malware scan" */
export async function uploadMedia(file: File, kind: MediaFile['kind'], link?: { type: string; id?: ID }, opts?: { private?: boolean; allowDuplicate?: boolean }): Promise<ID> {
  const ing = await ingest(file);
  const dup = useStore.getState().db.media.find((m) => m.checksum === ing.meta.checksum && m.kind === kind);
  if (dup && !opts?.allowDuplicate && (kind === 'payment_slip' || kind === 'purchase_invoice')) throw new Error(`This exact file was already uploaded (${dup.name}). Duplicate documents are blocked.`);
  const id = act((d, c) => {
    const mid = nid(d, 'MD');
    d.media.push({ id: mid, kind, ...ing.meta, private: opts?.private ?? (kind !== 'product_image' && kind !== 'event_image'), linkedType: link?.type, linkedId: link?.id, uploadedBy: c.userId, createdAt: c.now, sort: d.media.length });
    return mid;
  });
  await storeIngest(id, ing);
  setTimeout(() => act((d) => { const m = d.media.find((x) => x.id === id); if (m && m.status === 'scanning') { m.status = 'available'; m.scanNote = 'Clean — no known signatures (simulated scan)'; } }), 1100);
  return id;
}

/** Short-lived access to a private file; every access is written to the access log */
export async function signedUrl(id: ID, action: 'view' | 'download' = 'view', ttlMs = 60000): Promise<string | null> {
  const m = useStore.getState().db.media.find((x) => x.id === id);
  if (!m || m.status === 'quarantined') return null;
  act((d, c) => { d.mediaAccess.push({ id: nid(d, 'MA'), mediaId: id, ts: c.now, userId: c.userId, action: 'signed_url' }); void action; });
  const url = await loadMediaUrl(m, 'original');
  if (url && url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), ttlMs);
  return url;
}
export async function deleteMedia(id: ID) {
  await blobDel(id); await blobDel(id + ':thumb'); await blobDel(id + ':web');
}
export const retention = retentionYears;
export const hasBlob = async (id: ID) => !!(await blobGet(id));
