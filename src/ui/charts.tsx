import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { compact } from '../lib/util';

export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.floor(e[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface TipState { x: number; y: number; content: ReactNode }
function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (e: React.MouseEvent | MouseEvent, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content });
  const hide = () => setTip(null);
  const el = tip && createPortal(
    <div className="tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 220), top: Math.max(8, tip.y - 12) }}>{tip.content}</div>, document.body);
  return { show, hide, el };
}

function niceScale(v: number, n = 4) {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(v / step - 1e-9) * step, step };
}
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="legend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>;
}

const roundTop = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};

/** Stacked / simple vertical bars. 2px surface gap between fills, 4px rounded top on the last segment. */
export function BarChart({ data, series, height = 240, fmt = compact, xLabel }: {
  data: { label: string; values: Record<string, number> }[]; series: { key: string; label: string; color: string }[]; height?: number; fmt?: (n: number) => string; xLabel?: (l: string, i: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { show, hide, el } = useTip();
  const [hover, setHover] = useState(-1);
  const m = { l: 44, r: 8, t: 10, b: 26 };
  const totals = data.map((d) => series.reduce((s, k) => s + Math.max(0, d.values[k.key] || 0), 0));
  const sc = niceScale(Math.max(...totals, 1));
  const max = sc.max;
  const iw = w - m.l - m.r, ih = height - m.t - m.b;
  const step = iw / Math.max(1, data.length);
  const bw = Math.max(3, Math.min(34, step * 0.66));
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = Array.from({ length: Math.round(max / sc.step) + 1 }, (_, i) => i * sc.step);
  const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 54)));
  return (
    <div ref={ref}>
      <svg className="chart" width={w} height={height} role="img" aria-label="Bar chart" onMouseLeave={() => { hide(); setHover(-1); }}>
        {ticks.map((t) => <g key={t}><line className="grid-l" x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} /><text x={m.l - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
        {data.map((d, i) => {
          const cx = m.l + step * i + step / 2;
          let acc = 0;
          const segs = series.filter((s) => (d.values[s.key] || 0) > 0);
          return (
            <g key={i} opacity={hover >= 0 && hover !== i ? 0.55 : 1}>
              {segs.map((s, si) => {
                const v = d.values[s.key];
                const y1 = y(acc + v), y0 = y(acc);
                acc += v;
                const top = si === segs.length - 1;
                const h = Math.max(1, y0 - y1 - (si > 0 ? 2 : 0));
                return top ? <path key={s.key} d={roundTop(cx - bw / 2, y1, bw, h, 4)} fill={s.color} /> : <rect key={s.key} x={cx - bw / 2} y={y1 + (y0 - y1 - h)} width={bw} height={h} fill={s.color} />;
              })}
              <rect x={cx - step / 2} y={m.t} width={step} height={ih} fill="transparent"
                onMouseMove={(e) => { setHover(i); show(e, <><b>{d.label}</b>{series.map((s) => (d.values[s.key] ? <div className="r" key={s.key}><span><i className="ch-dot" style={{ background: s.color, marginRight: 6 }} />{s.label}</span><span className="num">{fmt(d.values[s.key])}</span></div> : null))}{series.length > 1 && <div className="r" style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}><b>Total</b><b className="num">{fmt(totals[i])}</b></div>}</>); }}
              />
              {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle">{xLabel ? xLabel(d.label, i) : d.label}</text>}
            </g>
          );
        })}
        <line className="axis-l" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
      </svg>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      {el}
    </div>
  );
}

/** Line (and optional area for one series) chart with crosshair tooltip. One y-axis only. */
export function LineChart({ data, series, height = 220, fmt = compact, area }: {
  data: { label: string; values: Record<string, number> }[]; series: { key: string; label: string; color: string }[]; height?: number; fmt?: (n: number) => string; area?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { show, hide, el } = useTip();
  const [hover, setHover] = useState(-1);
  const m = { l: 44, r: 12, t: 10, b: 26 };
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => d.values[s.key] || 0))));
  const min = Math.min(0, ...data.flatMap((d) => series.map((s) => d.values[s.key] || 0)));
  const lo = min < 0 ? -niceMax(-min) : 0;
  const iw = w - m.l - m.r, ih = height - m.t - m.b;
  const x = (i: number) => m.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => m.t + ih - ((v - lo) / (max - lo)) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * (max - lo));
  const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 54)));
  return (
    <div ref={ref}>
      <svg className="chart" width={w} height={height} role="img" aria-label="Line chart" onMouseLeave={() => { hide(); setHover(-1); }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.max(0, Math.min(data.length - 1, Math.round(((e.clientX - r.left - m.l) / iw) * (data.length - 1))));
          setHover(i);
          show(e, <><b>{data[i].label}</b>{series.map((s) => <div className="r" key={s.key}><span><i className="ch-dot" style={{ background: s.color, marginRight: 6 }} />{s.label}</span><span className="num">{fmt(data[i].values[s.key] || 0)}</span></div>)}</>);
        }}>
        {ticks.map((t) => <g key={t}><line className="grid-l" x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} /><text x={m.l - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text></g>)}
        {series.map((s) => {
          const pts = data.map((d, i) => `${x(i)},${y(d.values[s.key] || 0)}`);
          return (
            <g key={s.key}>
              {area && series.length === 1 && <polygon points={`${x(0)},${y(0)} ${pts.join(' ')} ${x(data.length - 1)},${y(0)}`} fill={s.color} opacity={0.12} />}
              <polyline points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover >= 0 && <circle cx={x(hover)} cy={y(data[hover].values[s.key] || 0)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />}
            </g>
          );
        })}
        {hover >= 0 && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} stroke="var(--axis)" strokeDasharray="3 3" />}
        {data.map((d, i) => i % every === 0 && <text key={i} x={x(i)} y={height - 8} textAnchor="middle">{d.label}</text>)}
      </svg>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      {el}
    </div>
  );
}

