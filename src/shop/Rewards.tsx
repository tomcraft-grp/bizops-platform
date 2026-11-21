// The customer's Rewards screen (Account → "Rewards & event") and the cart's preview line.
// Board picks are PER BILL: each paid bill earns floor(eligible bill amount / step) picks and bills are never added together, so the screen shows, bill by bill,
// the eligible amount and the picks it earned ("counts once paid" for an unpaid bill, "taken back" when its payment was reversed), then "Earned 4 · Used 1 · 3 left to pick",
// then the three shared number boards, and under them the customer's own numbers (always, whatever the event is doing). In the points-only phase (boards not open yet) the
// screen shows the points and what moved them instead of any picks wording. The browser never decides anything: it shows what rw_my_rewards and rw_board_state say, sends a claim only after the customer
// confirms in an inline bar, and shows the board the server answers with. Other customers' identities are never sent to the browser.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronRight, Clock, Coins, Gift, Info, Lock, Minus, Undo2, User, Users, X } from 'lucide-react';
import { cx } from '../lib/util';
import { isRewardsError, rewards, type BoardCell, type BoardRevs, type BoardState, type CartPreview, type MyRewards, type PublicBoard, type Rights } from '../rewards/api';
import { ShopError } from './api';
import { newKey, toQuoteItems, type CartLine } from './cart';
import { baht, shopDate, shopDateTime } from './format';
import { useShopLang, useT } from './i18n';
import { useShopHost, useShopNav } from './nav';
import * as V from './rewardsView';
import { ErrorBox, errText, Section } from './ui';

interface Msg { tone: 'good' | 'bad' | 'info'; text: string }
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const BILL_ICON = { earned: CheckCircle2, none: Minus, waiting: Clock, taken_back: Undo2 } as const;

