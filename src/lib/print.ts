import QRCode from 'qrcode';
import type { Block, PrintDoc } from '../domain/printing';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function qrSvg(data: string, size = 120): Promise<string> {
  const s = await QRCode.toString(data, { type: 'svg', margin: 0, width: size });
  return s;
}

export async function docToHtml(doc: PrintDoc): Promise<string> {
  const thermal = doc.paper !== 'A4';
  const width = doc.paper === '58mm' ? '48mm' : doc.paper === '80mm' ? '72mm' : '190mm';
  const parts: string[] = [];
  for (const b of doc.blocks) parts.push(await blockHtml(b, thermal));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
  @page{size:${doc.paper === 'A4' ? 'A4' : doc.paper + ' auto'};margin:${thermal ? '3mm' : '14mm'}}
  *{box-sizing:border-box}body{font-family:${thermal ? "'Courier New',ui-monospace,monospace" : "system-ui,'Segoe UI',sans-serif"};font-size:${thermal ? '11px' : '12px'};width:${width};margin:0 auto;color:#000}
  .c{text-align:center}.b{font-weight:700}.big{font-size:${thermal ? '15px' : '20px'}}.row{display:flex;justify-content:space-between;gap:8px}
  hr{border:0;border-top:1px ${'dashed'} #000;margin:6px 0}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border-bottom:1px solid #bbb;padding:5px 4px;text-align:left}th{background:#f2f2f2}
  .r{text-align:right}.title{font-size:22px;font-weight:700;margin-bottom:2px}.sub{color:#555;margin-bottom:12px}.qr{display:flex;justify-content:center;margin:8px 0}
  </style></head><body>${parts.join('')}</body></html>`;
}

async function blockHtml(b: Block, thermal: boolean): Promise<string> {
  switch (b.t) {
    case 'title': return `<div class="title">${esc(b.text)}</div>${b.sub ? `<div class="sub">${esc(b.sub)}</div>` : ''}`;
    case 'center': return `<div class="c ${b.bold ? 'b' : ''} ${b.big ? 'big' : ''}">${esc(b.text)}</div>`;
    case 'text': return `<div class="${b.bold ? 'b' : ''}">${esc(b.text)}</div>`;
    case 'row': return `<div class="row ${b.bold ? 'b' : ''}"><span>${esc(b.l)}</span><span>${esc(b.r)}</span></div>`;
    case 'hr': return '<hr/>';
    case 'blank': return '<br/>';
    case 'qr': return `<div class="qr">${await qrSvg(b.data, thermal ? 110 : 140)}</div>`;
    case 'table': {
      const al = (i: number) => (b.align?.[i] === 'r' ? 'r' : b.align?.[i] === 'c' ? 'c' : '');
      return `<table><thead><tr>${b.head.map((h, i) => `<th class="${al(i)}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${al(i)}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  }
}

/** Real browser printing through a hidden iframe (works with any printer the OS exposes). */
export async function printDoc(doc: PrintDoc): Promise<void> {
  const html = await docToHtml(doc);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const w = iframe.contentWindow!;
  w.document.open();
  w.document.write(html);
  w.document.close();
  await new Promise((r) => setTimeout(r, 250));
  w.focus();
  w.print();
  setTimeout(() => iframe.remove(), 4000);
}
export async function downloadDocHtml(doc: PrintDoc) {
  const html = await docToHtml(doc);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.title.replace(/[^\w.-]+/g, '_') + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