export function Donut({ items, center, sub, size = 170, fmt = compact }: { items: { label: string; value: number; color: string }[]; center?: ReactNode; sub?: ReactNode; size?: number; fmt?: (n: number) => string }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const { show, hide, el } = useTip();
  const r = size / 2 - 10, c = size / 2, sw = 22;
  let a0 = -Math.PI / 2;
  const arcs = items.filter((i) => i.value > 0).map((i) => {
    const a1 = a0 + (i.value / total) * Math.PI * 2;
    const gap = items.length > 1 ? 0.025 : 0;
    const s = a0 + gap, e = a1 - gap;
    const large = e - s > Math.PI ? 1 : 0;
    const d = `M${c + r * Math.cos(s)},${c + r * Math.sin(s)} A${r},${r} 0 ${large} 1 ${c + r * Math.cos(e)},${c + r * Math.sin(e)}`;
    a0 = a1;
    return { ...i, d };
  });
  return (
    <div className="row gap-16 wrap" style={{ alignItems: 'center' }}>
      <svg width={size} height={size} role="img" aria-label="Donut chart" onMouseLeave={hide} style={{ flex: 'none' }}>
        {arcs.map((a) => <path key={a.label} d={a.d} fill="none" stroke={a.color} strokeWidth={sw} onMouseMove={(e) => show(e, <><b>{a.label}</b><div className="r"><span>Amount</span><span className="num">{fmt(a.value)}</span></div><div className="r"><span>Share</span><span className="num">{((a.value / total) * 100).toFixed(1)}%</span></div></>)} />)}
        <text x={c} y={c - 2} textAnchor="middle" style={{ fill: 'var(--text)', fontSize: 20, fontWeight: 700 }}>{center}</text>
        <text x={c} y={c + 16} textAnchor="middle">{sub}</text>
      </svg>
      <div className="col gap-6 grow" style={{ minWidth: 150 }}>
        {items.map((i) => (
          <div key={i.label} className="row between" style={{ fontSize: 13 }}>
            <span className="row gap-6"><i className="ch-dot" style={{ background: i.color }} />{i.label}</span>
            <span className="num"><b>{fmt(i.value)}</b> <span className="muted">{((i.value / total) * 100).toFixed(0)}%</span></span>
          </div>
        ))}
      </div>
      {el}
    </div>
  );
}

export function HBars({ items, fmt = compact, color = 'var(--s1)', max }: { items: { label: ReactNode; value: number; sub?: ReactNode; color?: string }[]; fmt?: (n: number) => string; color?: string; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <div className="col" style={{ gap: 11 }}>
      {items.map((i, k) => (
        <div key={k}>
          <div className="row between" style={{ fontSize: 13, marginBottom: 4 }}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.label}</span><span className="num"><b>{fmt(i.value)}</b>{i.sub && <span className="muted"> · {i.sub}</span>}</span></div>
          <div className="hbar"><i style={{ width: `${Math.max(1.5, (Math.abs(i.value) / m) * 100)}%`, background: i.color ?? color }} /></div>
        </div>
      ))}
    </div>
  );
}

export function Spark({ values, color = 'var(--s1)', w = 90, h = 28 }: { values: number[]; color?: string; w?: number; h?: number }) {
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * (w - 4) + 2},${h - 3 - ((v - min) / (max - min || 1)) * (h - 6)}`).join(' ');
  return <svg width={w} height={h} aria-hidden><polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/** Profit waterfall: rows with floating bars. Totals anchored at zero; deductions float. */
export function Waterfall({ rows, fmt }: { rows: { label: string; value: number; kind: 'total' | 'minus' | 'plus'; note?: string }[]; fmt: (n: number) => string }) {
  const steps = useMemo(() => {
    let run = 0;
    return rows.map((r) => {
      let start = 0, end = 0;
      if (r.kind === 'total') { start = 0; end = r.value; run = r.value; }
      else if (r.kind === 'minus') { start = run - Math.abs(r.value); end = run; run -= Math.abs(r.value); }
      else { start = run; end = run + r.value; run += r.value; }
      return { ...r, start, end };
    });
  }, [rows]);
  const max = Math.max(1, ...steps.map((s) => Math.max(s.start, s.end)));
  return (
    <div>
      {steps.map((s, i) => {
        const lo = Math.min(s.start, s.end), hi = Math.max(s.start, s.end);
        const color = s.kind === 'total' ? 'var(--s1)' : s.kind === 'minus' ? 'var(--s2)' : 'var(--s3)';
        return (
          <div className="waterfall-row" key={i}>
            <span style={{ fontWeight: s.kind === 'total' ? 650 : 400 }} title={s.note}>{s.label}</span>
            <div style={{ position: 'relative', height: 16, background: 'var(--surface-3)', borderRadius: 4 }}>
              <div style={{ position: 'absolute', left: `${(lo / max) * 100}%`, width: `${Math.max(0.6, ((hi - lo) / max) * 100)}%`, top: 0, bottom: 0, background: color, borderRadius: 4 }} />
            </div>
            <span className="num right" style={{ fontWeight: s.kind === 'total' ? 650 : 500 }}>{s.kind === 'minus' ? '−' : ''}{fmt(Math.abs(s.value))}</span>
          </div>
        );
      })}
    </div>
  );
}