export function RewardsView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const lang = useShopLang();
  const host = useShopHost();
  const [mine, setMine] = useState<MyRewards | null>(null);
  const [mineErr, setMineErr] = useState<unknown>(null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [boardErr, setBoardErr] = useState<unknown>(null);
  const [boardsOff, setBoardsOff] = useState(false);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ boardId: string; n: number } | null>(null);
  const [held, setHeld] = useState<{ id: string; boardName: string; n: number } | null>(null);   // the claim worked, the follow-up confirm did not: the number is held, not confirmed
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [stale, setStale] = useState(false);                     // two revision reads in a row failed: the board may be out of date
  const [allBills, setAllBills] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const alive = useRef(true);
  const seq = useRef(0);                                         // the newest board request: an older answer is dropped
  const shown = useRef<BoardRevs | null>(null);                  // the revision numbers of the board on screen (what the poll compares with)
  const boardRef = useRef<BoardState | null>(null);              // the board on screen, for code that runs after an await
  const attempt = useRef<{ boardId: string; n: number; key: string } | null>(null);   // the idempotency key of the claim being made / retried
  const inflight = useRef(false);
  const pollFails = useRef(0);
  const lastBack = useRef(0);
  const returnFocus = useRef(false);
  const focusConfirm = useRef(false);                            // the question was opened from the keyboard: move focus to it
  const confirmRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  boardRef.current = board;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); headRef.current?.closest('.phone-body')?.scrollTo({ top: 0 }); }, []);

  const loadMine = useCallback(async () => {
    try { const m = await rewards.mine(); if (alive.current) { setMine(m); setMineErr(null); } } catch (e) { if (alive.current) setMineErr(e); }
  }, []);
  /** Reload the board. Resolves false only when the load FAILED (a superseded request, or "boards are off", is not a failure). */
  const loadBoard = useCallback(async (): Promise<boolean> => {
    const id = ++seq.current;
    try {
      const s = await rewards.boardState(null);
      if (!alive.current || id !== seq.current) return true;
      shown.current = V.revsOf(s); setBoard(s); setBoardErr(null); setBoardsOff(false); return true;
    } catch (e) {
      if (!alive.current || id !== seq.current) return true;
      if (isRewardsError(e, 'BOARDS_OFF', 'REWARDS_OFF')) { shown.current = null; setBoard(null); setBoardsOff(true); return true; }
      setBoardErr(e); return false;
    }
  }, []);
  useEffect(() => { void loadMine(); void loadBoard(); }, [loadMine, loadBoard]);

  // Keep the screen current. While a board is on screen: every 5 s ask for the three revision numbers (only while this screen is mounted and the page is visible) and
  // reload the board ONLY when one changed; two failed reads in a row show a small "may be out of date" note, the next success clears it. Coming back to the page
  // reloads everything at once. Missing a poll costs nothing: the server checks every claim anyway.
  const live = board !== null;
  useEffect(() => {
    let polling = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || polling) return;
      polling = true;
      let ok = true;
      try {
        const r = await rewards.boardRevs(null);
        if (alive.current && V.revsChanged(shown.current, r)) { ok = await loadBoard(); void loadMine(); }
      } catch (e) {
        if (isRewardsError(e, 'BOARDS_OFF', 'REWARDS_OFF')) { await loadBoard(); void loadMine(); }   // switched off meanwhile: not a connection problem, look again at what is on
        else ok = false;
      } finally { polling = false; }
      if (!alive.current) return;
      const h = V.pollHealth(pollFails.current, ok); pollFails.current = h.fails; setStale(h.stale);
    };
    const timer = live ? setInterval(() => { void tick(); }, V.POLL_MS) : null;
    const back = () => { if (Date.now() - lastBack.current < 1000) return; lastBack.current = Date.now(); void loadBoard(); void loadMine(); };
    const onFocus = () => back();
    const onVisible = () => { if (document.visibilityState === 'visible') back(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisible);
    return () => { if (timer) clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); };
  }, [live, loadBoard, loadMine]);
  useEffect(() => { if (!live) { pollFails.current = 0; setStale(false); } }, [live]);

  // ------------------------------------------------------------ derived
  const ev = board?.event ?? null;
  const boards = board ? [...board.boards].sort((a, b) => a.slot - b.slot) : [];
  const cur = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const picks = (mine?.picks ?? []).filter((p) => !ev || !p.event_id || p.event_id === ev.id);
  const rights = ev && board ? board.rights : V.sumPicks(picks);
  const rules = V.pickRules(picks);
  const access = V.boardAccess(ev, cur, rights);
  const bills = V.groupBills(picks);
  const maxN = ev?.number_max ?? 99;
  const pad = (n: number) => V.padNumber(n, maxN);
  const stepText = rules.length ? baht(V.smallestStep(rules)!) : null;

  // an open confirm bar for a number that is no longer pickable (somebody was faster, the board was locked…) closes with the reason, never a stale question
  useEffect(() => {
    if (!pending || !board || busy) return;
    const b = board.boards.find((x) => x.id === pending.boardId); const c = b?.numbers.find((x) => x.n === pending.n);
    const a = V.boardAccess(board.event, b ?? null, board.rights);
    if (b && c && V.cellKind(c, a) === 'pickable') return;
    setPending(null);
    if (b && c?.s === 'mine') { attempt.current = null; setMsg({ tone: 'good', text: t('rw.done', { board: b.name, n: pad(pending.n), left: board.rights.remaining }) }); return; }
    setMsg({ tone: 'bad', text: t(!b || !c ? 'rw.err.event' : V.accessKey(a) ?? (a === 'no_rights' ? 'rw.err.noRights' : 'rw.err.taken')) });
  }, [board]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if ((pending || held) && focusConfirm.current) { focusConfirm.current = false; confirmRef.current?.focus(); } }, [pending, held]);
  useEffect(() => { if (!pending && !held && returnFocus.current) { returnFocus.current = false; cellRefs.current[focusIdx]?.focus(); } }, [pending, held, focusIdx]);

  const closeBar = () => { if (dockRef.current?.contains(document.activeElement)) returnFocus.current = true; setPending(null); setHeld(null); };
  const chooseBoard = (id: string) => { if (id === cur?.id) return; setBoardId(id); setPending(null); setMsg(null); setFocusIdx(0); };
  const onCell = (c: BoardCell, idx: number, fromKeyboard: boolean) => {
    if (!cur || busy) return;
    setFocusIdx(idx);
    const kind = V.cellKind(c, access);
    if (kind === 'taken') { setPending(null); setMsg({ tone: 'info', text: t('rw.tap.taken', { board: cur.name, n: pad(c.n) }) }); return; }
    if (kind === 'mine') { setPending(null); setMsg({ tone: 'info', text: t('rw.tap.mine', { board: cur.name, n: pad(c.n) }) }); return; }
    if (kind === 'blocked') { setPending(null); const k = V.accessKey(access); setMsg({ tone: 'info', text: k ? t(k) : stepText ? t('rw.noRights', { amount: stepText }) : t('rw.noRightsUnknown') }); return; }
    setMsg(null); setHeld(null); focusConfirm.current = fromKeyboard; setPending({ boardId: cur.id, n: c.n });   // (a number still held from before stays held: it is listed under "Your numbers")
  };
  const onGridKey = (e: KeyboardEvent) => {
    if (!cur || !NAV_KEYS.has(e.key)) return;
    const i = cellRefs.current.findIndex((el) => el === document.activeElement); if (i < 0) return;
    e.preventDefault();
    const j = V.gridMove(i, e.key, V.GRID_COLS, cur.numbers.length); setFocusIdx(j); cellRefs.current[j]?.focus();
  };
  /** Put the server's answer (its board and its rights) on screen; a board load that started before it must not overwrite it. */
  const showServerBoard = (b: PublicBoard, r: Rights) => {
    seq.current++;
    const cur0 = boardRef.current;
    if (cur0) { const next = V.replaceBoard(cur0, b, r); shown.current = V.revsOf(next); boardRef.current = next; setBoard(next); }
  };
  const done = (boardName: string, n: number, left: number) => setMsg({ tone: 'good', text: t('rw.done', { board: boardName, n: pad(n), left }) });

  /** Confirm: ONE claim per attempt. A double tap does nothing (inflight); a retry after a lost answer reuses the key, so the server returns the first result. */
  const confirm = async () => {
    if (inflight.current) return;
    if (held) return confirmHeld();
    if (!pending || !ev) return;
    const b = boardRef.current?.boards.find((x) => x.id === pending.boardId); if (!b) return;
    inflight.current = true; setBusy(true); setMsg(null);
    const a = attempt.current && attempt.current.boardId === pending.boardId && attempt.current.n === pending.n ? attempt.current : (attempt.current = { boardId: pending.boardId, n: pending.n, key: newKey() });
    try {
      let r = await rewards.claim(ev.id, pending.boardId, pending.n, a.key);
      attempt.current = null;                                      // the claim is done: a later failure is about the confirm, not about the claim
      // an event with a hold reserves the number first: the customer already confirmed, so finish it in the same go
      if (r.selection.status === 'reserved') {
        try { const c = await rewards.confirm(r.selection.id); r = { ...r, selection: c.selection, board: c.board, rights: c.rights }; }
        catch (e) {
          if (!alive.current) return;
          // the number IS held for the customer (the claim's own answer says so) but it is not confirmed: never say "picked"
          const plan = V.confirmPlan(e instanceof ShopError ? e.code : 'ERROR');
          showServerBoard(r.board, r.rights);
          setPending(null);
          if (plan.keepBar) setHeld({ id: r.selection.id, boardName: b.name, n: pending.n }); else closeBar();
          setMsg({ tone: 'bad', text: t(plan.message, { board: b.name, n: pad(pending.n) }) });
          void loadMine(); if (!plan.keepBar) void loadBoard();
          return;
        }
      }
      if (!alive.current) return;
      showServerBoard(r.board, r.rights);
      closeBar();
      done(b.name, pending.n, r.rights.remaining);
      void loadMine();
    } catch (e) {
      if (!alive.current) return;
      const plan = V.claimPlan(e instanceof ShopError ? e.code : 'ERROR');
      if (!plan.keepKey) attempt.current = null;
      if (!plan.keepBar) closeBar();
      setMsg({ tone: 'bad', text: t(plan.message) });
      if (plan.refresh) { void loadBoard(); void loadMine(); }
    } finally { inflight.current = false; if (alive.current) setBusy(false); }
  };
  /** Confirm again a number that is held but not confirmed: the same selection, so the pick is never used twice. */
  const confirmHeld = async () => {
    if (!held || inflight.current) return;
    inflight.current = true; setBusy(true); setMsg(null);
    try {
      const c = await rewards.confirm(held.id);
      if (!alive.current) return;
      showServerBoard(c.board, c.rights); setHeld(null); closeBar();
      done(held.boardName, held.n, c.rights.remaining);
      void loadMine();
    } catch (e) {
      if (!alive.current) return;
      const plan = V.confirmPlan(e instanceof ShopError ? e.code : 'ERROR');
      if (!plan.keepBar) closeBar();
      setMsg({ tone: 'bad', text: t(plan.message, { board: held.boardName, n: pad(held.n) }) });
      if (plan.refresh) { void loadBoard(); void loadMine(); }
    } finally { inflight.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {   // Escape closes the question
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && (pending || held) && !inflight.current) closeBar(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ render
  const frame = (body: JSX.Element) => (
    <div className="rw-screen sp-page" data-testid="rewards-screen">
      <button type="button" className="sp-back" onClick={onBack}><ArrowLeft size={18} /> {t('common.back')}</button>
      <h2 className="sp-h2" tabIndex={-1} ref={headRef}>{t('rw.title')}</h2>
      {body}
    </div>
  );
  if (!mine) return frame(mineErr ? <ErrorBox message={errText(t, mineErr)} onRetry={() => { setMineErr(null); void loadMine(); }} /> : <div className="muted" aria-busy="true">{t('rw.loading')}</div>);
  if (!mine.enabled) return frame(<div className="rw-note" data-testid="rw-off"><Info size={18} aria-hidden /><span>{t('rw.off')}</span></div>);

  /** "Your numbers": what the server says the customer holds, whatever the event is doing (open, paused, closed) and whether or not a board is on screen. */
  const numbers = V.myNumbers(mine.selections ?? []);
  const myList = numbers.length > 0 && (
    <div className="rw-mine" data-testid="rw-mine">
      <b>{t('rw.mineList')}</b>
      <ul>
        {numbers.map((m) => (
          <li key={m.id} data-reserved={m.reserved || undefined}>
            <span className="who"><Check size={14} aria-hidden />{m.board} #{pad(m.n)}</span>
            <small>{m.reserved ? (m.expires_at ? t('rw.mine.reserved', { time: shopDateTime(m.expires_at, lang) }) : t('rw.mine.reservedNoTime')) : t('rw.mine.confirmed')}</small>
          </li>
        ))}
      </ul>
    </div>
  );

  // The points-only phase (rewards on, boards not open yet; rw_my_rewards sends no picks then): the points and what moved them, and the note. No picks wording at all.
  if (!mine.boards_enabled) {
    const history = mine.points_history ?? [];
    const hist = V.visibleHistory(history, allHistory);
    return frame(
      <>
        <section className="rw-points" data-testid="rw-points" aria-label={t('rw.pointsBalance')}>
          <Coins size={26} aria-hidden />
          <p><span>{t('rw.pointsBalance')}</span><b>{mine.points.toLocaleString('en-US')}</b> <span>{t('rw.pointsUnit')}</span></p>
        </section>
        <Section title={t('rw.hist.title')}>
          {history.length === 0 ? <p className="sp-note">{t('rw.hist.none')}</p> : (
            <>
              <ul className="rw-hist" data-testid="rw-history">
                {hist.map((h, i) => (
                  <li key={`${h.at}-${i}`} data-kind={h.kind}>
                    <span className="rw-hist-main"><b>{t(V.historyKey(h.kind))}</b>
                      <small>{[h.order_no ? t('rw.order', { no: h.order_no }) : null, h.note, shopDate(h.at, lang)].filter(Boolean).join(' · ')}</small></span>
                    <b className={cx('rw-hist-pts', h.points < 0 && 'neg')}>{V.signedPoints(h.points)}</b>
                  </li>
                ))}
              </ul>
              {history.length > V.HISTORY_COLLAPSED && !allHistory && <button type="button" className="sp-link" onClick={() => setAllHistory(true)}>{t('rw.hist.showAll', { n: history.length })}</button>}
            </>
          )}
        </Section>
        <div className="rw-note" data-testid="rw-boards-off"><Info size={18} aria-hidden /><span>{t('rw.boardsOff')}</span></div>
        {myList}
      </>,
    );
  }

  const hint = stepText ? t('rw.noRights', { amount: stepText }) : t('rw.noRightsUnknown');
  const eventKey = ev && ev.status !== 'active' ? V.accessKey(`event_${ev.status}` as V.Access) : null;
  const readOnly = access !== 'ok';
  const barOpen = !!held || (!!pending && !!cur);
  return frame(
    <>
      <section className="rw-summary" data-testid="rw-summary" aria-label={t('rw.summaryLabel')}>
        <Gift size={26} aria-hidden />
        <p><span>{t('rw.earned', { n: rights.earned })}</span>{' · '}<span>{t('rw.used', { n: rights.used })}</span>{' · '}<b>{t('rw.left', { n: rights.remaining })}</b></p>
      </section>
      {rules.length > 1 ? (
        <div className="rw-rules" data-testid="rw-rule">
          <b>{t('rw.rulesTitle')}</b>
          <ul>{rules.map((r) => <li key={r.id}>{t(r.reward === 1 ? 'rw.ruleItem1' : 'rw.ruleItemN', { name: r.name, amount: baht(r.step), n: r.reward })}</li>)}</ul>
          <small>{t('rw.rulesNote')}</small>
        </div>
      ) : <p className="sp-note" data-testid="rw-rule">{rules.length === 1 ? t(rules[0].reward === 1 ? 'rw.rule1' : 'rw.ruleN', { amount: baht(rules[0].step), n: rules[0].reward }) : t('rw.ruleUnknown')}</p>}
      {mine.points > 0 && <p className="sp-note"><b>{t('rw.points', { n: mine.points.toLocaleString('en-US') })}</b></p>}

      <Section title={t('rw.bills')}>
        {bills.length === 0 ? <p className="sp-note">{t('rw.noBills')}</p> : (
          <>
            <ul className="rw-bills" data-testid="rw-bills">
              {V.visibleBills(bills, allBills).map((b) => {
                const v = V.billView(b); const Icon = BILL_ICON[v.kind]; const amount = baht(b.eligible_amount);
                const several = b.parts.length > 1 && !b.sameAmount;          // rules that saw different eligible amounts: the row shows the total, each rule its own part
                const wording = (kind: V.BillKind, picks: number, amt: string) => kind === 'earned' ? t(picks === 1 ? 'rw.billEarned1' : 'rw.billEarnedN', { amount: amt, n: picks })
                  : kind === 'none' ? (rules.length === 1 && stepText ? t('rw.billNoneStep', { amount: amt, step: stepText }) : t('rw.billNone', { amount: amt }))
                    : kind === 'waiting' ? t('rw.billWaiting', { amount: amt }) : t('rw.billBack', { amount: amt });
                const line = several && v.kind === 'earned' ? t('rw.billSum', { n: v.picks }) : wording(v.kind, v.picks, amount);
                return (
                  <li key={b.order_id} data-order={b.order_no} data-kind={v.kind}>
                    <button type="button" className="rw-bill" title={t('rw.billOpen')} onClick={() => { useShopNav.getState().openOrder(b.order_id); host.goTab('pay'); }}>
                      <span className="rw-bill-ic" aria-hidden><Icon size={18} /></span>
                      <span className="rw-bill-main"><b>{t('rw.order', { no: b.order_no })}</b><small>{shopDate(b.created_at, lang)}</small><span>{line}</span>
                        {several && (
                          <span className="rw-parts" data-testid="rw-parts">
                            {b.parts.map((p) => { const pv = V.billView(p); return <small key={p.rule_id}>{p.rule_name}: {wording(pv.kind, pv.picks, baht(p.eligible_amount))}</small>; })}
                          </span>
                        )}
                      </span>
                      <ChevronRight size={18} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
            {bills.length > V.BILLS_COLLAPSED && <button type="button" className="sp-link" onClick={() => setAllBills((x) => !x)}>{allBills ? t('rw.showFewer') : t('rw.showAll', { n: bills.length })}</button>}
          </>
        )}
      </Section>

      <Section title={t('rw.boards')}>
        {boardsOff ? <div className="rw-note" data-testid="rw-boards-off"><Info size={18} aria-hidden /><span>{t('rw.boardsOff')}</span></div>
          : !board ? (boardErr ? <ErrorBox message={errText(t, boardErr)} onRetry={() => { setBoardErr(null); void loadBoard(); }} /> : <div className="muted" aria-busy="true">{t('rw.loading')}</div>)
            : !ev || !cur ? <div className="rw-note" data-testid="rw-no-event"><Info size={18} aria-hidden /><span>{t('rw.noEvent')}</span></div> : (
              <>
                <p className="rw-event"><b>{ev.name}</b>{ev.ends_at ? <small> · {t('rw.until', { date: shopDate(ev.ends_at, lang) })}</small> : null}</p>
                {stale && <div className="rw-stale" data-testid="rw-stale" role="status"><Clock size={14} aria-hidden /><span>{t('rw.stale')}</span></div>}
                {eventKey && <div className="rw-note warn" data-testid="rw-event-banner" role="status"><Info size={18} aria-hidden /><span>{t(eventKey)}</span></div>}
                <div className="rw-tabs" role="group" aria-label={t('rw.pickBoard')}>
                  {boards.map((b) => (
                    <button key={b.id} type="button" className="rw-tab" data-testid={`rw-tab-${b.slot}`} aria-pressed={b.id === cur.id} onClick={() => chooseBoard(b.id)} style={V.safeColor(b.color) ? ({ '--rw-c': V.safeColor(b.color) } as CSSProperties) : undefined}>
                      <i aria-hidden /><span className="nm">{b.name}</span>{b.state === 'locked' && <Lock size={14} aria-hidden />}
                    </button>
                  ))}
                </div>
                <p className="rw-mode" data-testid="rw-mode">{cur.mode === 'exclusive' ? <User size={16} aria-hidden /> : <Users size={16} aria-hidden />}<span>{t(cur.mode === 'exclusive' ? 'rw.mode.exclusive' : 'rw.mode.shared')}</span><small>{t('rw.takenCount', { n: cur.taken, total: cur.numbers.length })}</small></p>
                {access === 'locked' && <div className="rw-note warn" data-testid="rw-locked" role="status"><Lock size={18} aria-hidden /><span>{t('rw.locked')}</span></div>}
                {access === 'no_rights' && <div className="rw-note" data-testid="rw-hint" role="status"><Info size={18} aria-hidden /><span>{hint}</span></div>}
                <div className={cx('rw-grid', readOnly && 'ro')} role="group" aria-label={cur.name} data-testid="rw-grid" onKeyDown={onGridKey}>
                  {cur.numbers.map((c, i) => {
                    const kind = V.cellKind(c, access); const n = pad(c.n); const sel = pending?.boardId === cur.id && pending.n === c.n;
                    const label = c.s === 'mine' ? t('rw.cell.mine', { board: cur.name, n }) : c.s === 'taken' ? t('rw.cell.taken', { board: cur.name, n }) : c.s === 'shared' ? t('rw.cell.shared', { board: cur.name, n, c: c.c }) : t('rw.cell.free', { board: cur.name, n });
                    return (
                      <button key={c.n} ref={(el) => { cellRefs.current[i] = el; }} type="button" className={cx('rw-cell', sel && 'sel')} data-n={c.n} data-s={c.s} aria-label={label}
                        aria-disabled={kind === 'pickable' ? undefined : true} aria-pressed={kind === 'pickable' ? sel : undefined} tabIndex={i === focusIdx ? 0 : -1} onClick={(e) => onCell(c, i, e.detail === 0)}>
                        {n}{(c.s === 'shared' || (c.s === 'mine' && c.c > 1)) && <span className="rw-c" aria-hidden>{c.c}</span>}
                      </button>
                    );
                  })}
                </div>
                <ul className="rw-legend" data-testid="rw-legend" aria-label={t('rw.legend')}>
                  <li><span className="rw-key" data-s="free" aria-hidden>07</span>{t('rw.legend.free')}</li>
                  <li><span className="rw-key" data-s="taken" aria-hidden>07</span>{t('rw.legend.taken')}</li>
                  <li><span className="rw-key" data-s="mine" aria-hidden>07</span>{t('rw.legend.mine')}</li>
                  {cur.mode === 'shared' && <li><span className="rw-key" data-s="shared" aria-hidden>07<span className="rw-c">2</span></span>{t('rw.legend.shared')}</li>}
                </ul>
              </>
            )}
        {myList}
        <div className="rw-dock" ref={dockRef} aria-live="polite">
          {msg && <div className={cx('rw-msg', msg.tone)} data-testid="rw-msg"><span>{msg.text}</span><button type="button" aria-label={t('rw.dismiss')} onClick={() => setMsg(null)}><X size={16} aria-hidden /></button></div>}
          {barOpen && (
            <div className="rw-confirm" data-testid="rw-confirm">
              <p>{held ? t('rw.held.q', { board: held.boardName, n: pad(held.n) }) : t('rw.confirm.q', { board: cur!.name, n: pad(pending!.n) })}</p>
              <div className="rw-confirm-btns">
                <button type="button" className="btn" data-testid="rw-confirm-no" onClick={() => { if (!busy) closeBar(); }} aria-disabled={busy || undefined}>{t('rw.confirm.no')}</button>
                <button type="button" className="btn primary" data-testid="rw-confirm-yes" ref={confirmRef} onClick={() => { void confirm(); }} aria-disabled={busy || undefined} aria-busy={busy}>{busy ? '…' : t('rw.confirm.yes')}</button>
              </div>
            </div>
          )}
        </div>
      </Section>
    </>,
  );
}

// ---------------------------------------------------------------- cart preview
let previewQuietUntil = 0;       // after "rewards are off" or a failed call, do not ask again for a minute (a dark shop must not add a request to every cart change)
/**
 * What the cart would earn once paid ("฿850 of eligible items: you will earn 2 picks once paid; ฿50 more for a third"), from rw_preview_cart. It is read-only, debounced and
 * silent: hidden when rewards are off, nothing applies, or the call fails; it never blocks checkout and never touches a total.
 */
export function RewardsPreview({ lines }: { lines: CartLine[] }) {
  const t = useT();
  const [p, setP] = useState<CartPreview | null>(null);
  const sig = JSON.stringify(toQuoteItems(lines));
  useEffect(() => {
    if (!lines.length) { setP(null); return; }
    let on = true;
    const h = setTimeout(() => {
      if (Date.now() < previewQuietUntil) { setP(null); return; }
      rewards.previewCart(toQuoteItems(lines)).then((r) => {
        if (!on) return;
        if (!r.enabled) previewQuietUntil = Date.now() + 60_000;
        setP(r.enabled ? r : null);
      }).catch((e) => { if (!on) return; setP(null); if (!(e instanceof ShopError && e.code === 'NETWORK')) previewQuietUntil = Date.now() + 60_000; });
    }, 400);
    return () => { on = false; clearTimeout(h); };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const vm = V.previewView(p);
  if (!vm.length) return null;
  return (
    <div className="rw-preview" data-testid="rw-preview">
      <Gift size={18} aria-hidden />
      <div>
        {vm.map((l, i) => {
          const amount = baht(l.amount);
          const main = l.kind === 'picks'
            ? t(l.n === 0 ? 'rw.cart.picksNone' : l.n === 1 ? 'rw.cart.picks1' : 'rw.cart.picksN', { amount, n: l.n })
            : t(l.n === 0 ? 'rw.cart.pointsNone' : 'rw.cart.pointsN', { amount, n: l.n });
          const more = l.more == null || l.next == null ? null : l.kind === 'points' ? t('rw.cart.morePoints', { more: baht(l.more), total: l.next })
            : t(l.next === 1 ? 'rw.cart.more1' : 'rw.cart.more', { more: baht(l.more), total: l.next });
          return <p key={i}><span>{main}</span>{more && <small>{more}</small>}</p>;
        })}
      </div>
    </div>
  );
}
