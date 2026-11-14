import { Vault, passkeySupport, requestPersistence } from './store.js';
import * as P from './parsers.js';
import { ACCOUNT_TYPES, typeOf, DEFAULT_CATEGORIES, categorize, payeeFrom, squash } from './rules.js';
import { parseSms, smsPayee, splitInbox, parseLog, SMS_PV } from './sms.js';
import { planQuestion } from './planner.js';
import { readXlsx } from './xlsx.js';
import * as AI from './ai.js';

const APP_VERSION = '1.6.6';
const DATA_VERSION = 1;
const vault = new Vault();
let D = null; // decrypted data, in memory only while unlocked
const ui = { tab: 'home', view: null, month: null, q: '', acc: '', cat: '', imp: null, ask: [], aiStatus: '' };
let hiddenAt = 0;

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nfmt2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfmt0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr = (p, dec = 2) => (p < 0 ? '−' : '') + '₹' + (dec ? nfmt2 : nfmt0).format(Math.abs(p || 0) / 100);
const inrS = (p, dec = 2) => (p > 0 ? '+' : '') + inr(p, dec);
const compact = (p) => {
  const r = Math.abs(p) / 100, s = p < 0 ? '−' : '';
  if (r >= 1e7) return `${s}₹${(r / 1e7).toFixed(2)} Cr`;
  if (r >= 1e5) return `${s}₹${(r / 1e5).toFixed(2)} L`;
  return inr(p, 0);
};
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ymOf = (iso) => iso.slice(0, 7);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MON[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
const addMonths = (ym, n) => { let y = +ym.slice(0, 4), m = +ym.slice(5) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return `${y}-${String(m + 1).padStart(2, '0')}`; };
const fmtDate = (iso, year) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d} ${MON[+m - 1]}${year ? ' ' + y : ''}`; };
const daysUntil = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 864e5);
const parseRupees = (s) => { const n = String(s).replace(/[₹,\s]/g, ''); if (!/^-?\d*(\.\d{0,2})?$/.test(n) || n === '' || n === '-') return null; return Math.round(parseFloat(n) * 100); };
const daysApart = (a, b) => Math.abs(new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5;
const initials = (s) => (String(s || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();

function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms); }
function openSheet(html) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet').classList.add('on'); $('#scrim').classList.add('on'); $('#sheet').scrollTop = 0; }
function closeSheet() { const s = $('#sheet'); s.classList.remove('on'); s.style.transform = ''; s.style.transition = ''; $('#scrim').classList.remove('on'); $('#scrim').style.opacity = ''; }
// Pull a sheet down to close it: from the handle anywhere, or from the content once it is scrolled to the top
let shS = null;
document.addEventListener('touchstart', (e) => {
  const sh = e.target.closest?.('#sheet.on'); if (!sh || e.touches.length > 1) return;
  if (e.target.closest('input,select,textarea,.esc-row,input.pp')) return;
  shS = { y: e.touches[0].clientY, x: e.touches[0].clientX, t: performance.now(), top: sh.scrollTop <= 0, grab: !!e.target.closest('.grab,h3'), dy: 0, on: false, sh };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!shS) return;
  const dy = e.touches[0].clientY - shS.y, dx = e.touches[0].clientX - shS.x;
  if (!shS.on) {
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) { shS = null; return; }
    if (dy > 6 && (shS.grab || (shS.top && shS.sh.scrollTop <= 0))) { shS.on = true; shS.sh.style.transition = 'none'; }
    else if (dy < -6) { shS = null; return; } else return;
  }
  e.preventDefault();
  shS.dy = Math.max(0, dy);
  shS.sh.style.transform = `translateY(${shS.dy}px)`;
  $('#scrim').style.opacity = String(Math.max(0, 1 - shS.dy / (shS.sh.offsetHeight || 600)));
}, { passive: false });
document.addEventListener('touchend', () => {
  if (!shS) return; const s = shS; shS = null; if (!s.on) return;
  const v = s.dy / Math.max(1, performance.now() - s.t);
  s.sh.style.transition = ''; $('#scrim').style.opacity = '';
  if (s.dy > 110 || (v > 0.6 && s.dy > 30)) { haptic(); closeSheet(); } else s.sh.style.transform = '';
});
document.addEventListener('touchcancel', () => { if (shS?.on) { shS.sh.style.transition = ''; shS.sh.style.transform = ''; $('#scrim').style.opacity = ''; } shS = null; });
const save = () => vault.save();

function newData() {
  return {
    v: DATA_VERSION, createdAt: new Date().toISOString(),
    settings: { autoLockMin: 5, lastBackupAt: null },
    accounts: [], categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), rules: [],
    transactions: [], valuations: [], imports: [], inbox: [], smsSeen: [],
  };
}
function migrate(d) {
  // Future schema upgrades go here. Add any default categories that are missing.
  const have = new Set(d.categories.map((c) => c.id));
  for (const c of DEFAULT_CATEGORIES) if (!have.has(c.id)) d.categories.push({ ...c });
  d.budgets ||= {}; if (d.sips) { delete d.sips; d.valuations = (d.valuations || []).filter((v) => !/^SIP .* added$/.test(v.note || '')); for (const x of d.transactions || []) delete x.sipTo; } d.inbox ||= []; d.smsSeen ||= []; d.bills ||= []; d.receipts ||= []; d.vault ||= [];
  d.settings.ai ||= { model: null }; d.holdings ||= [];
  // Older versions read the date in a Shortcut log as the amount (e.g. ₹2,026): drop those so the log is read again
  if (!d.settings.logFix3) { d.transactions = d.transactions.filter((x) => !(x.source === 'log' && !x.catManual && x.amount % 100 === 0 && Math.abs(x.amount) / 100 >= 1990 && Math.abs(x.amount) / 100 <= 2100)); d.settings.logFix3 = true; }
  if (!d.members?.length) {
    const holder = d.accounts.map((a) => a.statement?.holder).find(Boolean);
    d.members = [{ id: 'me', name: holder ? holder.split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase()).replace(/(?<=^.).*/, (r) => r.toLowerCase()) : 'Me' }];
  }
  d.settings.who ||= 'all';
  if (d.settings.loansSeparate === undefined) d.settings.loansSeparate = true;
  d.v = DATA_VERSION;
  return d;
}

// ---------- derived data ----------
const accById = (id) => D.accounts.find((a) => a.id === id);
const catById = (id) => D.categories.find((c) => c.id === id);
const catName = (id) => catById(id)?.name || 'Uncategorised';
const accShort = (a) => a ? a.name + (a.last4 ? ' ••' + a.last4 : '') : '';

function latestValuation(accId) {
  let best = null;
  for (const v of D.valuations) if (v.accountId === accId && (!best || v.date > best.date || (v.date === best.date && v.at > best.at))) best = v;
  return best;
}
// Signed balance: assets positive, money owed negative
function balance(a) {
  const t = typeOf(a.type);
  if (t.mode === 'ledger') {
    let b = a.opening?.amount || 0;
    for (const x of D.transactions) if (x.accountId === a.id) b += x.amount;
    return b;
  }
  const hs = D.holdings?.filter((h) => h.accountId === a.id);
  if (hs?.length) return hs.reduce((s2, h) => s2 + holdValue(h), 0);
  const v = latestValuation(a.id)?.value || 0;
  return t.side === 'liability' ? -v : v;
}
const holdValue = (h) => h.qty != null ? Math.round(h.qty * h.price) : (h.value || 0);
const holdCost = (h) => h.qty != null ? Math.round(h.qty * h.avg) : (h.cost || 0);
function holdingsCard(a) {
  const hs = D.holdings.filter((h) => h.accountId === a.id).map((h) => ({ ...h, value: holdValue(h), cost: holdCost(h) })).sort((x, y) => y.value - x.value);
  if (!hs.length) return '';
  const val = hs.reduce((t, h) => t + h.value, 0), cost = hs.reduce((t, h) => t + h.cost, 0), pl = val - cost;
  const live = hs.filter((h) => h.prevClose && h.qty != null && h.type !== 'mf' && h.priceDate === todayIso());
  const dayChg = live.reduce((t, h) => t + Math.round(h.qty * (h.price - h.prevClose)), 0);
  const dayBase = live.reduce((t, h) => t + Math.round(h.qty * h.prevClose), 0);
  const pct = (p, c) => c ? `${p >= 0 ? '+' : ''}${(p / c * 100).toFixed(1)}%` : '';
  return `<div class="card"><h2>Holdings · ${hs.length}</h2>
    <div class="split"><div><div class="small muted">Invested</div><div class="mid num">${inr(cost, 0)}</div></div>
    <div><div class="small muted">Profit / loss</div><div class="mid num ${pl >= 0 ? 'in' : 'bad'}">${inrS(pl, 0)} <span class="small">${pct(pl, cost)}</span></div></div></div>
    ${live.length ? `<p class="small" style="margin:8px 0 0">Today: <b class="num ${dayChg >= 0 ? 'in' : 'bad'}">${chgTxt(dayChg, dayBase)}</b></p>` : ''}
    ${hs.some((h) => h.type === 'stock' || h.type === 'etf') && !D.settings.priceRelay ? `<p class="small" style="margin:8px 0 0"><button class="link" data-act="stocksSheet">Turn on live stock prices</button></p>` : ''}
    ${hs.some((h) => h.type !== 'mf' && h.priceAt) ? `<p class="small muted" style="margin:8px 0 0">${D.settings.priceRelay ? 'Live prices' : 'Prices about 15 minutes delayed'} · as of ${new Date(hs.filter((h) => h.priceAt).map((h) => h.priceAt).sort().pop()).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Tap 🔄 to update.</p>` : hs.some((h) => h.type === 'mf' && h.qty != null) ? `<p class="small muted" style="margin:8px 0 0">NAVs update automatically each day. ${a.navCheckedAt ? 'Last checked ' + new Date(a.navCheckedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + '.' : ''} <button class="link" data-act="refreshNav" data-id="${a.id}">Refresh now</button></p>` : `<p class="small muted" style="margin:8px 0 0">Values as on ${fmtDate(a.holdingsAsOn, true)}. Upload a newer statement to refresh.</p>`}</div>
    <div class="list">${hs.map((h) => `<div class="item"><div class="ico">${esc(initials(h.symbol))}</div>
      <div class="grow"><div class="t">${esc(h.symbol)} ${h.type !== 'stock' ? `<span class="badge">${h.type.toUpperCase()}</span>` : ''}</div><div class="s">${h.qty != null && h.type === 'mf' ? `${(+h.qty.toFixed(3)).toLocaleString('en-IN')} units × NAV ₹${(h.price / 100).toFixed(4)} (${fmtDate(h.priceDate)})` : h.qty != null ? `${+h.qty.toFixed(3)} × ${inr(Math.round(h.price))} · avg ${inr(Math.round(h.avg), 0)}` : `${h.folio ? 'Folio ' + esc(h.folio) : ''}${h.xirr != null ? ` · XIRR ${h.xirr}%` : ''}`}</div></div>
      <div style="text-align:right"><div class="a num">${inr(h.value, 0)}</div><div class="tiny num ${h.value >= h.cost ? 'in' : 'bad'}">${inrS(h.value - h.cost, 0)} · ${pct(h.value - h.cost, h.cost)}</div>${h.prevClose && h.type !== 'mf' ? `<div class="tiny num ${h.price >= h.prevClose ? 'in' : 'bad'}">today ${h.price >= h.prevClose ? '+' : ''}${((h.price / h.prevClose - 1) * 100).toFixed(2)}%</div>` : ''}</div></div>`).join('')}</div>`;
}
// Card EMIs still to be billed (not yet in the statement balance) are real debt
const unbilledEmi = (a) => (a.type === 'credit_card' ? (a.statement?.emiLoans || []).reduce((s, l) => s + (l.principalLeft || 0), 0) : 0);

// ---------- household ----------
const ownerOf = (a) => a.owner || 'me';
const memberName = (id) => id === 'joint' ? 'Joint' : D.members.find((m) => m.id === id)?.name || 'Me';
const multi = () => D.members.length > 1;
// Share of an account that belongs to the person being viewed: joint accounts count half in each person's view
function shareOf(a, who = D.settings.who) {
  if (!multi() || who === 'all') return 1;
  const o = ownerOf(a);
  return o === who ? 1 : o === 'joint' ? 0.5 : 0;
}
const accVisible = (a, who = D.settings.who) => shareOf(a, who) > 0;
function whoSwitch() {
  if (!multi()) return '';
  const opts = [['all', 'Combined'], ...D.members.map((m) => [m.id, m.name])];
  const idx = Math.max(0, opts.findIndex((o) => o[0] === D.settings.who));
  return `<div class="whoseg" role="group" aria-label="Whose money" style="grid-template-columns:repeat(${opts.length},minmax(0,1fr))"><span class="pill" data-to="${idx}" style="width:calc((100% - 6px) / ${opts.length});transform:translateX(${(ui.whoFrom ?? idx) * 100}%)"></span>${opts.map(([id, n]) => `<button class="${D.settings.who === id ? 'on' : ''}" data-act="setWho" data-who="${id}" aria-pressed="${D.settings.who === id}">${esc(n)}</button>`).join('')}</div>`;
}
function ownerOptions(sel) {
  return [...D.members.map((m) => [m.id, m.name]), ['joint', 'Joint']].map(([id, n]) => `<option value="${id}" ${id === (sel || 'me') ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
// Guess who a statement belongs to from the holder name printed on it
function ownerFromName(name) {
  if (!name || !multi()) return 'me';
  const first = name.trim().split(/\s+/)[0].toLowerCase();
  return D.members.find((m) => m.name.toLowerCase().split(/\s+/)[0] === first)?.id || 'me';
}

// Loans (home, car, personal, EMI) can be kept out of net worth and shown on their own
const inNetWorth = (a) => !(D.settings.loansSeparate && isLoanType(a.type));
function loansTotal(who = D.settings.who) {
  return D.accounts.filter((a) => !a.archived && isLoanType(a.type) && shareOf(a, who) > 0).reduce((t, a) => t + Math.round(balance(a) * shareOf(a, who)), 0);
}
function netWorth(who = D.settings.who) {
  let assets = 0, liabilities = 0;
  for (const a of D.accounts) {
    if (a.archived || !inNetWorth(a)) continue;
    const sh = shareOf(a, who); if (!sh) continue;
    const b = Math.round((balance(a) - unbilledEmi(a)) * sh);
    if (b >= 0 && typeOf(a.type).side === 'asset') assets += b; else liabilities += b;
  }
  return { assets, liabilities, net: assets + liabilities };
}

// ---------- history & charts ----------
// Net worth on past days is rebuilt from your data: bank and card balances by walking transactions back,
// loans and other values from their dated entries. Market value of holdings can't be rebuilt, so Ledger
// keeps one figure per holdings account per day (and points through today, for the 1D chart) on every refresh.
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoAdd = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
const holdAccs = () => D.accounts.filter((a) => !a.archived && D.holdings.some((h) => h.accountId === a.id));
function recordPrices() {
  if (!D) return;
  const today = todayIso(), now = Date.now();
  D.priceHist ||= {};
  const row = {};
  for (const a of holdAccs()) row[a.id] = balance(a);
  if (!Object.keys(row).length) return;
  D.priceHist[today] = row;
  const days = Object.keys(D.priceHist).sort();
  while (days.length > 1200) delete D.priceHist[days.shift()];
  if (D.intraday?.date !== today) D.intraday = { date: today, pts: [] };
  const last = D.intraday.pts[D.intraday.pts.length - 1];
  const same = last && Object.keys(row).every((k) => last[1][k] === row[k]);
  if (!last || (!same && now - last[0] > 30e3)) D.intraday.pts.push([now, row]);
  else if (!same) last[1] = row; // several refreshes within 30s: keep the newest
  if (D.intraday.pts.length > 400) D.intraday.pts.splice(1, D.intraday.pts.length - 400);
}
// Value of a holdings account at the end of a past day
function holdValueOn(a, date) {
  const days = Object.keys(D.priceHist || {}).filter((d) => d <= date && D.priceHist[d][a.id] != null).sort();
  if (days.length) return D.priceHist[days[days.length - 1]][a.id];
  const v = D.valuations.filter((x) => x.accountId === a.id && x.date <= date).sort((p, q) => p.date.localeCompare(q.date) || p.at - q.at).pop();
  if (v) return v.value;
  // Nothing recorded that far back: yesterday's close where we have it, otherwise today's value
  return D.holdings.filter((h) => h.accountId === a.id).reduce((t, h) => t + (h.qty != null && h.prevClose && h.type !== 'mf' ? Math.round(h.qty * h.prevClose) : holdValue(h)), 0);
}
function valueOn(a, date) {
  const t = typeOf(a.type);
  if (D.holdings.some((h) => h.accountId === a.id)) return holdValueOn(a, date);
  const vs = D.valuations.filter((x) => x.accountId === a.id).sort((p, q) => p.date.localeCompare(q.date) || p.at - q.at);
  const v = vs.filter((x) => x.date <= date).pop() || vs[0];
  const val = v?.value || 0;
  return t.side === 'liability' ? -val : val;
}
// Daily series of net worth (or of one account) for the given dates, oldest first
function seriesFor(dates, { who = D.settings.who, accId = null } = {}) {
  const today = todayIso();
  const accs = D.accounts.filter((a) => (accId ? a.id === accId : !a.archived && inNetWorth(a) && shareOf(a, who) > 0));
  const sh = (a) => (accId ? 1 : shareOf(a, who));
  const ledger = accs.filter((a) => typeOf(a.type).mode === 'ledger');
  const other = accs.filter((a) => typeOf(a.type).mode !== 'ledger');
  const lshare = new Map(ledger.map((a) => [a.id, sh(a)]));
  let run = ledger.reduce((t, a) => t + (balance(a) - unbilledEmi(a)) * sh(a), 0);
  const byDay = new Map();
  for (const x of D.transactions) if (lshare.has(x.accountId)) byDay.set(x.date, (byDay.get(x.date) || 0) + x.amount * lshare.get(x.accountId));
  for (const [d, v] of byDay) if (d > today) run -= v;
  const lv = new Map();
  let cur = today;
  const first = dates[0];
  while (cur >= first) { lv.set(cur, run); run -= byDay.get(cur) || 0; cur = isoAdd(cur, -1); }
  return dates.map((d) => {
    let v = lv.get(d) ?? 0;
    for (const a of other) v += (d >= today ? balance(a) - unbilledEmi(a) : valueOn(a, d)) * sh(a);
    return Math.round(v);
  });
}
const RANGES = [['1D', 1], ['1W', 7], ['1M', 30], ['3M', 91], ['1Y', 365], ['All', 0]];
function chartData(range, opts = {}) {
  const today = todayIso();
  if (range === '1D') {
    const base = seriesFor([isoAdd(today, -1)], opts)[0];
    const now = seriesFor([today], opts)[0];
    const accs = new Set(holdAccs().filter((a) => (opts.accId ? a.id === opts.accId : shareOf(a, opts.who ?? D.settings.who) > 0)).map((a) => a.id));
    const hNow = holdAccs().reduce((t, a) => t + (accs.has(a.id) ? balance(a) * (opts.accId ? 1 : shareOf(a, opts.who ?? D.settings.who)) : 0), 0);
    const pts = (D.intraday?.date === today ? D.intraday.pts : []).map(([t, row]) => {
      const h = Object.entries(row).reduce((s2, [id, v]) => s2 + (accs.has(id) ? v * (opts.accId ? 1 : shareOf(accById(id) || {}, opts.who ?? D.settings.who)) : 0), 0);
      return { t, v: Math.round(now - hNow + h) };
    });
    const open = new Date(today + 'T09:15:00').getTime();
    const out = [{ t: Math.min(open, pts[0]?.t ?? open), v: base, label: 'Yesterday' }, ...pts];
    if (!pts.length || Date.now() - pts[pts.length - 1].t > 60e3) out.push({ t: Date.now(), v: now });
    return out.map((p) => ({ ...p, label: p.label || new Date(p.t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) }));
  }
  let days = RANGES.find((r) => r[0] === range)?.[1] ?? 30;
  if (!days) {
    const firstTx = D.transactions.reduce((m2, x) => (x.date < m2 ? x.date : m2), today);
    const firstVal = D.valuations.reduce((m2, x) => (x.date < m2 ? x.date : m2), today);
    days = Math.max(30, Math.round((new Date(today) - new Date(firstTx < firstVal ? firstTx : firstVal)) / 864e5) + 1);
  }
  const step = days > 400 ? 7 : 1;
  const dates = [];
  for (let i = days; i > 0; i -= step) dates.push(isoAdd(today, -i));
  dates.push(today);
  return seriesFor(dates, opts).map((v, i) => ({ v, label: fmtDate(dates[i], days > 300) }));
}
const pctTxt = (chg, base) => (base ? `${chg >= 0 ? '+' : '−'}${Math.abs(chg / Math.abs(base) * 100).toFixed(2)}%` : '');
const chgTxt = (chg, base) => `${chg >= 0 ? '+' : '−'}${inr(Math.abs(chg), 0)}${base ? ` (${pctTxt(chg, base)})` : ''}`;
const RANGE_WORD = { '1D': 'today', '1W': 'past week', '1M': 'past month', '3M': 'past 3 months', '1Y': 'past year', All: 'all time' };
// A line chart with range chips, change in green/red, and touch to read any point
function chartCard(key, opts = {}) {
  const range = (D.settings.chartRange ||= {})[key] || '1M';
  const pts = chartData(range, opts);
  const first = pts[0].v, last = pts[pts.length - 1].v, chg = last - first, up = chg >= 0;
  const W = 340, H = 120, pad = 6;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi === lo) { hi += 100; lo -= 100; }
  const xOf = (i) => (pts.length === 1 ? W : (i / (pts.length - 1)) * W);
  const yOf = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
  const col = up ? 'var(--in)' : 'var(--bad)';
  ui.charts ||= {}; ui.charts[key] = { pts, first };
  return `<div class="chart" data-chart="${key}">
    <div class="chg num ${up ? 'in' : 'bad'}" data-chg>${chgTxt(chg, first)} <span class="muted small">${RANGE_WORD[range]}</span></div>
    <div class="cwrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Chart, ${RANGE_WORD[range]}">
      <defs><linearGradient id="g-${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".14"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${yOf(first).toFixed(1)}" y2="${yOf(first).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
      <path d="${line}L${W},${H}L0,${H}Z" fill="url(#g-${key})"/>
      <path d="${line}" ${ui.draw ? 'class="draw" pathLength="1"' : ''} fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg><i class="cur" hidden></i></div>
    <div class="row tiny muted" style="justify-content:space-between;margin-top:2px"><span>${esc(pts[0].label)}</span><span data-at></span><span>${range === '1D' ? 'Now' : 'Today'}</span></div>
    <div class="chips rng rngu">${RANGES.map(([r]) => `<button class="chip ${r === range ? 'on' : ''}" data-act="chartRange" data-key="${key}" data-r="${r}" aria-pressed="${r === range}">${r}</button>`).join('')}<span class="u" style="width:${100 / RANGES.length}%;transform:translateX(${RANGES.findIndex((x) => x[0] === range) * 100}%)"></span></div></div>`;
}
// Touch or drag across a chart to read the value and change at that point
function chartTouch(e) {
  const box = e.target.closest?.('.chart .cwrap'); if (!box) return;
  const el = box.closest('.chart'), c = ui.charts?.[el.dataset.chart]; if (!c) return;
  const pt = e.touches?.[0] || e;
  const r = box.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (pt.clientX - r.left) / r.width));
  const i = Math.round(f * (c.pts.length - 1)), p = c.pts[i];
  const chg = p.v - c.first;
  const cur = box.querySelector('.cur'); cur.hidden = false; cur.style.left = `${(c.pts.length === 1 ? 1 : i / (c.pts.length - 1)) * 100}%`;
  const big = el.parentElement.querySelector('[data-nwval]'); if (big) { big.dataset.keep ||= big.textContent; big.textContent = inr(p.v, 0); }
  el.querySelector('[data-at]').textContent = p.label;
  const ch = el.querySelector('[data-chg]'); ch.className = `chg num ${chg >= 0 ? 'in' : 'bad'}`; ch.innerHTML = `${chgTxt(chg, c.first)} <span class="muted small">to ${esc(p.label)}</span>`;
}
function chartRelease() {
  document.querySelectorAll('.chart .cur').forEach((x) => { x.hidden = true; });
  document.querySelectorAll('[data-nwval][data-keep]').forEach((b) => { b.textContent = b.dataset.keep; delete b.dataset.keep; });
}
// Today's market move across visible holdings (stocks and ETFs with live prices)
function marketsToday(accId) {
  const live = D.holdings.filter((h) => h.prevClose && h.qty != null && h.type !== 'mf' && h.priceDate === todayIso() && (accId ? h.accountId === accId : shareOf(accById(h.accountId) || {}) > 0));
  if (!live.length) return null;
  const chg = live.reduce((t, h) => t + Math.round(h.qty * (h.price - h.prevClose) * (accId ? 1 : shareOf(accById(h.accountId)))), 0);
  const base = live.reduce((t, h) => t + Math.round(h.qty * h.prevClose * (accId ? 1 : shareOf(accById(h.accountId)))), 0);
  return { chg, base };
}

// ---------- subscriptions & reminders ----------
// D.bills: { id, name, kind: 'subscription'|'reminder', amount (paise, 0 = none), every: 'month'|'quarter'|'year'|'week'|'once',
//            next: 'YYYY-MM-DD', match: words that identify its payments, accountId, remind: days before, note, lastPaid }
const EVERY = { week: 'Weekly', month: 'Monthly', quarter: 'Every 3 months', year: 'Yearly', once: 'Once' };
const perMonth = (b) => ({ week: 52 / 12, month: 1, quarter: 1 / 3, year: 1 / 12, once: 0 }[b.every] || 0) * (b.amount || 0);
function advance(iso, every, day) {
  const d = new Date(iso + 'T00:00:00');
  if (every === 'week') { d.setDate(d.getDate() + 7); return isoOf(d); }
  const months = every === 'quarter' ? 3 : every === 'year' ? 12 : 1;
  const want = day || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + months, 1);
  t.setDate(Math.min(want, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return isoOf(t);
}
const SUB_MERCHANTS = /apple|itunes|netflix|spotify|youtube|google ?(play|one|storage)|hotstar|prime|sonyliv|zee5|jiocinema|audible|kindle|microsoft|office ?365|xbox|playstation|adobe|canva|notion|dropbox|icloud|chatgpt|openai|anthropic|claude|linkedin|tinder|bumble|cult\.?fit|swiggy one|zomato gold|times prime|economic times|hindu|medium|substack|patreon/i;
const payeeKey = (x) => (x.payee || x.description || '').trim();
const billMatches = (b, x) => {
  const words = (b.match || b.name).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const hay = `${x.payee} ${x.description} ${x.raw || ''}`.toLowerCase();
  return words.length && words.every((w) => hay.includes(w));
};
// Payments that look like subscriptions: a known subscription merchant, or the same payee at a similar amount about once a month
function detectSubs() {
  const vis = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  const since = isoAdd(todayIso(), -400);
  const groups = new Map();
  for (const x of D.transactions) {
    if (x.amount >= 0 || x.date < since || !vis.has(x.accountId)) continue;
    const k = catById(x.categoryId)?.kind; if (k === 'transfer' || k === 'income') continue;
    let key = payeeKey(x); if (!key || /^(upi payment|card payment|money received|sms)$/i.test(key)) continue;
    // Group a known service under its name, however the statement or SMS spells it ("Apple Medi", "APPLE MEDIA SERVICES")
    const km = `${key} ${x.description}`.match(SUB_MERCHANTS); if (km) key = km[0].replace(/^./, (c) => c.toUpperCase());
    (groups.get(key) || groups.set(key, []).get(key)).push(x);
  }
  const dismissed = new Set(D.settings.subDismissed || []);
  const out = [];
  for (const [key, xs] of groups) {
    if (dismissed.has(key) || (D.bills || []).some((b) => xs.some((x) => billMatches(b, x)))) continue;
    xs.sort((a, b) => a.date.localeCompare(b.date));
    const last = xs[xs.length - 1], amt = -last.amount;
    const similar = xs.filter((x) => Math.abs(-x.amount - amt) <= amt * 0.15);
    const months = new Set(similar.map((x) => ymOf(x.date)));
    const known = SUB_MERCHANTS.test(`${key} ${last.description}`) || last.categoryId === 'subscriptions';
    let every = null;
    if (months.size >= 2) {
      const gaps = similar.slice(1).map((x, i) => daysUntil(x.date) - daysUntil(similar[i].date)).filter((g) => g > 5);
      const avg = gaps.length ? gaps.reduce((t, g) => t + g, 0) / gaps.length : 0;
      if (avg >= 24 && avg <= 38 && similar.length <= months.size + 1) every = 'month';
      else if (avg >= 80 && avg <= 100) every = 'quarter';
      else if (avg >= 340 && avg <= 390) every = 'year';
    }
    if (!every && known && amt <= 1000000) every = 'month';
    if (!every) continue;
    let next = advance(last.date, every);
    while (next < todayIso()) next = advance(next, every);
    out.push({ key, name: SUB_MERCHANTS.test(key) ? key : payeeKey(last), amount: amt, every, next, accountId: last.accountId, count: similar.length, last: last.date, known });
  }
  return out.sort((a, b) => perMonth(b) - perMonth(a));
}
// Move each bill's next date past payments that have arrived, and past dates already gone for reminders with no amount to match
function processBills() {
  let changed = false;
  for (const b of D.bills || []) {
    if (b.every === 'once' || !b.next) continue;
    const day = b.day || +b.next.slice(8);
    if (b.kind === 'subscription') {
      // The newest matching payment since the last one we knew of moves the next date on from it
      const after = b.lastPaid || isoAdd(b.next, -10);
      const paid = D.transactions.filter((x) => x.amount < 0 && x.date > after && billMatches(b, x) && (!b.amount || Math.abs(-x.amount - b.amount) <= b.amount * 0.25)).sort((p, q) => p.date.localeCompare(q.date)).pop();
      if (paid) { b.lastPaid = paid.date; b.amount = -paid.amount; b.day = +paid.date.slice(8); b.next = advance(paid.date, b.every, b.day); changed = true; }
    }
  }
  return changed;
}
const dueWord = (iso) => { const d = daysUntil(iso); return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 0 ? `${-d} day${d < -1 ? 's' : ''} ago` : `in ${d} days`; };
function billItem(b) {
  const d = daysUntil(b.next);
  return `<button class="item" data-act="billSheet" data-id="${b.id}"><div class="ico">${esc(initials(b.name))}</div>
    <div class="grow"><div class="t">${esc(b.name)}</div><div class="s">${EVERY[b.every]} · ${b.every === 'once' && d < 0 ? 'was ' : 'next '}${fmtDate(b.next, true)} (${dueWord(b.next)})${b.accountId && accById(b.accountId) ? ' · ' + esc(accShort(accById(b.accountId))) : ''}</div></div>
    <div style="text-align:right">${b.amount ? `<div class="a num">${inr(b.amount, 0)}</div>` : ''}<div class="tiny ${d < 0 ? 'bad' : d <= (b.remind ?? 1) ? 'warn' : 'muted'}">${d < 0 ? 'overdue' : d <= (b.remind ?? 1) ? 'due soon' : ''}</div></div></button>`;
}
function upcomingCard() {
  const soon = (D.bills || []).filter((b) => b.next && daysUntil(b.next) <= Math.max(7, b.remind || 0) && daysUntil(b.next) >= (b.every === 'once' ? -3 : -30)).sort((p, q) => p.next.localeCompare(q.next));
  const subs = (D.bills || []).filter((b) => b.kind === 'subscription');
  const found = D.settings.subsSeen ? 0 : detectSubs().length;
  if (!soon.length && !subs.length && !found) return '';
  return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Bills &amp; subscriptions</h2><button class="link" data-act="openBills">See all ›</button></div>
    ${subs.length ? `<p class="small muted" style="margin:6px 0 0">${subs.length} subscription${subs.length > 1 ? 's' : ''} · ${inr(subs.reduce((t, b) => t + perMonth(b), 0), 0)} a month</p>` : ''}
    ${found ? `<p class="small" style="margin:6px 0 0"><button class="link" data-act="openBills">${found} possible subscription${found > 1 ? 's' : ''} found in your spending ›</button></p>` : ''}
    ${soon.length ? `<div class="list" style="margin:8px -4px 0">${soon.slice(0, 4).map(billItem).join('')}</div>` : ''}</div>`;
}
function renderBills(m) {
  setTop('Bills & subscriptions', { back: 'closeView' });
  if (processBills()) save();
  D.settings.subsSeen = true;
  const found = detectSubs();
  const subs = (D.bills || []).filter((b) => b.kind === 'subscription').sort((p, q) => p.next.localeCompare(q.next));
  const rems = (D.bills || []).filter((b) => b.kind !== 'subscription').sort((p, q) => p.next.localeCompare(q.next));
  m.innerHTML = `
  ${found.length ? `<div class="day"><span>Found in your spending</span></div><div class="list">${found.map((f, i) => `<div class="item" style="display:block"><div class="row"><div class="grow"><div class="t">${esc(f.name)}</div><div class="s">${inr(f.amount, 0)} · looks ${EVERY[f.every].toLowerCase()} · ${f.count > 1 ? `${f.count} payments, last ${fmtDate(f.last)}` : `paid ${fmtDate(f.last)}`}</div></div></div>
      <div class="row" style="margin-top:8px"><button class="chip on" data-act="subAdd" data-i="${i}">Add</button><button class="chip" data-act="subNo" data-key="${esc(f.key)}">Not a subscription</button></div></div>`).join('')}</div>` : ''}
  <div class="day"><span>Subscriptions${subs.length ? ' · ' + inr(subs.reduce((t, b) => t + perMonth(b), 0), 0) + ' a month' : ''}</span></div>
  <div class="list">${subs.map(billItem).join('')}<button class="item" data-act="billSheet" data-kind="subscription"><div class="grow" style="color:var(--brand)">+ Add a subscription</div></button></div>
  <div class="day"><span>Reminders</span></div>
  <div class="list">${rems.map(billItem).join('')}<button class="item" data-act="billSheet" data-kind="reminder"><div class="grow" style="color:var(--brand)">+ Add a reminder</div></button></div>
  <p class="small muted" style="margin:10px 4px">Subscriptions move to their next date by themselves when the payment shows up from a statement or SMS. Reminders are yours to set: pick the date and how often, and tap <b>Mark done</b> when it's handled. Add any of them to your iPhone Calendar to get an alert.</p>`;
  ui.found = found;
}
function billSheet(b, kind = 'reminder', pre = {}) {
  const x = b || { kind, every: 'month', next: todayIso(), remind: 1, ...pre };
  const isSub = x.kind === 'subscription';
  openSheet(`<h3>${b ? 'Edit' : 'Add'} ${isSub ? 'subscription' : 'reminder'}</h3>
  <form data-form="bill" data-id="${b?.id || ''}" data-kind="${x.kind}">
    <label class="f"><span>Name</span><input class="i" name="name" required value="${esc(x.name || '')}" placeholder="${isSub ? 'Apple' : 'Car insurance renewal'}"></label>
    <label class="f"><span>Amount (₹)${isSub ? '' : ', optional'}</span><input class="i num" name="amount" inputmode="decimal" ${isSub ? 'required' : ''} value="${x.amount ? x.amount / 100 : ''}"></label>
    <div class="split"><label class="f"><span>Repeats</span><select class="i" name="every">${Object.entries(EVERY).filter(([k]) => !isSub || k !== 'once').map(([k, v]) => `<option value="${k}" ${k === x.every ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="f"><span>${isSub ? 'Next payment' : 'Date'}</span><input class="i" type="date" name="next" required value="${x.next}"></label></div>
    <label class="f"><span>Remind me</span><select class="i" name="remind">${[[0, 'On the day'], [1, '1 day before'], [3, '3 days before'], [7, 'A week before'], [15, '15 days before'], [30, 'A month before']].map(([v, l]) => `<option value="${v}" ${+v === +(x.remind ?? 1) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="f"><span>Paid from (optional)</span><select class="i" name="accountId"><option value="">Not set</option>${accOptions(x.accountId)}</select></label>
    ${isSub ? `<label class="f"><span>Payments contain</span><input class="i" name="match" value="${esc(x.match || '')}" placeholder="apple" autocapitalize="off"></label><p class="tiny muted" style="margin-top:-6px">Words from the payee on your statement or SMS, so Ledger can tick it off when it's paid. Leave empty to use the name.</p>` : ''}
    <label class="f"><span>Note</span><input class="i" name="note" value="${esc(x.note || '')}"></label>
    <button class="btn wide">Save</button>
  </form>
  ${b ? `<div style="height:10px"></div>${b.kind !== 'subscription' ? `<button class="btn wide ghost" data-act="billDone" data-id="${b.id}">Mark done${b.every !== 'once' ? ' (move to next date)' : ''}</button><div style="height:10px"></div>` : ''}
    <button class="btn wide ghost" data-act="billCal" data-id="${b.id}">Add to iPhone Calendar</button><div style="height:10px"></div>
    <button class="btn wide danger" data-act="billDelete" data-id="${b.id}">Delete</button>` : ''}`);
}
// A calendar event with an alert, repeating like the bill; iPhone offers "Add to Calendar"
function billIcs(b) {
  const dt = b.next.replace(/-/g, ''), end = isoAdd(b.next, 1).replace(/-/g, '');
  const rule = { week: 'FREQ=WEEKLY', month: 'FREQ=MONTHLY', quarter: 'FREQ=MONTHLY;INTERVAL=3', year: 'FREQ=YEARLY' }[b.every];
  const txt = (s) => String(s).replace(/[\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const title = `${b.name}${b.amount ? ' · ' + inr(b.amount, 0).replace('₹', 'Rs ') : ''}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ledger//EN', 'BEGIN:VEVENT', `UID:${b.id}@ledger`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${txt(title)}`, ...(b.note ? [`DESCRIPTION:${txt(b.note)}`] : []), ...(rule ? [`RRULE:${rule}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${txt(title)}`, `TRIGGER:${b.remind ? `-P${b.remind - 1}DT15H` : 'PT9H'}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

// ---------- quick add ----------
function recentPayees() {
  const seen = new Map();
  for (const x of [...D.transactions].sort((a, b) => b.date.localeCompare(a.date))) {
    if (x.amount >= 0 || !x.payee || ['transfer', 'income'].includes(catById(x.categoryId)?.kind)) continue;
    const k = x.payee.trim(); if (/^(upi payment|card payment|money received|sms)$/i.test(k)) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
    if (seen.size >= 30) break;
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
}
function quickAdd(pre = {}) {
  ui.qa = { amt: '', payee: '', via: 'upi', cat: '', date: todayIso(), files: [], ...pre };
  renderQuick();
}
function renderQuick() {
  const q = ui.qa, acc = payAccount(q.via, false);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  openSheet(`<h3>Quick add</h3>
  <div class="qa-amt num" aria-live="polite"><span class="cur">₹</span>${esc(q.amt ? Number(q.amt.replace(/\.$/, '')).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + (q.amt.endsWith('.') ? '.' : '') : '0')}</div>
  <div class="qa-keys">${keys.map((k) => `<button type="button" class="qa-k" data-act="qaKey" data-k="${k}" aria-label="${k === '⌫' ? 'Delete' : k}">${k}</button>`).join('')}</div>
  <label class="f" style="margin-top:12px"><span>What for</span><input class="i" id="qaPayee" value="${esc(q.payee)}" placeholder="Groceries, chai, petrol…" autocomplete="off"></label>
  <div class="chips">${recentPayees().map((p) => `<button type="button" class="chip ${p === q.payee ? 'on' : ''}" data-act="qaPayee" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>
  <div class="seg" role="group" aria-label="Paid from">${[['upi', 'Savings' + (payAccount('upi', false)?.last4 ? ' ••' + payAccount('upi', false).last4 : '')], ['card', 'Card' + (payAccount('card', false)?.last4 ? ' ••' + payAccount('card', false).last4 : '')], ['cash', 'Cash']].map(([v, l]) => `<button type="button" class="${q.via === v ? 'on' : ''}" data-act="qaVia" data-v="${v}" aria-pressed="${q.via === v}">${l}</button>`).join('')}</div>
  <p class="tiny muted" style="margin:6px 2px 10px">${acc ? 'From ' + esc(accShort(acc)) : q.via === 'cash' ? 'A Cash wallet account will be created' : 'No account set for this yet'} · <button class="link tiny" type="button" data-act="payWithSheet">Change</button></p>
  <div class="split">
    <label class="f"><span>Category</span><select class="i" id="qaCat">${catOptions(q.cat || guessCategory(q.payee || '', -1) || '')}</select></label>
    <label class="f"><span>Date</span><input class="i" type="date" id="qaDate" value="${q.date}"></label>
  </div>
  <div class="row" style="margin:0 0 12px"><button type="button" class="btn ghost" style="flex:1" data-act="qaAttach">📎 ${q.files.length ? q.files.length + ' receipt' + (q.files.length > 1 ? 's' : '') : 'Receipt'}</button><button type="button" class="btn ghost" style="flex:1" data-act="qaMore">More options</button></div>
  <button class="btn wide" data-act="qaSave">Add ${q.amt ? inr(Math.round(parseFloat(q.amt) * 100), 0) : ''}</button>`);
  const pi = $('#qaPayee');
  pi?.addEventListener('input', (e) => { q.payee = e.target.value; const g = guessCategory(q.payee, -1); if (g && !q.catTouched) $('#qaCat').value = g; });
  $('#qaCat')?.addEventListener('change', (e) => { q.cat = e.target.value; q.catTouched = true; });
  $('#qaDate')?.addEventListener('change', (e) => { q.date = e.target.value; });
}
async function qaSave() {
  const q = ui.qa; const amt = Math.round(parseFloat(q.amt || '0') * 100);
  if (!amt) return toast('Enter an amount');
  q.payee = ($('#qaPayee')?.value || q.payee).trim() || 'Expense';
  const acc = payAccount(q.via); if (!acc) return toast('Set which account UPI payments come from first');
  const cat = $('#qaCat')?.value || guessCategory(q.payee, -amt) || null;
  const x = { id: uid(), accountId: acc.id, date: q.date || todayIso(), amount: -amt, payee: q.payee, description: q.payee, categoryId: cat, notes: '', raw: '', hash: 'manual|' + uid(), source: 'manual', importId: null, ref: null, time: new Date().toTimeString().slice(0, 5) };
  D.transactions.push(x);
  for (const f of q.files) await saveReceipt(f, { txId: x.id, title: q.payee, date: x.date, categoryId: cat });
  ui.qa = null; save(); closeSheet(); render(); done(`Added ${inr(amt, 0)}`);
}

// ---------- receipts & bills ----------
// Photos are shrunk to about 1600 px and stored encrypted, each on its own; PDFs are kept as they are.
async function prepFile(file) {
  if (/^image\//.test(file.type) && !/gif|svg/.test(file.type)) {
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', name: file.name.replace(/\.\w+$/, '') + '.jpg' };
    } catch (e) { console.warn('Could not shrink image', e); }
  }
  if (file.size > 15 * 1024 * 1024) throw new Error('That file is over 15 MB.');
  return { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || 'application/octet-stream', name: file.name };
}
async function saveReceipt(file, meta) {
  const p = await prepFile(file);
  const id = uid();
  await vault.putFile(id, p.bytes);
  D.receipts.push({ id, name: p.name, type: p.type, size: p.bytes.length, addedAt: new Date().toISOString(), date: meta.date || todayIso(), title: meta.title || p.name, categoryId: meta.categoryId || null, txId: meta.txId || null, note: meta.note || '' });
  return id;
}
async function receiptFile(r) { const b = await vault.getFile(r.id); return b ? new File([b], r.name, { type: r.type }) : null; }
function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res([...i.files]); i.click();
  });
}
const receiptsFor = (txId) => D.receipts.filter((r) => r.txId === txId);
function receiptThumbs(list) {
  return list.length ? `<div class="rc-row">${list.map((r) => `<button type="button" class="rc-chip" data-act="openReceipt" data-id="${r.id}">${/^image/.test(r.type) ? '🖼' : '📄'} ${esc(r.title.slice(0, 22))}</button>`).join('')}</div>` : '';
}
function renderReceipts(m) {
  setTop('Receipts', { back: 'closeView', action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="addReceipt">+ Add</button>` });
  const q = (ui.rq || '').toLowerCase();
  const list = D.receipts.filter((r) => !q || `${r.title} ${r.note} ${catName(r.categoryId)} ${r.name}`.toLowerCase().includes(q)).sort((a, b) => b.date.localeCompare(a.date) || b.addedAt.localeCompare(a.addedAt));
  const byMonth = {}; for (const r of list) (byMonth[r.date.slice(0, 7)] ||= []).push(r);
  m.innerHTML = `<input class="search" id="rq" type="search" placeholder="Search maintenance, electricity, Amazon…" value="${esc(ui.rq || '')}">
  ${D.receipts.length ? Object.entries(byMonth).map(([ym, rs]) => `<div class="day"><span>${monthLabel(ym)}</span><span>${rs.length}</span></div><div class="list">${rs.map((r) => { const t = r.txId && D.transactions.find((x) => x.id === r.txId); return `<button class="item" data-act="openReceipt" data-id="${r.id}"><div class="ico">${/^image/.test(r.type) ? '🖼' : '📄'}</div><div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${[fmtDate(r.date, true), r.categoryId ? catName(r.categoryId) : '', t ? inr(t.amount, 0) : '', (r.size / 1024).toFixed(0) + ' KB'].filter(Boolean).map(esc).join(' · ')}</div></div><div class="muted">›</div></button>`; }).join('')}</div>`).join('')
    : `<div class="card" style="text-align:center;padding:26px 20px"><div class="serif" style="font-size:1.3rem;margin-bottom:6px">No receipts yet</div><p class="small muted">Keep bills like society maintenance, electricity or anything you may need later. Photos and PDFs are stored encrypted on this phone.</p><button class="btn" data-act="addReceipt">Add a receipt or bill</button></div>`}`;
  $('#rq')?.addEventListener('input', (e) => { ui.rq = e.target.value; const pos = e.target.selectionStart; render(); const el = $('#rq'); el.focus(); el.setSelectionRange(pos, pos); });
}
function receiptForm(files) {
  ui.rcPending = files;
  openSheet(`<h3>Add ${files.length > 1 ? files.length + ' files' : 'receipt'}</h3><form data-form="receipt">
    <label class="f"><span>Title</span><input class="i" name="title" value="${esc(files.length === 1 ? files[0].name.replace(/\.\w+$/, '') : '')}" placeholder="Society maintenance, November" required></label>
    <div class="split"><label class="f"><span>Date</span><input class="i" type="date" name="date" value="${todayIso()}"></label>
    <label class="f"><span>Category</span><select class="i" name="categoryId">${catOptions('')}</select></label></div>
    <label class="f"><span>Note</span><input class="i" name="note" placeholder="Optional"></label>
    <button class="btn wide">Save</button></form>`);
}
async function openReceipt(id) {
  const r = D.receipts.find((x) => x.id === id); if (!r) return;
  const f = await receiptFile(r); if (!f) return toast('That file is missing on this phone.');
  if (ui.rcUrl) URL.revokeObjectURL(ui.rcUrl);
  const url = ui.rcUrl = URL.createObjectURL(f);
  const t = r.txId && D.transactions.find((x) => x.id === r.txId);
  openSheet(`<h3>${esc(r.title)}</h3>
    ${/^image/.test(r.type) ? `<img src="${url}" alt="${esc(r.title)}" style="width:100%;border-radius:14px;display:block;margin-bottom:12px">` : `<a class="btn wide ghost" href="${url}" target="_blank" rel="noopener" style="margin-bottom:12px">Open PDF</a>`}
    <p class="small muted">${[fmtDate(r.date, true), r.categoryId ? catName(r.categoryId) : '', t ? `${esc(t.payee)} ${inr(t.amount)}` : '', r.note].filter(Boolean).join(' · ')}</p>
    <div class="row"><button class="btn" style="flex:1" data-act="shareReceipt" data-id="${r.id}">Share or save</button><button class="btn danger" style="flex:1" data-act="deleteReceipt" data-id="${r.id}">Delete</button></div>`);
}

function shortcutHelp() {
  openSheet(`<h3>"Log to Ledger" Shortcut</h3>
  <p class="small">Say <b>"Hey Siri, Log to Ledger"</b>, or press your Action button. It asks how much, what for and how you paid, then saves it to the same inbox file as your bank SMS. Ledger adds it next time you tap <b>Read SMS &amp; logs</b>.</p>
  <ol class="small" style="padding-left:18px;line-height:1.55">
    <li>Open <b>Shortcuts</b> → <b>+</b>. Name it <b>Log to Ledger</b>.</li>
    <li>Add <b>Ask for Input</b>. Input type: <b>Number</b>. Prompt: <code>How much?</code></li>
    <li>Add <b>Set Variable</b>. Name: <code>Amount</code>, value: <b>Provided Input</b>.</li>
    <li>Add <b>Ask for Input</b>. Type: <b>Text</b>. Prompt: <code>What for?</code></li>
    <li>Add <b>Set Variable</b>. Name: <code>What</code>, value: <b>Provided Input</b>.</li>
    <li>Add <b>Choose from Menu</b>. Prompt: <code>Paid with</code>. Items: <code>Savings ${esc(payAccount('upi', false)?.last4 || '1234')}</code>, <code>Card ${esc(payAccount('card', false)?.last4 || '5678')}</code>, <code>Cash</code>. Under each item add a <b>Text</b> action with that same text. The last 4 digits pick the account, so UPI paid from your card goes under Card.</li>
    <li>After <b>End Menu</b>, add <b>Set Variable</b>. Name: <code>How</code>, value: <b>Menu Result</b>.</li>
    <li>Add <b>Text</b>. Type <code>===LOG===</code> and a space, insert <b>Current Date</b> (tap it → Date Format: <b>ISO 8601</b>, include time). Press return, then insert <b>Amount</b>, type <code> | </code>, insert <b>What</b>, type <code> | </code>, insert <b>How</b>.</li>
    <li>Add <b>Append to Text File</b>: text = that <b>Text</b>, file <code>Ledger Inbox.txt</code> in the <b>Shortcuts</b> folder, <b>Make New Line</b> on. (The same file your SMS automations use.)</li>
    <li>Optional: <b>Show Notification</b> <code>Logged ₹[Amount] for [What]</code>.</li>
  </ol>
  <p class="small"><b>Action button:</b> Settings → Action Button → <b>Shortcut</b> → Log to Ledger.</p>
  <p class="small muted">The text it writes looks like: <code>250 | Chai | UPI</code>. UPI goes to ${esc(accShort(payAccount('upi', false)) || 'your UPI account')}, Card to ${esc(accShort(payAccount('card', false)) || 'your card')}. If the bank SMS for the same payment also arrives, Ledger keeps one entry and adds your words to it.</p>
  <button class="btn wide" data-act="closeSheet">Got it</button>`);
}

// ---------- family vault ----------
const VTYPES = ['Health', 'Life', 'Accident', 'Licence', 'Travel', 'Endowment', 'Vehicle', 'Home', 'Other'];
const VICON = { Health: 'Health', Life: 'Personal', Accident: 'Health', Licence: 'Transport', Travel: 'Transport', Endowment: 'Financial', Vehicle: 'Transport', Home: 'Bills', Other: 'none' };
function vaultIcon(t) { const k = VICON[t] || 'none'; return `<div class="ico tone-${TONE[k] || 'grey'}" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg></div>`; }
const vhead = (t) => `<h2 class="small" style="margin:14px 0 6px;color:var(--gold-ink);letter-spacing:.12em;text-transform:uppercase">${t}</h2>`;
function renderVault(m) {
  setTop('Vault', { action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="vaultEdit">+ Add</button>` });
  if (!(D.vault || []).length) { m.innerHTML = `<div class="card" style="text-align:center;padding:26px 20px"><div class="serif" style="font-size:1.3rem;margin-bottom:6px">Your family vault</div><p class="small muted">Insurance policies, claim steps, contacts and documents, encrypted on this phone.</p><button class="btn" data-act="vaultImport">Import a vault file</button><p class="small" style="margin:12px 0 0"><button class="link" data-act="vaultEdit">Or add a policy by hand</button></p></div>`; return; }
  const items = D.vault || [];
  const pol = items.filter((v) => v.kind === 'policy'), docs = items.filter((v) => v.kind === 'doc');
  m.innerHTML = `${items.filter((v) => v.important).map((v) => `<div class="card" style="background:var(--brand-bg);color:var(--on-brand)"><h2 style="color:var(--on-brand);opacity:.85">If it happens</h2><div style="font-weight:600">${esc(v.important)}</div><button class="link" style="color:var(--on-brand);opacity:.9" data-act="vaultOpen" data-id="${v.id}">${esc(v.title)} ›</button></div>`).join('')}
  <div class="day"><span>Insurance</span><span>${pol.length}</span></div>
  <div class="list">${pol.map((v) => `<button class="item" data-act="vaultOpen" data-id="${v.id}">${vaultIcon(v.type)}<div class="grow"><div class="t">${esc(v.title)}</div><div class="s">${esc([v.provider, v.cover].filter(Boolean).join(' · '))}</div></div><div class="muted">${v.files?.length ? '📎 ' : ''}›</div></button>`).join('') || '<div class="item"><div class="grow s">No policies yet</div></div>'}</div>
  ${docs.length ? `<div class="day"><span>Documents</span></div><div class="list">${docs.map((v) => `<button class="item" data-act="vaultOpen" data-id="${v.id}">${vaultIcon('Other')}<div class="grow"><div class="t">${esc(v.title)}</div><div class="s">${esc(v.notes || '')}</div></div><div class="muted">›</div></button>`).join('')}</div>` : ''}
  <p class="small" style="margin:0 4px 8px"><button class="link" data-act="vaultImport">Import a vault file</button></p>
  <p class="small muted" style="margin:6px 4px">Everything here is encrypted on this phone, like the rest of Ledger. Attach policy PDFs, e-cards and ID scans to each item. Renewal and premium reminders live in Bills &amp; subscriptions.</p>`;
}
// Emails, phone numbers and links in the vault open Mail, the phone or WhatsApp
function contactLink(val) {
  const v = String(val).trim();
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (/^https?:\/\//i.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`;
  const wa = v.match(/^whatsapp\s*:?\s*(\+?[\d\s-]{8,})$/i);
  if (wa) { const n = wa[1].replace(/[^\d]/g, ''); return `<a href="https://wa.me/${n}" target="_blank" rel="noopener">WhatsApp ${esc(wa[1].trim())}</a>`; }
  if (/^\+?[\d][\d\s-]{6,}$/.test(v)) return `<a href="tel:${esc(v.replace(/[\s-]/g, ''))}">${esc(v)}</a>`;
  return esc(v);
}
// Escalation tiles: people grouped by level, one tile per team, with Mail / Call / WhatsApp buttons
const ESC_NOTE = { 1: 'Start here', 2: 'If level 1 does not resolve it', 3: 'Last step' };
const ESC_TONE = { 1: 'sage', 2: 'sand', 3: 'clay' };
const IC_MAIL = '<path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/>';
const IC_CALL = '<path d="M6.6 3.5 9 3l1.6 4-2 1.3a11 11 0 0 0 5.1 5.1l1.3-2 4 1.6-.5 2.4a2 2 0 0 1-2 1.6A15.5 15.5 0 0 1 5 5.5a2 2 0 0 1 1.6-2Z"/>';
const IC_WA = '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 18.8Z"/><path d="M9.2 9.4c.3 1.9 1.6 3.4 3.6 4.2l1-.9 1.6.8"/>';
const icb = (href, ic, label, ext) => `<a class="icb" href="${esc(href)}" aria-label="${label}"${ext ? ' target="_blank" rel="noopener"' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></a>`;
function escTiles(people) {
  const levels = [...new Set(people.map((p) => p.level || 1))].sort((a, b) => a - b);
  return vhead('Escalation') + levels.map((l) => `<div class="esc-lvl"><span class="esc-badge tone-${ESC_TONE[l] || 'grey'}">Level ${l}</span><span class="small muted">${ESC_NOTE[l] || ''}</span></div>
    <div class="esc-row">${people.filter((p) => (p.level || 1) === l).map((p) => {
      const tel = p.phone ? p.phone.replace(/[^\d+]/g, '') : '';
      return `<div class="esc-tile"><div class="esc-team">${esc(p.team || '')}</div><div class="esc-name">${esc(p.name || '')}</div>${p.phone ? `<div class="small muted">${esc(p.phone)}</div>` : ''}
        <div class="esc-acts">${p.email ? icb('mailto:' + p.email, IC_MAIL, 'Email ' + p.name) : ''}${tel ? icb('tel:' + tel, IC_CALL, 'Call ' + p.name) : ''}${p.whatsapp ? icb('https://wa.me/' + p.whatsapp.replace(/[^\d]/g, ''), IC_WA, 'WhatsApp ' + p.name, true) : ''}</div></div>`;
    }).join('')}</div>`).join('');
}
function vaultOpen(id) {
  const v = D.vault.find((x) => x.id === id); if (!v) return;
  const row = (k, val) => val ? `<tr><td class="muted">${k}</td><td>${val}</td></tr>` : '';
  const files = (v.files || []).map((fid) => D.receipts.find((r) => r.id === fid)).filter(Boolean);
  const per = { month: 'a month', quarter: 'a quarter', year: 'a year' };
  openSheet(`<h3>${esc(v.title)}</h3>
    ${v.important ? `<div class="card" style="background:var(--brand-2);box-shadow:none"><b>${esc(v.important)}</b></div>` : ''}
    <table class="t">${row('Insurer', esc(v.provider || ''))}${row('TPA', esc(v.tpa || ''))}${row('Policy no.', esc(v.policyNo || ''))}${row('Covers', esc(v.holder || ''))}${row('Cover', esc(v.cover || ''))}${row('Premium', v.premium ? inr(v.premium, 0) + (v.freq ? ' ' + (per[v.freq] || '') : '') : esc(v.premiumNote || ''))}${row('Next due', v.nextDue ? fmtDate(v.nextDue, true) : '')}${row('Nominee', esc(v.nominee || ''))}</table>
    ${v.notes ? `<p class="small" style="margin-top:12px">${esc(v.notes)}</p>` : ''}
    ${v.claim?.length ? vhead('How to claim') + `<ol class="small" style="padding-left:18px;line-height:1.5;margin:0">${v.claim.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>` : ''}
    ${v.people?.length ? escTiles(v.people) : ''}
    ${v.contacts?.length ? vhead(v.people?.length ? 'Other contacts' : 'Contacts') + `<table class="t">${v.contacts.map(([k, val]) => row(esc(k), contactLink(val))).join('')}</table>` : ''}
    ${vhead('Documents')}
    ${receiptThumbs(files) || '<p class="small muted" style="margin:0 0 8px">None yet: add the policy PDF, e-card or schedule.</p>'}
    <div class="row"><button class="btn ghost" style="flex:1" data-act="vaultAttach" data-id="${v.id}">📎 Attach</button><button class="btn ghost" style="flex:1" data-act="vaultEdit" data-id="${v.id}">Edit</button></div>`);
}
function vaultEdit(id) {
  const v = id ? D.vault.find((x) => x.id === id) : { kind: 'policy', type: 'Health' };
  openSheet(`<h3>${id ? 'Edit' : 'Add to vault'}</h3><form data-form="vault" data-id="${id || ''}">
    <div class="split"><label class="f"><span>Kind</span><select class="i" name="kind"><option value="policy" ${v.kind === 'policy' ? 'selected' : ''}>Insurance policy</option><option value="doc" ${v.kind === 'doc' ? 'selected' : ''}>Document</option></select></label>
    <label class="f"><span>Type</span><select class="i" name="type">${VTYPES.map((t) => `<option ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
    <label class="f"><span>Title</span><input class="i" name="title" value="${esc(v.title || '')}" required></label>
    <label class="f"><span>Insurer or issuer</span><input class="i" name="provider" value="${esc(v.provider || '')}"></label>
    <div class="split"><label class="f"><span>Policy / document no.</span><input class="i" name="policyNo" value="${esc(v.policyNo || '')}"></label><label class="f"><span>Cover</span><input class="i" name="cover" value="${esc(v.cover || '')}"></label></div>
    <div class="split"><label class="f"><span>Premium (₹)</span><input class="i num" name="premium" inputmode="decimal" value="${v.premium ? v.premium / 100 : ''}"></label><label class="f"><span>Every</span><select class="i" name="freq"><option value="">One-off / none</option>${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, l]) => `<option value="${k}" ${v.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="split"><label class="f"><span>Next due / renewal</span><input class="i" type="date" name="nextDue" value="${v.nextDue || ''}"></label><label class="f"><span>Nominee</span><input class="i" name="nominee" value="${esc(v.nominee || '')}"></label></div>
    <label class="f"><span>Notes</span><textarea class="i" name="notes">${esc(v.notes || '')}</textarea></label>
    <label class="row small" style="margin:0 0 12px"><input type="checkbox" class="chk" name="remind" ${id ? '' : 'checked'}><span>Add a reminder in Bills &amp; subscriptions for the next due date</span></label>
    <button class="btn wide">Save</button></form>
    ${id ? `<div style="height:10px"></div><button class="btn wide danger" data-act="vaultDelete" data-id="${id}">Delete</button>` : ''}`);
}

// ---------- monthly recap ----------

// ---------- Summary for AI: a plain-text brief to paste into any AI app ----------
const SUM_PERIODS = [['this', 'This month'], ['last', 'Last month'], ['3m', 'Last 3 months'], ['6m', 'Last 6 months']];
function aiSummary(period = 'last') {
  const cur = ymOf(todayIso());
  const n = { this: 1, last: 1, '3m': 3, '6m': 6 }[period] || 1;
  const end = period === 'this' ? cur : addMonths(cur, -1);
  const months = Array.from({ length: n }, (_, i) => addMonths(end, i - n + 1));
  const prevMonths = months.map((m2) => addMonths(m2, -n));
  const agg = (ms) => { const out = { spend: 0, income: 0, cats: new Map() }; for (const m2 of ms) { const st = monthStats(m2); out.spend += st.spend; out.income += st.income; for (const [k, v] of st.byCat) out.cats.set(k, (out.cats.get(k) || 0) + v); } return out; };
  const a = agg(months), b = agg(prevMonths);
  const r = (v) => inr(Math.round(v / 100) * 100, 0);
  const pct = (x, y) => (y ? `${x >= y ? '+' : ''}${Math.round((x / y - 1) * 100)}%` : 'new');
  const clean = (t) => String(t || '').replace(/\d{4,}/g, '').replace(/\s{2,}/g, ' ').trim() || 'Unknown';
  const label = months.length > 1 ? `${monthLabel(months[0])} to ${monthLabel(months.at(-1))}` : monthLabel(months[0]) + (period === 'this' ? ` (1 to ${+todayIso().slice(8)}, month not over)` : '');
  const plabel = prevMonths.length > 1 ? `${monthLabel(prevMonths[0])} to ${monthLabel(prevMonths.at(-1))}` : monthLabel(prevMonths[0]);
  const vis = new Set(D.accounts.filter((x) => accVisible(x)).map((x) => x.id));
  const tx = D.transactions.filter((x) => vis.has(x.accountId) && months.includes(ymOf(x.date)) && x.amount < 0 && !['transfer', 'income'].includes(catById(x.categoryId)?.kind));
  const byPayee = new Map(); for (const x of tx) { const k = clean(x.payee || x.description); const e = byPayee.get(k) || { n: 0, v: 0 }; e.n++; e.v -= x.amount; byPayee.set(k, e); }
  const whoName = D.settings.who === 'all' || !multi() ? (multi() ? 'Combined household (' + D.members.map((m2) => m2.name).join(' and ') + ')' : 'Me') : D.members.find((m2) => m2.id === D.settings.who)?.name;
  const L = [];
  L.push('Below is a summary of my personal finances in India, exported from my budgeting app. Amounts are in Indian rupees.',
    'Please:', '1. Tell me where most of my money went, and anything unusual.', `2. Compare it with the previous period and explain the biggest changes.`,
    '3. Give me 3 to 5 specific, practical ways to spend less or save more, with rough rupee amounts.', '4. Point out subscriptions or recurring payments worth reviewing.',
    '5. Flag any risks: overspending, interest, fees, a low savings rate.');
  const tgt = D.settings.saveTarget || 0, style = (D.settings.aiStyle || '').trim();
  if (tgt) L.push(`6. My goal is to save ${r(tgt)} every month. Tell me plainly whether I am on track, and exactly what to cut to close any gap.`);
  L.push(style ? `Style: ${style}` : 'Keep it concise and practical.', '');
  const hasPrev = b.spend > 0;
  const withData = months.filter((m2) => D.transactions.some((x) => x.date.startsWith(m2) && vis.has(x.accountId)));
  L.push(`PERIOD: ${label}`, hasPrev ? `COMPARED WITH: ${plabel}` : 'COMPARED WITH: no earlier data in the app', `WHOSE MONEY: ${whoName}`);
  if (withData.length && withData.length < months.length) L.push(`NOTE: the app only has data for ${withData.map(monthLabel).join(', ')} in this period.`);
  L.push('');
  L.push('TOTALS', `- Spending: ${r(a.spend)}${hasPrev ? ` (previous ${r(b.spend)}, ${pct(a.spend, b.spend)})` : ''}`);
  if (a.income) L.push(`- Income: ${r(a.income)}`, `- Saved: ${r(a.income - a.spend)} (${Math.round((1 - a.spend / a.income) * 100)}% of income)`);
  if (withData.length > 1) L.push(`- Monthly average spending: ${r(a.spend / withData.length)}`);
  if (tgt && a.income) {
    const mo = Math.max(1, withData.length || 1), saved = (a.income - a.spend) / mo;
    L.push(`- Savings goal: ${r(tgt)} a month. ${period === 'this' ? 'So far this month' : 'Actual'}: ${r(saved)} a month, ${saved >= tgt ? 'ahead by ' + r(saved - tgt) : 'short by ' + r(tgt - saved)}`);
  } else if (tgt) L.push(`- Savings goal: ${r(tgt)} a month (no income recorded in this period, so progress can't be worked out)`);
  L.push('', hasPrev ? 'SPENDING BY CATEGORY (previous period in brackets)' : 'SPENDING BY CATEGORY');
  for (const [k, v] of [...a.cats.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)) { const pv = b.cats.get(k) || 0; L.push(`- ${k === '_none' ? 'Uncategorised' : catName(k)}: ${r(v)} (${hasPrev ? (pv ? r(pv) + ', ' + pct(v, pv) : 'none before') + ', ' : ''}${Math.round(v / Math.max(1, a.spend) * 100)}% of spending)`); }
  L.push('', 'TOP PAYEES');
  for (const [k, e] of [...byPayee.entries()].sort((x, y) => y[1].v - x[1].v).slice(0, 12)) L.push(`- ${k}: ${r(e.v)} in ${e.n} payment${e.n > 1 ? 's' : ''}`);
  L.push('', 'LARGEST PAYMENTS');
  for (const x of [...tx].filter((x) => { const r2 = refundFor(x); return !r2 || r2.amount < -x.amount; }).sort((p, q) => p.amount - q.amount).slice(0, 10)) L.push(`- ${fmtDate(x.date, true)}: ${clean(x.payee || x.description)}, ${r(-x.amount)} (${catName(x.categoryId)})`);
  const small = tx.filter((x) => -x.amount < 50000);
  if (small.length) L.push('', `SMALL PAYMENTS: ${small.length} payments under ₹500, adding up to ${r(small.reduce((t, x) => t - x.amount, 0))}`);
  const per = { month: 'a month', quarter: 'a quarter', year: 'a year', week: 'a week' };
  const subs = (D.bills || []).filter((x) => x.kind === 'subscription');
  if (subs.length) { L.push('', 'SUBSCRIPTIONS'); for (const x of subs) L.push(`- ${clean(x.name)}: ${x.amount ? r(x.amount) + ' ' + (per[x.every] || '') : 'amount varies'}`); }
  const loans = D.accounts.filter((x) => x.loan && accVisible(x));
  if (loans.length) {
    L.push('', 'LOANS');
    for (const x of loans) { const P = latestValuation(x.id)?.value || 0, lr = mrate(x.loan.rate); let left = P, k = 0, int = 0; while (left > 100 && k++ < 600) { const i = Math.round(left * lr); int += i; left -= Math.min(x.loan.emi, left + i) - i; } L.push(`- ${clean(x.name)}: ${r(P)} outstanding, EMI ${r(x.loan.emi)}, ${x.loan.rate}% interest, about ${k} EMIs left, ${r(int)} interest still to pay`); }
  }
  const nw = netWorth(); if (nw.assets || nw.liabilities) L.push('', 'NET WORTH', `- ${r(nw.net)} (assets ${r(nw.assets)}, debts ${r(-nw.liabilities)}${loans.length && D.settings.loansSeparate ? ', loans listed above not included' : ''})`);
  const uncat = a.cats.get('_none'); if (uncat) L.push('', `NOTE: ${r(uncat)} of spending is not categorised yet.`);
  const brows = months.length === 1 ? budgetRows(months[0]) : [];
  if (brows.length) { L.push('', 'MY BUDGETS'); for (const b of brows) L.push(`- ${b.name}: ${r(b.v)} of ${r(b.lim)} (${Math.round(b.pct * 100)}%${b.pct > 1 ? ', over' : ''})`); }
  const tagT = new Map();
  for (const x of tx) for (const t of tagsOf(x)) tagT.set(t, (tagT.get(t) || 0) - x.amount);
  if (tagT.size) {
    L.push('', 'TRIPS AND EVENTS (one-offs, included in the totals above)');
    for (const [t, v] of [...tagT.entries()].sort((p, q) => q[1] - p[1])) L.push(`- ${t}: ${r(v)}`);
    const oneOff = tx.filter((x) => tagsOf(x).length).reduce((t, x) => t - x.amount, 0);
    L.push(`- Spending without trips and events: ${r(a.spend - oneOff)}${withData.length > 1 ? ` (${r((a.spend - oneOff) / withData.length)} a month)` : ''}`);
  }
  if (D.settings.sumAll) {
    // Every transaction, oldest first. Transfers between my own accounts and card bill payments are left out.
    const all = D.transactions.filter((x) => vis.has(x.accountId) && months.includes(ymOf(x.date)) && catById(x.categoryId)?.kind !== 'transfer')
      .sort((p, q) => p.date.localeCompare(q.date) || q.amount - p.amount);
    const MAX = 800;
    L.push('', `EVERY TRANSACTION (${all.length}${all.length > MAX ? `, first ${MAX} shown` : ''}; date | payee | amount, minus is money out | category | account)`);
    for (const x of all.slice(0, MAX)) L.push(`${x.date.slice(8)}/${x.date.slice(5, 7)} | ${clean(x.payee || x.description)} | ${x.amount < 0 ? '-' : '+'}${inr(Math.abs(x.amount), 0).replace('₹', '')} | ${catName(x.categoryId)} | ${clean(accById(x.accountId)?.name)}`);
    L.push('Please also review this list: flag duplicate charges, anything that looks wrong or unexpected, and items in the wrong category.');
  }
  return L.join('\n');
}
function summarySheet(period) {
  period ||= ui.sumPeriod || (+todayIso().slice(8) <= 7 ? 'last' : 'this'); ui.sumPeriod = period;
  const text = aiSummary(period); ui.sumText = text;
  openSheet(`<h3>Summary for AI</h3><p class="small muted" style="margin-top:-6px">Copy this and paste it into Claude, ChatGPT or any AI app for a report and savings ideas. No account numbers or balances by account are included.</p>
    <div class="split" style="margin-bottom:10px"><label class="f"><span>Save each month (₹)</span><input class="i" id="sumTarget" inputmode="decimal" placeholder="e.g. 30000" value="${D.settings.saveTarget ? D.settings.saveTarget / 100 : ''}"></label>
    <label class="f"><span>How the AI should talk</span><input class="i" id="sumStyle" placeholder="e.g. Be blunt" value="${esc(D.settings.aiStyle || '')}"></label></div>
    <label class="item" style="border:1px solid var(--line);border-radius:12px;margin-bottom:10px"><div class="grow">Include every transaction<div class="s">For a line-by-line review. Longer to paste.</div></div><input type="checkbox" switch id="sumAll" ${D.settings.sumAll ? 'checked' : ''}></label>
    <div class="seg" role="group" aria-label="Period" style="margin-bottom:10px;grid-template-columns:repeat(4,minmax(0,1fr));font-size:.8rem">${SUM_PERIODS.map(([k, t]) => `<button class="${k === period ? 'on' : ''}" data-act="sumPeriod" data-p="${k}" aria-pressed="${k === period}">${t}</button>`).join('')}</div>
    <div style="position:relative"><button class="btn ghost" data-act="sumCopy" style="position:absolute;top:8px;right:8px;min-height:34px;padding:6px 12px;font-size:.8rem;background:var(--card)">Copy all</button>
    <textarea class="i" readonly style="min-height:300px;font-size:.8rem;line-height:1.45;font-family:ui-monospace,Menlo,monospace;padding-top:48px">${esc(text)}</textarea></div>
    <div class="row" style="position:sticky;bottom:calc(-18px - var(--safe-b));margin:10px -18px calc(-18px - var(--safe-b));padding:10px 18px calc(10px + var(--safe-b));background:var(--card);border-top:1px solid var(--line)"><button class="btn" style="flex:1" data-act="sumCopy">Copy everything</button>${navigator.share ? '<button class="btn ghost" style="flex:1" data-act="sumShare">Share…</button>' : ''}</div>`);
}
// ===================== Safe to spend =====================
// What's left for the rest of the month after income, the savings goal, bills and EMIs still due,
// and what has already gone. Loan EMIs are transfers (only their interest shows as spending), so the
// full EMI is set aside and the interest already counted is taken back out of spending.
const dim = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
// Pay cycle: from the latest salary credit to the next one expected. Only salary counts as money in,
// so balances, refunds, transfers and other credits never inflate what's available.
function rangeSpend(from, to) {
  let spend = 0, loanInt = 0;
  const vis = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  for (const x of D.transactions) {
    if (x.date < from || x.date > to) continue;
    if (multi() && D.settings.who !== 'all' && !vis.has(x.accountId)) continue;
    const c = catById(x.categoryId);
    if (c?.kind === 'transfer') { if (x.interest) loanInt += x.interest; continue; }
    if (c?.kind === 'income') continue;
    if (!c && x.amount > 0) continue;
    spend -= x.amount;
  }
  return { spend, loanInt };
}
function payCycle(today = todayIso()) {
  const vis = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  const sal = D.transactions.filter((x) => x.categoryId === 'salary' && x.amount > 0 && x.date <= today && (!multi() || D.settings.who === 'all' || vis.has(x.accountId))).sort((p, q) => q.date.localeCompare(p.date));
  if (!sal.length) return null;
  const last = sal[0];
  if (daysUntil(last.date) < -45) return { stale: last.date };
  // Credits within 5 days of the latest one are the same pay (e.g. salary plus allowances, or both of you)
  const from = sal.filter((x) => daysUntil(x.date) >= daysUntil(last.date) - 5).at(-1).date;
  const pay = sal.filter((x) => x.date >= from).reduce((t, x) => t + x.amount, 0);
  // Next salary: the same day of the month as this one; use the usual gap if earlier pays show a pattern
  const next = advance(from, 'month', +from.slice(8));
  return { from, next, pay, prevPay: sal.find((x) => x.date < from && daysUntil(x.date) < daysUntil(from) - 5)?.amount || 0 };
}
// Safe to spend = what's in your spending account (HDFC savings by default) plus any other money you
// choose to count, minus what will definitely leave before salary: card dues, bills and EMIs, and your goal.
// Each deduction can be switched off in the sheet.
const safeOpts = () => Object.assign((D.settings.safe ||= {}), { card: true, bills: true, emi: false, goal: true, ...D.settings.safe });
function safeAccount() {
  const id = D.settings.safeAcct; const a = id && accById(id);
  return a && !a.archived ? a : payAccount('upi', false);
}
function safeToSpend() {
  const acct = safeAccount(); if (!acct) return null;
  const today = todayIso(), o = safeOpts(), cyc = payCycle(today);
  const next = cyc && !cyc.stale ? cyc.next : isoAdd(ymOf(addMonths(ymOf(today), 1)) + '-01', -1); // no recent salary: end of month
  const end = isoAdd(next, -1);
  const bal = balance(acct), extra = D.settings.safeExtra || 0;
  const cards = D.accounts.filter((x) => !x.archived && x.type === 'credit_card' && ownerOf(x) === ownerOf(acct));
  const cardDue = cards.reduce((t, x) => t + Math.max(0, -balance(x)), 0);
  const loans = D.accounts.filter((x) => x.loan?.emi && !x.archived && ownerOf(x) !== 'other');
  const emiList = loans.filter((x) => { const nd = x.loan.nextDue || ''; return !nd || (nd >= today && nd <= end); }).map((x) => ({ name: x.name, amount: Math.round(x.loan.emi * (shareOf(x) || 1)), next: x.loan.nextDue }));
  const billList = (D.bills || []).filter((x) => x.amount && x.next && x.next >= today && x.next <= end && !/emi/i.test(x.name));
  const bills = billList.reduce((t, x) => t + x.amount, 0), emi = emiList.reduce((t, x) => t + x.amount, 0);
  const goal = D.settings.saveTarget || 0;
  const left = bal + extra - (o.card ? cardDue : 0) - (o.bills ? bills : 0) - (o.emi ? emi : 0) - (o.goal ? goal : 0);
  const daysLeft = Math.max(1, daysUntil(next));
  const perDay = left / daysLeft;
  // Usual daily spend over the last 30 days, to say whether the number is comfortable
  const usual = Math.max(0, rangeSpend(isoAdd(today, -30), isoAdd(today, -1)).spend) / 30;
  const tone = left < 0 ? 'bad' : usual && perDay < usual ? 'warn' : 'ok';
  const asOf = D.transactions.filter((x) => x.accountId === acct.id).reduce((m2, x) => (x.date > m2 ? x.date : m2), '');
  return { acct, bal, extra, cardDue, cards, billList, emiList, bills, emi, goal, o, left, perDay, daysLeft, next, salaryKnown: !!(cyc && !cyc.stale), usual, tone, asOf };
}
function safeCard() {
  const s = safeToSpend();
  if (!s) return '';
  const col = { ok: 'var(--in)', warn: 'var(--warn)', bad: 'var(--bad)' }[s.tone];
  const msg = s.left < 0 ? 'Not enough set aside' : s.tone === 'warn' ? `Below your usual ${inr(s.usual, 0)} a day` : 'Comfortable';
  const nd = fmtDate(s.next, true).replace(/ \d{4}$/, '');
  const total = s.bal + s.extra, ded = total - s.left;
  return `<button class="card item safe tone-${s.tone}" style="border-radius:var(--r);margin-bottom:14px;border:0;display:block;text-align:left" data-act="safeSheet">
    <div class="row"><h2 class="grow" style="margin:0">Safe to spend</h2><span class="pillnote" style="color:${col}">${msg}</span></div>
    <div class="row" style="align-items:baseline;gap:8px;margin-top:6px"><div class="big num money">${inr(Math.max(0, s.perDay), 0)}</div><div class="muted">a day</div></div>
    <div class="small muted">${s.left >= 0 ? `${inr(s.left, 0)} to spend until ${s.salaryKnown ? 'salary on ' : ''}${nd}` : `${inr(-s.left, 0)} short until ${s.salaryKnown ? 'salary on ' : ''}${nd}`}</div>
    <div class="safebar" aria-hidden="true"><i class="grow-x" style="--w:${total > 0 ? Math.max(0, Math.min(100, s.left / total * 100)).toFixed(1) : 0}%;background:${col}"></i></div>
    <div class="row tiny muted" style="margin-top:4px"><span class="grow">${esc(s.acct.name)}${s.extra ? ' + other money' : ''}: ${inr(total, 0)}</span><span>${ded > 0 ? inr(ded, 0) + ' set aside' : ''}</span></div>
  </button>`;
}
function safeSheet() {
  const s = safeToSpend();
  if (!s) return toast('Add your savings account first.');
  const sw = (k, label, v, sub = '') => `<label class="item" style="padding:10px 14px"><div class="grow">${label}${sub ? `<div class="s">${sub}</div>` : ''}</div><span class="num" style="margin-right:10px;${s.o[k] ? '' : 'opacity:.4;text-decoration:line-through'}">− ${inr(v, 0)}</span><input type="checkbox" switch data-safe="${k}" ${s.o[k] ? 'checked' : ''}></label>`;
  const live = D.accounts.filter((x) => !x.archived && ['savings', 'current'].includes(x.type));
  const bl = s.billList.map((x) => `${x.name}, ${fmtDate(x.next, true).replace(/ \d{4}$/, '')}`);
  openSheet(`<h3>Safe to spend</h3>
    <div class="list" style="margin:0 0 12px"><div class="item" style="padding:10px 14px"><div class="grow">${esc(s.acct.name)}<div class="s">${s.asOf ? 'Balance as of your latest entry, ' + fmtDate(s.asOf, true) : 'Current balance'}</div></div><span class="num">${inr(s.bal, 0)}</span></div>
      <div class="item" style="padding:10px 14px"><div class="grow">Other money I can use<div class="s">Cash, another account, money coming in</div></div><input class="i num" id="safeExtra" inputmode="decimal" placeholder="0" style="width:8.5em;text-align:right;min-height:40px" value="${s.extra ? s.extra / 100 : ''}"></div>
      ${s.cards.length ? sw('card', 'Credit card dues', s.cardDue, 'Paid from this account when the bill comes') : ''}
      ${sw('bills', 'Bills before salary', s.bills, bl.length ? esc(bl.join(' · ')) : 'None due')}
      ${s.emiList.length ? sw('emi', 'Loan EMIs before salary', s.emi, 'Turn on if the EMI comes out of this account') : ''}
      ${sw('goal', 'Savings goal', s.goal, s.goal ? 'Kept aside, not for spending' : 'Not set')}
      <div class="item" style="padding:12px 14px"><div class="grow"><b>Safe to spend</b><div class="s">until ${s.salaryKnown ? 'salary on ' : ''}${fmtDate(s.next, true)}, ${s.daysLeft} days</div></div><div style="text-align:right"><div class="num ${s.left < 0 ? 'bad' : 'in'}"><b>${inr(s.left, 0)}</b></div><div class="small muted">${inr(Math.max(0, s.perDay), 0)} a day</div></div></div></div>
    <div class="split"><label class="f"><span>Spending account</span><select class="i" id="safeAcct">${live.map((x) => `<option value="${x.id}" ${x.id === s.acct.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Save each month (₹)</span><input class="i" id="safeGoal" inputmode="decimal" placeholder="e.g. 30000" value="${s.goal ? s.goal / 100 : ''}"></label></div>
    <p class="small muted">The balance updates with every bank SMS, Shortcut log or statement you add.${s.salaryKnown ? '' : ' No recent salary found, so this runs to the end of the month.'}</p>`);
}

// ===================== Category budgets =====================
const budgets = () => (D.budgets ||= {});
// Past months only count budgets that existed then, so a limit set today doesn't fail last month
function budgetRows(ym = ymOf(todayIso())) {
  const st = monthStats(ym), by = new Map(st.byCat), since = D.settings.budgetSince || {};
  return Object.entries(budgets()).filter(([id, v]) => v > 0 && (since[id] || '0000') <= ym).map(([id, lim]) => { const v = Math.max(0, by.get(id) || 0); return { id, name: catName(id), lim, v, pct: v / lim }; }).sort((a, b) => b.pct - a.pct);
}
const budTone = (p) => (p >= 1 ? 'bad' : p >= 0.8 ? 'warn' : 'ok');
const budBar = (r) => `<div class="bar bud ${budTone(r.pct)}"><i class="grow-x" style="--w:${Math.min(100, r.pct * 100).toFixed(1)}%"></i></div>`;
function budgetCard() {
  const rows = budgetRows(); if (!rows.length) return '';
  const day = +todayIso().slice(8), days = dim(ymOf(todayIso()));
  return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Budgets</h2><button class="link" data-act="openBudgets">See all ›</button></div>
    ${rows.slice(0, 4).map((r) => `<button class="item" style="padding:9px 0" data-act="showCat" data-id="${r.id}"><div class="grow"><div class="row"><span class="grow">${esc(r.name)}</span><span class="num small ${r.pct >= 1 ? 'bad' : ''}">${inr(r.v, 0)} <span class="muted">of ${inr(r.lim, 0)}</span></span></div>${budBar(r)}</div></button>`).join('')}
    <p class="tiny muted" style="margin:6px 0 0">${day} of ${days} days gone (${Math.round(day / days * 100)}%)</p></div>`;
}
// A one-time nudge when a category crosses 80% or 100% of its budget this month
function budgetNudge() {
  const ym = ymOf(todayIso()), seen = (D.settings.budSeen && D.settings.budSeen.ym === ym) ? D.settings.budSeen : (D.settings.budSeen = { ym, at: {} });
  for (const r of budgetRows(ym)) {
    const lvl = r.pct >= 1 ? 2 : r.pct >= 0.8 ? 1 : 0;
    if (lvl > (seen.at[r.id] || 0)) { seen.at[r.id] = lvl; save(); setTimeout(() => toast(lvl === 2 ? `${r.name}: over budget (${inr(r.v, 0)} of ${inr(r.lim, 0)})` : `${r.name}: ${Math.round(r.pct * 100)}% of this month's budget used`, 3200), 600); return; }
  }
}
function avgSpend(catId, n = 3) {
  const ym = ymOf(todayIso()); let t = 0, k = 0;
  for (let i = 1; i <= n; i++) { const st = monthStats(addMonths(ym, -i)); if (!st.spend) continue; k++; t += new Map(st.byCat).get(catId) || 0; }
  return k ? t / k : 0;
}
function renderBudgets(m) {
  setTop('Budgets', { back: 'closeView' });
  const ym = ymOf(todayIso()), rows = budgetRows(ym), st = monthStats(ym);
  const set = new Set(rows.map((r) => r.id));
  const ideas = [...new Set([...st.byCat.map(([k]) => k), ...D.categories.filter((c) => c.kind === 'expense').map((c) => c.id)])].filter((k) => k !== '_none' && !set.has(k) && catById(k)?.kind === 'expense')
    .map((k) => ({ id: k, avg: avgSpend(k) })).filter((x) => x.avg > 0).sort((a, b) => b.avg - a.avg).slice(0, 8);
  const lp = budgetRows(addMonths(ym, -1));
  m.innerHTML = `${rows.length ? `<div class="card"><h2>${monthLabel(ym)}</h2>${rows.map((r) => `<button class="item" style="padding:10px 0" data-act="budgetSheet" data-id="${r.id}"><div class="grow"><div class="row"><span class="grow">${esc(r.name)}</span><span class="num small ${r.pct >= 1 ? 'bad' : ''}">${inr(r.v, 0)} <span class="muted">of ${inr(r.lim, 0)}</span></span></div>${budBar(r)}<div class="tiny muted" style="margin-top:3px">${r.v <= r.lim ? `${inr(r.lim - r.v, 0)} left` : `${inr(r.v - r.lim, 0)} over`}</div></div></button>`).join('')}</div>` : `<div class="card" style="text-align:center"><div class="serif" style="font-size:1.25rem">Set your first budget</div><p class="small muted">Pick a category below. Ledger suggests a limit from your last 3 months and warns you at 80%.</p></div>`}
    ${lp.length ? `<div class="card"><h2>Last month's scorecard</h2><p class="mid serif" style="margin:0">Kept ${lp.filter((r) => r.pct <= 1).length} of ${lp.length}</p>${lp.filter((r) => r.pct > 1).map((r) => `<p class="small" style="margin:6px 0 0">${esc(r.name)}: <span class="bad">${inr(r.v - r.lim, 0)} over</span></p>`).join('')}</div>` : ''}
    ${ideas.length ? `<div class="day"><span>Add a budget</span></div><div class="list">${ideas.map((x) => `<button class="item" data-act="budgetSheet" data-id="${x.id}">${catIcon(x.id)}<div class="grow">${esc(catName(x.id))}<div class="s">About ${inr(x.avg, 0)} a month lately</div></div><div class="muted">+</div></button>`).join('')}</div>` : ''}
    <div class="list"><button class="item" data-act="budgetSheet"><div class="grow" style="color:var(--brand)">+ Another category</div></button></div>`;
}
function budgetSheet(id) {
  const avg = id ? avgSpend(id) : 0, cur = id ? budgets()[id] : 0;
  openSheet(`<h3>${id ? esc(catName(id)) : 'New budget'}</h3><form data-form="budget">
    ${id ? `<input type="hidden" name="cat" value="${id}">` : `<label class="f"><span>Category</span><select class="i" name="cat">${catOptions('', { allowNone: false })}</select></label>`}
    <label class="f"><span>Monthly limit (₹)</span><input class="i num" name="lim" inputmode="decimal" value="${cur ? cur / 100 : avg ? Math.round(avg / 10000) * 100 : ''}" required></label>
    ${avg ? `<p class="small muted" style="margin-top:-4px">You spent about ${inr(avg, 0)} a month here over the last 3 months.${avg > 200000 ? ` A 10% cut would be ${inr(Math.round(avg * 0.9 / 10000) * 10000, 0)}.` : ''}</p>` : ''}
    <button class="btn wide">Save</button></form>
    ${cur ? `<div style="height:10px"></div><button class="btn wide ghost" data-act="budgetRemove" data-id="${id}">Remove this budget</button>` : ''}`);
}

// ===================== Refunds and duplicates =====================
const pkey = (x) => (x.payee || x.description || '').toUpperCase().replace(/[^A-Z]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
// Pair each refund with the purchase it reverses: money in, same payee, amount no more than the purchase, within 90 days after it
function matchRefunds() {
  const outs = new Map();
  for (const x of D.transactions) if (x.amount < 0 && catById(x.categoryId)?.kind !== 'transfer') { const k = pkey(x); if (k) (outs.get(k) || outs.set(k, []).get(k)).push(x); }
  const taken = new Set(D.transactions.filter((x) => x.refundOf).map((x) => x.refundOf));
  let n = 0;
  for (const r of D.transactions) {
    if (r.amount <= 0 || r.refundOf || r.notRefund) continue;
    if (catById(r.categoryId)?.kind !== 'expense') continue;
    const cands = (outs.get(pkey(r)) || []).filter((o) => !taken.has(o.id) && o.date <= r.date && daysUntil(r.date) - daysUntil(o.date) <= 90 && -o.amount >= r.amount)
      .sort((p, q) => (Math.abs(-p.amount - r.amount) - Math.abs(-q.amount - r.amount)) || q.date.localeCompare(p.date));
    if (cands[0]) { r.refundOf = cands[0].id; taken.add(cands[0].id); n++; }
  }
  return n;
}
const refundFor = (x) => D.transactions.find((r) => r.refundOf === x.id);
// Same account, same amount and direction, within a day, similar payee, and not already explained
function findDupes() {
  const no = new Set(D.settings.notDupes || []), byKey = new Map(), out = [];
  for (const x of D.transactions) { if (x.transferId) continue; const k = x.accountId + '|' + x.amount; (byKey.get(k) || byKey.set(k, []).get(k)).push(x); }
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    g.sort((p, q) => p.date.localeCompare(q.date));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      if (Math.abs(daysUntil(b.date) - daysUntil(a.date)) > 1) break;
      if (a.ref && b.ref && a.ref !== b.ref) continue;
      if (pkey(a) !== pkey(b) && !(a.ref && a.ref === b.ref)) continue;
      if (a.refundOf || b.refundOf || refundFor(a) && refundFor(b)) continue;
      const key = [a.id, b.id].sort().join('|'); if (no.has(key)) continue;
      out.push({ a, b, key, sure: !!(a.ref && a.ref === b.ref) });
    }
  }
  return out;
}
function dupesCard() {
  const d = findDupes(); if (!d.length) return '';
  return `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openDupes"><div class="ico tone-clay" aria-hidden="true">2×</div><div class="grow"><div class="t">${d.length} possible duplicate${d.length > 1 ? 's' : ''}</div><div class="s">Same amount, same payee, a day apart. Check before they count twice.</div></div><div class="muted">›</div></button>`;
}
function renderDupes(m) {
  setTop('Possible duplicates', { back: 'closeView' });
  const d = findDupes();
  const one = (x) => `<div class="grow"><div class="t">${esc(x.payee || x.description)}</div><div class="s">${fmtDate(x.date, true)}${x.time ? ' ' + x.time : ''} · ${x.source === 'sms' ? 'SMS' : x.source === 'log' ? 'logged' : x.importId ? 'statement' : 'added by hand'}${x.ref ? ' · ref ' + esc(String(x.ref).slice(-6)) : ''}</div></div>`;
  m.innerHTML = d.length ? d.map((p) => `<div class="card dupe"><div class="row"><span class="small muted grow">${esc(accShort(accById(p.a.accountId)))}</span><span class="num ${p.a.amount > 0 ? 'in' : ''}">${inr(p.a.amount)}</span></div>
      ${p.sure ? '<p class="tiny warn" style="margin:4px 0 0">Same bank reference. Almost certainly a duplicate.</p>' : ''}
      <div class="item" style="padding:8px 0">${one(p.a)}<button class="btn ghost" style="min-height:34px;padding:4px 10px" data-act="dupeDel" data-id="${p.a.id}">Delete</button></div>
      <div class="item" style="padding:8px 0;border-top:1px solid var(--line)">${one(p.b)}<button class="btn ghost" style="min-height:34px;padding:4px 10px" data-act="dupeDel" data-id="${p.b.id}">Delete</button></div>
      <button class="btn wide ghost" style="margin-top:6px" data-act="dupeKeep" data-key="${p.key}">Both are real</button></div>`).join('')
    : `<div class="card" style="text-align:center;padding:26px 20px"><div class="serif" style="font-size:1.25rem">No duplicates</div><p class="small muted">Everything is counted once.</p></div>`;
}

// ===================== Trips and events (tags) =====================
const tagsOf = (x) => x.tags || [];
function allTags() {
  const m2 = new Map();
  for (const x of D.transactions) for (const t of tagsOf(x)) {
    const e = m2.get(t) || { name: t, spend: 0, n: 0, from: x.date, to: x.date };
    if (x.amount < 0 && catById(x.categoryId)?.kind !== 'transfer') e.spend -= x.amount; else if (x.amount > 0 && catById(x.categoryId)?.kind === 'expense') e.spend -= x.amount;
    e.n++; if (x.date < e.from) e.from = x.date; if (x.date > e.to) e.to = x.date; m2.set(t, e);
  }
  return [...m2.values()].sort((a, b) => b.to.localeCompare(a.to));
}
const parseTags = (s) => [...new Set(String(s || '').split(';').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean).map((t) => t.slice(0, 40)))];
function renderTags(m) {
  setTop('Trips & events', { back: 'closeView', action: `<button class="btn" style="min-height:36px;padding:6px 14px;border-radius:18px" data-act="tagTrip">+ Tag</button>` });
  if (ui.view.tag) return renderTag(m, ui.view.tag);
  const tags = allTags();
  m.innerHTML = tags.length ? `<div class="list">${tags.map((t) => `<button class="item" data-act="openTag" data-tag="${esc(t.name)}"><div class="ico tone-sand" aria-hidden="true">#</div><div class="grow"><div class="t">${esc(t.name)}</div><div class="s">${fmtDate(t.from, true)}${t.to !== t.from ? ' to ' + fmtDate(t.to, true) : ''} · ${t.n} transaction${t.n > 1 ? 's' : ''}</div></div><div class="a num">${inr(t.spend, 0)}</div></button>`).join('')}</div>
    <p class="small muted" style="margin:10px 4px">Trips and events show their own totals, and Summary for AI lists them separately so one-offs don't skew your monthly averages.</p>`
    : `<div class="card" style="text-align:center;padding:26px 20px"><svg width="80" height="60" viewBox="0 0 96 72" fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M20 40l26-26h24v24L44 64z"/><circle cx="60" cy="24" r="4"/></svg><div class="serif" style="font-size:1.25rem;margin:8px 0 4px">No trips or events yet</div><p class="small muted">Tag a trip like "Goa, Dec 2026" to see what it cost. You can tag everything between two dates in one go.</p><button class="btn" data-act="tagTrip">Tag a trip or event</button></div>`;
}
function renderTag(m, tag) {
  const tx = D.transactions.filter((x) => tagsOf(x).includes(tag)).sort((a, b) => b.date.localeCompare(a.date));
  const t = allTags().find((e) => e.name === tag) || { spend: 0, n: 0, from: '', to: '' };
  const cats = new Map(); for (const x of tx) if (catById(x.categoryId)?.kind !== 'transfer' && (x.amount < 0 || catById(x.categoryId)?.kind === 'expense')) { const k = x.categoryId || '_none'; cats.set(k, (cats.get(k) || 0) - x.amount); }
  const cs = [...cats.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...cs.map((c) => c[1]));
  const days = t.from ? daysUntil(t.to) - daysUntil(t.from) + 1 : 1;
  m.innerHTML = `<div class="card"><h2>#${esc(tag)}</h2><div class="big num">${inr(t.spend, 0)}</div><div class="small muted">${t.n} transactions · ${days} day${days > 1 ? 's' : ''}${days > 1 ? ` · ${inr(t.spend / days, 0)} a day` : ''}</div>
    ${cs.map(([k, v]) => `<div style="margin-top:10px"><div class="row small"><span class="grow">${esc(k === '_none' ? 'Uncategorised' : catName(k))}</span><span class="num">${inr(v, 0)}</span></div><div class="bar"><i class="grow-x" style="--w:${(v / mx * 100).toFixed(1)}%"></i></div></div>`).join('')}</div>
    <div class="list">${tx.map((x) => txItem(x)).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn ghost" style="flex:1" data-act="tagRename" data-tag="${esc(tag)}">Rename</button><button class="btn ghost" style="flex:1" data-act="tagRemove" data-tag="${esc(tag)}">Remove tag</button></div>`;
}
function tagTripSheet() {
  const to = todayIso(), from = isoAdd(to, -6);
  openSheet(`<h3>Tag a trip or event</h3><form data-form="tagTrip">
    <label class="f"><span>Name</span><input class="i" name="tag" list="tagList" placeholder="e.g. Goa, Dec 2026" required>${tagDatalist()}</label>
    <div class="split"><label class="f"><span>From</span><input class="i" type="date" name="from" id="ttFrom" value="${from}"></label><label class="f"><span>To</span><input class="i" type="date" name="to" id="ttTo" value="${to}"></label></div>
    <div id="ttList"></div><button class="btn wide">Tag selected</button></form>`);
  const fill = () => {
    const f = $('#ttFrom').value, t = $('#ttTo').value;
    const xs = D.transactions.filter((x) => x.date >= f && x.date <= t && x.amount < 0 && catById(x.categoryId)?.kind !== 'transfer' && accVisible(accById(x.accountId) || {})).sort((a, b) => a.date.localeCompare(b.date));
    $('#ttList').innerHTML = xs.length ? `<p class="small muted">${xs.length} payments in these dates. Untick anything that wasn't part of it.</p><div class="list" style="margin-bottom:12px">${xs.map((x) => `<label class="item"><input type="checkbox" class="chk" name="ids" value="${x.id}" checked><div class="grow"><div class="t">${esc(x.payee || x.description)}</div><div class="s">${fmtDate(x.date, true)} · ${esc(catName(x.categoryId))}</div></div><div class="a num">${inr(x.amount)}</div></label>`).join('')}</div>` : '<p class="small muted">No payments in these dates.</p>';
  };
  $('#ttFrom').addEventListener('change', fill); $('#ttTo').addEventListener('change', fill); fill();
}
const tagDatalist = () => `<datalist id="tagList">${allTags().map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>`;

// ===================== Investments: returns and allocation =====================
function xirr(flows) { // flows: [{d: iso, v: paise, + is money back to you}] -> annual rate
  if (flows.length < 2 || !flows.some((f) => f.v < 0) || !flows.some((f) => f.v > 0)) return null;
  const t0 = new Date(flows[0].d + 'T00:00:00');
  const yr = flows.map((f) => (new Date(f.d + 'T00:00:00') - t0) / 3.1536e10);
  const npv = (r) => flows.reduce((s, f, i) => s + f.v / Math.pow(1 + r, yr[i]), 0);
  let lo = -0.99, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2, fm = npv(mid); if (Math.abs(fm) < 1) return mid; if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; } }
  return (lo + hi) / 2;
}
const DEBTY = /\b(DEBT|LIQUID|GILT|BOND|OVERNIGHT|MONEY MARKET|CORPORATE|BANKING AND PSU|SHORT DURATION|ULTRA SHORT|CREDIT RISK|DYNAMIC BOND|ARBITRAGE|FIXED|TARGET MATURITY|SDL)\b/i;
const GOLDY = /\b(GOLD|SILVER|GOLDBEES|SGB)\b/i;
function allocation() {
  const B = { Equity: 0, 'Debt & deposits': 0, Retirement: 0, Gold: 0, Cash: 0, Crypto: 0, Other: 0 };
  for (const a of D.accounts) {
    if (a.archived || typeOf(a.type).side !== 'asset') continue;
    const sh = shareOf(a); if (!sh) continue;
    const hs = D.holdings.filter((h) => h.accountId === a.id);
    if (hs.length) { for (const h of hs) { const v = holdValue(h) * sh; B[GOLDY.test(h.name) ? 'Gold' : DEBTY.test(h.name) ? 'Debt & deposits' : 'Equity'] += v; } continue; }
    const v = Math.max(0, balance(a)) * sh;
    const t = a.type;
    if (['savings', 'current', 'cash', 'wallet'].includes(t)) B.Cash += v;
    else if (['fd', 'rd'].includes(t)) B['Debt & deposits'] += v;
    else if (['ppf', 'epf', 'nps'].includes(t)) B.Retirement += v;
    else if (t === 'gold') B.Gold += v; else if (t === 'crypto') B.Crypto += v;
    else if (['stocks', 'mutual_fund'].includes(t)) B.Equity += v;
    else if (!['property', 'vehicle'].includes(t)) B.Other += v;
  }
  const total = Object.values(B).reduce((s, v) => s + v, 0);
  return { total, parts: Object.entries(B).filter(([, v]) => v > 0).map(([k, v]) => ({ k, v, p: v / total })).sort((a, b) => b.v - a.v) };
}
function returnsData() {
  const accs = D.accounts.filter((a) => !a.archived && D.holdings.some((h) => h.accountId === a.id) && shareOf(a));
  let value = 0, cost = 0;
  for (const a of accs) for (const h of D.holdings.filter((h2) => h2.accountId === a.id)) { value += holdValue(h) * shareOf(a); cost += holdCost(h) * shareOf(a); }
  // XIRR since tracking began: the first recorded value, then money moved into investments, against today's value
  const ids = new Set(accs.map((a) => a.id));
  const days = Object.keys(D.priceHist || {}).filter((d) => accs.some((a) => D.priceHist[d][a.id] != null)).sort();
  const d0 = days[0] || null;
  let irr = null, since = d0;
  if (d0 && daysUntil(d0) <= -90) {
    const v0 = accs.reduce((t, a) => t + (D.priceHist[d0][a.id] || 0) * shareOf(a), 0);
    const flows = [{ d: d0, v: -v0 }];
    for (const x of D.transactions) if (x.date > d0 && x.categoryId === 'investments' && x.amount < 0 && !ids.has(x.accountId)) flows.push({ d: x.date, v: x.amount });
    flows.sort((p, q) => p.d.localeCompare(q.d)); flows.push({ d: todayIso(), v: value });
    irr = xirr(flows);
  }
  return { accs, value, cost, gain: value - cost, irr, since };
}
const ALLOC_COL = { Equity: 'var(--brand)', 'Debt & deposits': 'var(--gold)', Retirement: '#7c8f86', Gold: '#c9a54a', Cash: '#9fb7c9', Crypto: '#b07a5a', Other: 'var(--line)' };
function renderInvest(m) {
  setTop('Investments', { back: 'closeView' });
  const r = returnsData(), al = allocation();
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  m.innerHTML = `${r.accs.length ? `<div class="card"><h2>Returns</h2><div class="big num">${inr(r.value, 0)}</div>
      ${r.cost ? `<div class="small"><span class="${r.gain >= 0 ? 'in' : 'bad'} num">${r.gain >= 0 ? '+' : ''}${inr(r.gain, 0)} (${pct(r.gain / r.cost)})</span> <span class="muted">on ${inr(r.cost, 0)} invested</span></div>` : ''}
      <div class="split" style="margin-top:12px"><div><div class="small muted">XIRR (yearly)</div><div class="mid num ${r.irr == null ? 'muted' : r.irr >= 0 ? 'in' : 'bad'}">${r.irr == null ? '…' : pct(r.irr)}</div></div>
      <div><div class="small muted">Tracked since</div><div class="num">${r.since ? fmtDate(r.since, true) : 'today'}</div></div></div>
      <p class="tiny muted" style="margin:8px 0 0">${r.irr == null ? `XIRR needs about 3 months of history in Ledger${r.since ? `. It appears around ${fmtDate(isoAdd(r.since, 90), true)}` : ''}. Until then, the gain above is against what you paid.` : 'XIRR counts the value when Ledger started tracking, money you moved into investments since then, and today\'s value.'}</p>
      <div class="list" style="margin:10px -4px 0">${r.accs.map((a) => { let v = 0, c = 0; for (const h of D.holdings.filter((h2) => h2.accountId === a.id)) { v += holdValue(h); c += holdCost(h); } return `<button class="item" data-act="openAccount" data-id="${a.id}"><div class="grow"><div class="t">${esc(a.name)}</div><div class="s">${c ? `<span class="${v >= c ? 'in' : 'bad'}">${pct((v - c) / c)}</span> on ${inr(c, 0)}` : ''}</div></div><div class="a num">${inr(v, 0)}</div></button>`; }).join('')}</div></div>` : ''}
    ${al.total ? `<div class="card"><h2>Where your money sits</h2><div class="allocbar" aria-hidden="true">${al.parts.map((p, i) => `<i style="--w:${(p.p * 100).toFixed(2)}%;background:${ALLOC_COL[p.k]};--d:${i * 70}ms"></i>`).join('')}</div>
      ${al.parts.map((p) => `<div class="row small" style="margin-top:8px"><span class="dot" style="background:${ALLOC_COL[p.k]}"></span><span class="grow">${p.k}</span><span class="num">${inr(p.v, 0)}</span><span class="muted num" style="width:3.2em;text-align:right">${Math.round(p.p * 100)}%</span></div>`).join('')}
      <p class="tiny muted" style="margin:8px 0 0">Leaves out property, vehicles and loans. Mutual funds are split by their names (debt, liquid and gilt funds count as debt).</p></div>` : ''}
`;
}

function recapData(ym) {
  const st = monthStats(ym), prev = monthStats(addMonths(ym, -1));
  const vis = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  const n = D.transactions.filter((x) => x.date.startsWith(ym) && x.amount < 0 && vis.has(x.accountId) && !['transfer', 'income'].includes(catById(x.categoryId)?.kind)).length;
  return { ym, spend: st.spend, prev: prev.spend, n, top: st.byCat.slice(0, 3).map(([k, v]) => ({ name: k === '_none' ? 'Uncategorised' : catName(k), v })) };
}
function recapCard(force) {
  const today = todayIso(), dd = +today.slice(8);
  const ym = addMonths(ymOf(today), -1);
  if (!force && (dd > 7 || D.settings.recapSeen === ym)) return '';
  const r = recapData(ym); if (!r.spend) return '';
  const max = Math.max(1, ...r.top.map((t) => t.v));
  const mn = MON[+ym.slice(5) - 1];
  const br = budgetRows(ym);
  return `<div class="card recap"><div class="row"><h2 class="grow" style="margin:0;color:var(--on-brand);opacity:.8">Your ${mn}</h2><button class="link" style="color:var(--on-brand);opacity:.8" data-act="recapHide" aria-label="Hide recap">✕</button></div>
    <div class="big money">${inr(r.spend, 0)}</div><div class="small" style="opacity:.85">spent across ${r.n} payments${r.prev ? ` · ${r.spend > r.prev ? '▲' : '▼'} ${inr(Math.abs(r.spend - r.prev), 0)} vs ${MON[+addMonths(ym, -1).slice(5) - 1]}` : ''}</div>
    ${r.top.map((t) => `<div style="margin-top:10px"><div class="row small"><span class="grow">${esc(t.name)}</span><span class="num money">${inr(t.v, 0)}</span></div><div class="bar" style="background:rgba(255,255,255,.16)"><i style="width:${(t.v / max) * 100}%;background:#e9d7ae"></i></div></div>`).join('')}
    ${br.length ? `<p class="small" style="margin:12px 0 0;opacity:.9">Budgets kept: <b>${br.filter((b) => b.pct <= 1).length} of ${br.length}</b>${br.some((b) => b.pct > 1) ? ' · over on ' + br.filter((b) => b.pct > 1).map((b) => esc(b.name)).join(', ') : ''}</p>` : ''}
    <div class="row" style="margin-top:14px"><button class="btn" style="flex:1;background:var(--on-brand);color:var(--brand-bg)" data-act="recapShare" data-ym="${ym}">Share as image</button><button class="btn" style="flex:1;background:none;border:1px solid rgba(255,255,255,.35)" data-act="recapSee" data-ym="${ym}">See ${mn}</button></div></div>`;
}
async function recapImage(ym) {
  const r = recapData(ym), W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  await document.fonts.ready;
  g.fillStyle = '#1f5c45'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#cfe0d6'; g.font = '600 34px Inter'; g.fillText(`MY ${new Date(ym + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }).toUpperCase()}`, 90, 170);
  g.fillStyle = '#f6f3ec'; g.font = '500 130px Fraunces'; g.fillText(inr(r.spend, 0), 90, 330);
  g.fillStyle = '#e9d7ae'; g.font = '400 38px Inter'; g.fillText(`spent across ${r.n} payments`, 90, 400);
  const max = Math.max(1, ...r.top.map((t) => t.v));
  r.top.forEach((t, i) => {
    const y = 540 + i * 170;
    g.fillStyle = '#f6f3ec'; g.font = '500 42px Inter'; g.fillText(t.name, 90, y);
    g.textAlign = 'right'; g.fillText(inr(t.v, 0), W - 90, y); g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(90, y + 30, W - 180, 18);
    g.fillStyle = '#e9d7ae'; g.fillRect(90, y + 30, (W - 180) * t.v / max, 18);
  });
  g.fillStyle = '#cfe0d6'; g.font = '500 32px Fraunces'; g.fillText('Ledger', 90, H - 90);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return new File([blob], `ledger-${ym}.png`, { type: 'image/png' });
}

// ---------- EPF (from the EPFO passbook) ----------
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const wmToYm = (wm) => { const [mo, y] = wm.split('-'); return `${y}-${String(MONS.indexOf(mo) + 1).padStart(2, '0')}`; };
const ymToWm = (ym) => `${MONS[+ym.slice(5) - 1]}-${ym.slice(0, 4)}`;
function epfSheet(ep) {
  ui.epf = ep;
  const accs = D.accounts.filter((a) => a.type === 'epf' && !a.archived);
  const last = ep.rows[ep.rows.length - 1];
  const bal = ep.closing || ep.opening;
  openSheet(`<h3>EPF passbook</h3>
    <p class="small muted" style="margin-top:-6px">${esc(ep.establishment)}${ep.fy ? ' · FY ' + esc(ep.fy) : ''}${ep.memberIdLast4 ? ' · member ••' + esc(ep.memberIdLast4) : ''}</p>
    <div class="split"><div><div class="small muted">Your share</div><div class="mid num">${inr(bal.employee, 0)}</div></div><div><div class="small muted">Employer share</div><div class="mid num">${inr(bal.employer, 0)}</div></div></div>
    <p class="small" style="margin:10px 0 4px">EPF balance <b class="num">${inr(bal.employee + bal.employer, 0)}</b> · pension (EPS) ${inr(bal.pension, 0)}, shown separately</p>
    <p class="small muted">${ep.rows.length} contributions this year${last ? `, last for ${esc(last.wageMonth)} (${inr(last.employee, 0)} yours + ${inr(last.employer, 0)} employer)` : ''}. ${ep.check ? '<span class="in">Totals check out.</span>' : ep.check === false ? '<span class="warn">Totals did not add up exactly; check the balances.</span>' : ''}</p>
    <form data-form="epf"><label class="f"><span>Account</span><select class="i" name="acc">${accs.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}<option value="_new">New EPF account</option></select></label>
    <button class="btn wide">Save to Ledger</button></form>`);
}
function commitEpf(ep, accId) {
  let a = accById(accId);
  if (!a) { a = { id: uid(), name: `EPF${ep.establishment ? ' · ' + ep.establishment.replace(/\s+LIMITED$/i, '').replace(/\b(\w)(\w*)/g, (x, f, r) => f + r.toLowerCase()) : ''}`, type: 'epf', owner: ownerFromName(ep.name), institution: 'EPFO', last4: ep.memberIdLast4 || null }; D.accounts.push(a); }
  const bal = ep.closing || ep.opening, last = ep.rows[ep.rows.length - 1];
  const asOn = last?.date || ep.printedOn || todayIso();
  a.epf = { employee: bal.employee, employer: bal.employer, pension: bal.pension, asOn, fy: ep.fy, opening: ep.opening, rows: ep.rows, lastWage: last ? wmToYm(last.wageMonth) : null, monthly: last ? { employee: last.employee, employer: last.employer, pension: last.pension } : (a.epf?.monthly || null), rate: a.epf?.rate || 8.25, estimated: [] };
  D.valuations = D.valuations.filter((v) => !(v.accountId === a.id && v.estimate));
  D.valuations.push({ id: uid(), accountId: a.id, date: asOn, value: bal.employee + bal.employer, note: 'EPF passbook', at: Date.now() });
  processEpf();
  return a;
}
// Adds the expected monthly contribution once its usual credit time has passed (wage month + 2, on the 1st).
// A new passbook replaces these estimates with the real figures.
function processEpf() {
  let changed = false;
  for (const a of D.accounts) {
    const e = a.epf; if (!e?.monthly || !e.lastWage || a.archived) continue;
    for (let i = 0; i < 24; i++) {
      const next = addMonths(e.lastWage, 1), due = addMonths(next, 2) + '-01';
      if (due > todayIso()) break;
      e.employee += e.monthly.employee; e.employer += e.monthly.employer; e.pension += e.monthly.pension;
      e.lastWage = next; (e.estimated ||= []).push(next);
      D.valuations.push({ id: uid(), accountId: a.id, date: due, value: e.employee + e.employer, note: `Expected contribution for ${ymToWm(next)} (estimate)`, estimate: true, at: Date.now() });
      changed = true;
    }
  }
  return changed;
}
// Interest building up since 1 April at the rate (credited by EPFO after the year ends)
function epfInterestSoFar(a) {
  const e = a.epf; if (!e?.opening) return 0;
  const r = (e.rate || 8.25) / 1200, fyStart = e.opening.asOn ? addMonths(ymOf(e.opening.asOn), 1) : null; if (!fyStart) return 0;
  const today = ymOf(todayIso());
  let bal = e.opening.employee + e.opening.employer, int = 0, ym = fyStart;
  const add = {}; for (const row of e.rows || []) add[addMonths(wmToYm(row.wageMonth), 1)] = (add[addMonths(wmToYm(row.wageMonth), 1)] || 0) + row.employee + row.employer;
  for (const ex of e.estimated || []) add[addMonths(ex, 1)] = (add[addMonths(ex, 1)] || 0) + e.monthly.employee + e.monthly.employer;
  for (let i = 0; i < 12 && ym < today; i++) { int += bal * r; bal += add[ym] || 0; ym = addMonths(ym, 1); }
  return Math.round(int);
}
function epfCard(a) {
  const e = a.epf; if (!e) return '';
  const int = epfInterestSoFar(a);
  const lastReal = (e.rows || [])[e.rows.length - 1];
  return `<div class="card"><h2>Provident fund</h2>
    <div class="split"><div><div class="small muted">Your share</div><div class="mid num">${inr(e.employee, 0)}</div></div><div><div class="small muted">Employer share</div><div class="mid num">${inr(e.employer, 0)}</div></div></div>
    <div class="split" style="margin-top:10px"><div><div class="small muted">Each month</div><div class="num">${e.monthly ? inr(e.monthly.employee + e.monthly.employer, 0) : '-'}</div><div class="tiny muted">${e.monthly ? `${inr(e.monthly.employee, 0)} yours + ${inr(e.monthly.employer, 0)} employer` : ''}</div></div>
    <div><div class="small muted">Interest this year (est.)</div><div class="num in">${inr(int, 0)}</div><div class="tiny muted">at ${e.rate}%, credited after 31 March</div></div></div>
    <p class="small muted" style="margin:10px 0 0">Pension (EPS): ${inr(e.pension, 0)}, kept out of the balance because it pays a pension rather than a lump sum.</p>
    <p class="tiny muted" style="margin:6px 0 0">${lastReal ? `Passbook up to ${esc(lastReal.wageMonth)}, credited ${fmtDate(lastReal.date, true)}.` : ''}${e.estimated?.length ? ` ${e.estimated.length} later month${e.estimated.length > 1 ? 's' : ''} added as estimates.` : ''} Upload a new passbook any time to replace estimates with real figures.</p></div>`;
}

function monthStats(ym) {
  let spend = 0, income = 0, uncategorised = 0;
  const byCat = new Map();
  const vis = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  for (const x of D.transactions) {
    if (!x.date.startsWith(ym)) continue;
    if (multi() && D.settings.who !== 'all' && !vis.has(x.accountId)) continue;
    const c = catById(x.categoryId);
    if (c?.kind === 'transfer') {
      if (x.interest) { spend += x.interest; byCat.set('interest_paid', (byCat.get('interest_paid') || 0) + x.interest); }
      continue;
    }
    if (c?.kind === 'income') { income += x.amount; continue; }
    if (!c) { uncategorised++; if (x.amount > 0) continue; }
    spend -= x.amount;
    const k = x.categoryId || '_none';
    byCat.set(k, (byCat.get(k) || 0) - x.amount);
  }
  return { spend, income, uncategorised, byCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]) };
}

function catOptions(selected, { allowNone = true } = {}) {
  const groups = {};
  for (const c of D.categories) (groups[c.group] ||= []).push(c);
  let h = allowNone ? `<option value="">Uncategorised</option>` : '';
  for (const [g, cs] of Object.entries(groups)) {
    h += `<optgroup label="${esc(g)}">` + cs.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('') + '</optgroup>';
  }
  return h;
}
function accOptions(selected, filter = () => true) {
  return D.accounts.filter((a) => !a.archived && filter(a)).map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(accShort(a))}</option>`).join('');
}
function typeOptions(selected) {
  const groups = {};
  for (const t of ACCOUNT_TYPES) (groups[t.side === 'asset' ? 'What you own' : 'What you owe'] ||= []).push(t);
  return Object.entries(groups).map(([g, ts]) => `<optgroup label="${g}">` + ts.map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${t.label}</option>`).join('') + '</optgroup>').join('');
}

// ---------- rendering ----------
function setTop(title, { back, action } = {}) {
  $('#top').innerHTML = (back ? `<button class="back" data-act="${back}">‹ Back</button>` : '') + `<h1>${esc(title)}</h1>` + (action || '');
}
// Haptic tick: iOS 18+ plays one when a switch control toggles; elsewhere this does nothing
let hapAt = 0;
function haptic() {
  try {
    const now = performance.now(); if (now - hapAt < 80) return; hapAt = now;
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    // iOS 18+: toggling a hidden <input switch> through its label plays the system tap. It must run inside the tap itself.
    const l = document.createElement('label'); l.setAttribute('aria-hidden', 'true'); l.style.display = 'none';
    const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i);
    document.head.appendChild(l); l.click(); l.remove();
  } catch { /* no haptics here */ }
}
// A short check mark for things that are done
function done(msg) {
  haptic();
  document.getElementById('done')?.remove();
  const el = document.createElement('div'); el.id = 'done'; el.className = 'pop'; el.setAttribute('role', 'status');
  el.innerHTML = `<svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="21" fill="var(--brand-bg)"/><path class="tick" d="M13 22.5l6 6 12-13" fill="none" stroke="var(--on-brand)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(msg)}</span>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 1400);
}
function render() {
  if (!D) return;
  const page = ui.view?.page ? ui.view.page + (ui.view.id || '') : ui.tab;
  const main = $('#main');
  if (page !== ui.lastPage) { ui.lastPage = page; ui.draw = true; main.classList.remove('anim'); void main.offsetWidth; main.classList.add('anim'); clearTimeout(ui.animT); ui.animT = setTimeout(() => { main.classList.remove('anim'); ui.draw = false; }, 900); }
  $('#app').classList.toggle('masked', !!D.settings.masked);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const m = $('#main');
  if (ui.view?.page === 'account') { renderAccount(m, ui.view.id); requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.ringarc').forEach((c) => { c.style.strokeDashoffset = c.style.getPropertyValue('--off'); }))); return; }
  if (ui.view?.page === 'ask') return renderAsk(m);
  if (ui.view?.page === 'bills') return renderBills(m);
  if (ui.view?.page === 'receipts') return renderReceipts(m);
  if (ui.view?.page === 'budgets') return renderBudgets(m);
  if (ui.view?.page === 'dupes') return renderDupes(m);
  if (ui.view?.page === 'tags') return renderTags(m);
  if (ui.view?.page === 'invest') return renderInvest(m);

  ({ home: renderHome, tx: renderTx, accounts: renderAccounts, import: renderImport, vault: renderVault, more: renderMore }[ui.tab])(m);
  requestAnimationFrame(() => document.querySelectorAll('.whoseg .pill[data-to]').forEach((p2) => { p2.style.transform = `translateX(${p2.dataset.to * 100}%)`; }));
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.ringarc').forEach((c) => { c.style.strokeDashoffset = c.style.getPropertyValue('--off'); })));
}

const ICON = {
  Income: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>', Food: '<path d="M3 12h18a9 9 0 0 1-18 0z"/><path d="M8 8c0-2 1-3 1-3M12 8c0-2 1-3 1-3M16 8c0-2 1-3 1-3"/>',
  Shopping: '<path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>', Transport: '<path d="M5 16l1.5-6A2 2 0 0 1 8.4 8.5h7.2a2 2 0 0 1 1.9 1.5L19 16"/><path d="M4 16h16v3H4z"/><circle cx="7.5" cy="19" r="1"/><circle cx="16.5" cy="19" r="1"/>',
  Bills: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>', Health: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  Pets: '<circle cx="8" cy="9" r="1.6"/><circle cx="16" cy="9" r="1.6"/><circle cx="5.5" cy="13" r="1.4"/><circle cx="18.5" cy="13" r="1.4"/><path d="M8.5 17.5c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5c0 1.5-1.5 2-3.5 2s-3.5-.5-3.5-2z"/>',
  Personal: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/>', Financial: '<path d="M3 10l9-5 9 5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  Transfers: '<path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/>', none: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7"/><path d="M12 17h.01"/>',
};
const TONE = { Income: 'sage', Food: 'clay', Shopping: 'sand', Transport: 'slate', Bills: 'slate', Health: 'clay', Pets: 'sand', Personal: 'sage', Financial: 'grey', Transfers: 'grey', none: 'grey' };
const catIcon = (catId) => { const g = catById(catId)?.group; const k = ICON[g] ? g : 'none'; return `<div class="ico tone-${TONE[k]}" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg></div>`; };
function txItem(x, showAcc = true) {
  const c = catById(x.categoryId);
  const a = accById(x.accountId);
  const sug = !c && x.suggest && catById(x.suggest) ? ` <span class="badge" data-act="acceptSug" data-id="${x.id}">AI: ${esc(catName(x.suggest))} ✓</span>` : '';
  const sub = [c ? c.name : '<span class="warn">Uncategorised</span>' + sug, showAcc && a ? esc(accShort(a)) : '', x.source === 'sms' ? 'from SMS' : x.source === 'log' ? 'logged' : '', x.transferId ? 'matched transfer' : '', x.refundOf ? '<span class="in">refund</span>' : refundFor(x) ? '<span class="in">refunded</span>' : '', ...tagsOf(x).map((t) => `<span class="tagchip">#${esc(t)}</span>`), D.receipts?.some((r) => r.txId === x.id) ? '📎' : ''].filter(Boolean).join(' · ');
  return `<div class="sw" data-id="${x.id}"><div class="sw-acts"><button data-act="swCat" data-id="${x.id}">Category</button><button data-act="swTransfer" data-id="${x.id}">Transfer</button></div><button class="item" data-act="editTx" data-id="${x.id}">
    ${catIcon(x.categoryId)}
    <div class="grow"><div class="t">${esc(x.payee || x.description)}</div><div class="s">${sub}</div></div>
    <div class="a num ${x.amount > 0 ? 'in' : ''}">${x.amount > 0 ? '+' : ''}${inr(x.amount)}</div></button></div>`;
}
const dayLabel = (d) => { const n = daysUntil(d); if (n === 0) return 'Today'; if (n === -1) return 'Yesterday'; const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', ...(dt.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); };

const hasPriced = () => D.holdings.some((h) => h.qty != null);
const refreshBtn = `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="refreshAll" aria-label="Refresh prices">🔄</button>`;
function renderHome(m) {
  setTop('', { action: (hasPriced() ? refreshBtn : '') + `<button class="btn" style="min-height:40px;padding:6px 14px;border-radius:20px" data-act="quickAdd" aria-label="Quick add">+ Add</button>` });
  if (!D.accounts.length) {
    m.innerHTML = `<div class="card"><h2>Welcome</h2><p>Everything you add stays on this phone, encrypted. Start with a statement.</p>
      <button class="btn wide" data-act="tab" data-tab="import">Import a statement</button>
      <p class="small muted" style="margin-top:12px">Or <button class="link" data-act="addAccount">add an account by hand</button>.</p></div>`;
    return;
  }
  recordPrices();
  if (processBills() | matchRefunds()) save();
  budgetNudge();
  const nw = netWorth();
  const loans = loansTotal();
  const mt = marketsToday();
  const ym = ymOf(todayIso());
  const visIds = new Set(D.accounts.filter((a) => accVisible(a)).map((a) => a.id));
  const s = monthStats(ym), prev = monthStats(addMonths(ym, -1));
  const months = [-5, -4, -3, -2, -1, 0].map((k) => { const y = addMonths(ym, k); return { y, v: monthStats(y).spend }; });
  const maxV = Math.max(1, ...months.map((x) => x.v));
  const top = s.byCat.slice(0, 5); const topMax = Math.max(1, ...top.map((x) => x[1]));
  const dues = D.accounts.filter((a) => accVisible(a) && a.type === 'credit_card' && !a.archived && a.statement?.dueDate && a.statement.totalDue > 0 && daysUntil(a.statement.dueDate) >= -3 && !a.statement.paid);
  const recent = [...D.transactions].filter((x) => visIds.has(x.accountId)).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '')).slice(0, 5);
  const backupOld = D.transactions.length && (!D.settings.lastBackupAt || (Date.now() - new Date(D.settings.lastBackupAt)) > 7 * 864e5);

  const hr = new Date().getHours(), me = D.members.find((x) => x.id === 'me')?.name || '';
  const todayOut = D.transactions.filter((x) => x.date === todayIso() && x.amount < 0 && visIds.has(x.accountId) && !['transfer', 'income'].includes(catById(x.categoryId)?.kind)).reduce((t, x) => t - x.amount, 0);
  const nextDue = [...dues.map((a) => ({ t: 'card due', d: a.statement.dueDate })), ...(D.bills || []).filter((b) => b.next && daysUntil(b.next) >= 0).map((b) => ({ t: b.name.toLowerCase().includes('emi') ? b.name : b.name + ' due', d: b.next }))].sort((p, q) => p.d.localeCompare(q.d))[0];
  const summary = [todayOut ? `<span class="money">${inr(todayOut, 0)}</span> spent today` : 'Nothing spent today', nextDue ? `${esc(nextDue.t)} ${dueWord(nextDue.d)}` : ''].filter(Boolean).join(' · ');
  m.innerHTML = `<div class="hello"><div class="d">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</div><div class="g">Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}${me && me !== 'Me' ? ', ' + esc(me) : ''}</div><div class="s">${summary}</div><div class="row" style="gap:16px;margin-top:4px"><button class="link small" data-act="pickFile" data-kind="inbox">📥 Read SMS &amp; logs</button><button class="link small" data-act="summarySheet">✨ Summary for AI</button></div></div>
  ${whoSwitch()}
  <div class="card"><h2><button class="eye" data-act="toggleMask" aria-pressed="${!!D.settings.masked}" aria-label="${D.settings.masked ? 'Show amounts' : 'Hide amounts'}">Net worth${multi() ? ' · ' + esc(D.settings.who === 'all' ? 'Combined' : memberName(D.settings.who)) : ''} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${D.settings.masked ? '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1.1"/>' : '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'}</svg></button></h2>
    <div class="big num ${ui.swap ? 'swapin' : ''}" data-nwval>${inr(nw.net, 0)}</div>
    <div class="${ui.swap ? 'swapin' : ''}">${chartCard('nw')}</div>
    ${mt ? `<p class="small" style="margin:6px 0 0">Stocks today: <b class="num ${mt.chg >= 0 ? 'in' : 'bad'}">${chgTxt(mt.chg, mt.base)}</b></p>` : ''}
    <div class="split" style="margin-top:10px">
      <div><div class="small muted">Assets</div><div class="num">${compact(nw.assets)}</div></div>
      <div><div class="small muted">${D.settings.loansSeparate ? 'Card dues & other' : 'Liabilities'}</div><div class="num">${compact(nw.liabilities)}</div></div>
    </div>
    ${D.settings.loansSeparate && loans ? `<button class="item" style="margin:10px -4px 0;padding:10px 4px;border-top:1px solid var(--line)" data-act="tab" data-tab="accounts"><div class="grow"><div class="small muted">Loans, kept out of net worth</div><div class="num">${inr(loans, 0)}</div></div><div class="muted">›</div></button>` : ''}</div>
  ${safeCard()}
  ${recapCard()}
  ${dupesCard()}
  ${dues.map((a) => { const d = daysUntil(a.statement.dueDate); return `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openAccount" data-id="${a.id}">
      <div class="grow"><div class="t">${esc(accShort(a))} due ${d === 0 ? 'today' : d < 0 ? `${-d} days ago` : `in ${d} days`}</div>
      <div class="s">${fmtDate(a.statement.dueDate, true)} · minimum ${inr(a.statement.minDue, 0)}</div></div>
      <div class="a num ${d <= 3 ? 'bad' : ''}">${inr(a.statement.totalDue, 0)}</div></button>`; }).join('')}
  ${D.transactions.length ? `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openAsk"><div class="ico">AI</div><div class="grow"><div class="t">Ask Ledger</div><div class="s">“How can I spend less?”</div></div><div class="muted">›</div></button>` : ''}
  ${upcomingCard()}
  ${D.inbox.length ? `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="tab" data-tab="import"><div class="grow"><div class="t">${D.inbox.length} SMS need attention</div><div class="s">Assign an account or enter them by hand</div></div><div class="muted">›</div></button>` : ''}
  ${backupOld ? `<div class="card row"><div class="grow small"><b>Weekly backup.</b> ${D.settings.lastBackupAt ? 'Last one ' + fmtDate(D.settings.lastBackupAt.slice(0, 10)) + '.' : 'Not backed up yet.'} Save it to iCloud Drive in one tap.</div><button class="btn" data-act="backup">Back up</button></div>` : ''}
  <div class="card"><h2>Spent in ${monthLabel(ym)}</h2>
    <div class="row"><div class="grow"><div class="mid num">${inr(s.spend, 0)}</div>
      <div class="small muted">${prev.spend ? `${s.spend > prev.spend ? '▲' : '▼'} ${inr(Math.abs(s.spend - prev.spend), 0)} vs last month` : ''}</div></div>
      ${s.income ? `<div style="text-align:right"><div class="small muted">Income</div><div class="in num">${inr(s.income, 0)}</div></div>` : ''}</div>
    <div class="cols">${months.map((x) => `<div class="${x.y === ym ? 'now' : ''}"><i style="height:${Math.max(3, (x.v / maxV) * 70)}px"></i><span>${MON[+x.y.slice(5) - 1]}</span></div>`).join('')}</div>
    ${s.uncategorised ? `<p class="small" style="margin:12px 0 0"><button class="link" data-act="showUncat">${s.uncategorised} transactions need a category ›</button></p>` : ''}
  </div>
  ${budgetCard()}
  ${top.length ? `<div class="card"><h2>Top categories</h2>${top.map(([id, v]) => `
    <button class="item" style="padding:8px 0" data-act="showCat" data-id="${id}"><div class="grow"><div class="row"><span class="grow">${esc(id === '_none' ? 'Uncategorised' : catName(id))}</span><span class="num">${inr(v, 0)}</span></div>
    <div class="bar"><i style="width:${(v / topMax) * 100}%"></i></div></div></button>`).join('')}</div>` : ''}
  ${recent.length ? `<h2 class="small muted" style="margin:18px 4px 8px;text-transform:uppercase;letter-spacing:.06em">Recent</h2><div class="list">${recent.map((x) => txItem(x)).join('')}</div>` : ''}`;
}

function filteredTx() {
  const q = ui.q.trim().toLowerCase();
  return D.transactions.filter((x) => {
    if (!q && !ui.src && !x.date.startsWith(ui.month)) return false;
    if (ui.acc && x.accountId !== ui.acc) return false;
    if (ui.src && x.source !== ui.src) return false;
    if (multi() && D.settings.who !== 'all' && !ui.acc && !accVisible(accById(x.accountId) || {})) return false;
    if (ui.cat === '_none' ? x.categoryId : ui.cat && x.categoryId !== ui.cat) return false;
    if (q && !`${x.payee} ${x.description} ${x.notes || ''} ${tagsOf(x).join(' ')} ${catName(x.categoryId)} ${(x.amount / 100).toFixed(2)}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
}
function renderTx(m) {
  setTop('Activity', { action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="transferSheet">⇄</button><button class="btn" style="min-height:36px;padding:6px 14px;border-radius:18px" data-act="quickAdd">+ Add</button>` });
  ui.month ||= ymOf(todayIso());
  m.innerHTML = `
    ${whoSwitch()}<input class="search" id="q" type="search" placeholder="Search all transactions" value="${esc(ui.q)}" autocomplete="off">
    ${ui.src ? `<p class="small">Showing unconfirmed SMS entries only. <button class="link" data-act="clearSrc">Show all</button></p>` : ''}
    <div class="month ${ui.q || ui.src ? 'hidden' : ''}"><button data-act="month" data-d="-1">‹</button><b>${monthLabel(ui.month)}</b><button data-act="month" data-d="1">›</button></div>
    <div class="chips">
      <select class="chip ${ui.acc ? 'on' : ''}" id="fAcc"><option value="">All accounts</option>${accOptions(ui.acc)}</select>
      <select class="chip ${ui.cat ? 'on' : ''}" id="fCat"><option value="">All categories</option><option value="_none" ${ui.cat === '_none' ? 'selected' : ''}>Uncategorised</option>${catOptions(ui.cat, { allowNone: false })}</select>
    </div>
    ${ui.cat === '_none' && D.settings.ai?.model ? `<div class="row" style="margin:0 0 10px"><button class="btn ghost" data-act="aiSuggest">Suggest categories with AI</button>${D.transactions.some((x) => !x.categoryId && x.suggest) ? '<button class="link" data-act="acceptAllSug">Accept all</button>' : ''}</div><div class="small muted" id="aiStatus"></div>` : ''}
    <div id="txList"></div>`;
  renderTxList();
  $('#q').addEventListener('input', (e) => { ui.q = e.target.value; $('.month').classList.toggle('hidden', !!ui.q); renderTxList(); });
  $('#fAcc').addEventListener('change', (e) => { ui.acc = e.target.value; render(); });
  $('#fCat').addEventListener('change', (e) => { ui.cat = e.target.value; render(); });
}
function renderTxList() {
  const list = filteredTx();
  if (!list.length) { $('#txList').innerHTML = `<div class="card" style="text-align:center;padding:26px 20px"><svg width="80" height="60" viewBox="0 0 96 72" fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="16" y="12" width="64" height="48" rx="8"/><path d="M28 28h40M28 38h28M28 48h18"/></svg><div class="serif" style="font-size:1.25rem;margin:8px 0 4px">${ui.q ? 'Nothing matches' : 'No transactions here'}</div><p class="small muted">${ui.q ? 'Try a payee, an amount or a category.' : 'Import a statement, read your SMS, or add one with + Add.'}</p></div>`; return; }
  let out = 0, inn = 0;
  for (const x of list) { const k = catById(x.categoryId)?.kind; if (k === 'transfer') continue; if (x.amount < 0) out -= x.amount; else inn += x.amount; }
  let h = `<div class="small muted" style="margin:0 4px 4px">${list.length} transactions · out ${inr(out, 0)} · in ${inr(inn, 0)} <span class="tiny">(excl. transfers)</span></div>`;
  const byDay = {};
  for (const x of list) (byDay[x.date] ||= []).push(x);
  for (const [d, xs] of Object.entries(byDay)) {
    const o = xs.filter((x) => x.amount < 0 && catById(x.categoryId)?.kind !== 'transfer').reduce((t, x) => t - x.amount, 0);
    const i2 = xs.filter((x) => x.amount > 0 && catById(x.categoryId)?.kind !== 'transfer').reduce((t, x) => t + x.amount, 0);
    h += `<div class="day"><span>${esc(dayLabel(d))}</span><span class="num">${[o ? inr(o, 0) + ' out' : '', i2 ? inr(i2, 0) + ' in' : ''].filter(Boolean).join(' · ') || 'transfers'}</span></div><div class="list">${xs.map((x) => txItem(x, !ui.acc)).join('')}</div>`;
  }
  $('#txList').innerHTML = h;
}

const acctTone = (a) => ({ Bank: 'sage', 'Cash & wallets': 'sage', 'Credit cards': 'slate', Investments: 'sand', Deposits: 'sand', Retirement: 'sand' }[typeOf(a.type).group] || 'grey');
function sparkline(a) {
  const today = todayIso(), dates = []; for (let i = 29; i > 0; i -= 2) dates.push(isoAdd(today, -i)); dates.push(today);
  const v = seriesFor(dates, { accId: a.id }); const lo = Math.min(...v), hi = Math.max(...v);
  if (hi === lo) return '<svg width="64" height="28" viewBox="0 0 60 24" aria-hidden="true"><path d="M0,12 L60,12" stroke="currentColor" stroke-width="1.6" opacity=".5"/></svg>';
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1) * 60).toFixed(1)},${(2 + (1 - (y - lo) / (hi - lo)) * 20).toFixed(1)}`).join('');
  return `<svg width="64" height="28" viewBox="0 0 60 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function renderAccounts(m) {
  setTop('Accounts', { action: (hasPriced() ? refreshBtn : '') + `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="addAccount">+ Add</button>` });
  if (!D.accounts.length) { m.innerHTML = `<div class="card" style="text-align:center;padding:26px 20px"><div class="serif" style="font-size:1.3rem;margin-bottom:6px">No accounts yet</div><p class="small muted">Import a bank or card statement and Ledger sets the account up for you.</p><button class="btn" data-act="tab" data-tab="import">Import a statement</button><p class="small" style="margin:12px 0 0"><button class="link" data-act="addAccount">Or add one by hand</button></p></div>`; return; }
  const nw = netWorth();
  const groups = {};
  for (const a of D.accounts.filter((a) => !a.archived && accVisible(a))) (groups[typeOf(a.type).group] ||= []).push(a);
  const order = [...new Set(ACCOUNT_TYPES.map((t) => t.group))];
  m.innerHTML = whoSwitch() + `<div class="card"><h2>Net worth${multi() ? ' · ' + esc(D.settings.who === 'all' ? 'Combined' : memberName(D.settings.who)) : ''}</h2><div class="big num">${inr(nw.net, 0)}</div>${D.settings.loansSeparate && loansTotal() ? `<div class="small muted">Loans ${inr(loansTotal(), 0)}, kept out of net worth</div>` : ''}${multi() && D.settings.who !== 'all' && D.accounts.some((a) => ownerOf(a) === 'joint') ? '<div class="tiny muted">Joint accounts count half here.</div>' : ''}</div>` +
    (allocation().total ? `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openInvest"><div class="ico tone-sage" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l5-6 4 3 7-9"/><path d="M15 6h5v5"/></svg></div><div class="grow"><div class="t">Investments</div><div class="s">Returns and where your money sits</div></div><div class="muted">›</div></button>` : '') +
    order.filter((g) => groups[g]).map((g) => {
      const total = groups[g].reduce((s2, a) => s2 + Math.round((balance(a) - unbilledEmi(a)) * shareOf(a)), 0);
      return `<div class="day"><span>${g}</span><span class="num">${inr(total, 0)}</span></div><div class="acards">${groups[g].map((a) => {
        const b = balance(a), emi = unbilledEmi(a), loan = isLoanType(a.type);
        const sub = [multi() ? memberName(ownerOf(a)) : '', a.institution, a.last4 ? '••' + a.last4 : '', a.type === 'credit_card' && a.statement?.dueDate && !a.statement.paid && daysUntil(a.statement.dueDate) >= 0 ? 'due ' + fmtDate(a.statement.dueDate) : '', loan && a.loan ? 'EMI ' + inr(a.loan.emi, 0) : ''].filter(Boolean).join(' · ');
        return `<button class="acard ${loan ? 'outline' : 'tone-' + acctTone(a)}" data-act="openAccount" data-id="${a.id}">
          <span class="grow"><span class="n">${esc(a.name)}</span><span class="s">${esc(sub || typeOf(a.type).label)}</span><span class="v num">${inr(b, 0)}${emi ? ` <span class="tiny muted">+ ${inr(emi, 0)} EMI</span>` : ''}</span></span>
          ${loan ? '' : sparkline(a)}</button>`;
      }).join('')}</div>`;
    }).join('') +
    (D.accounts.some((a) => a.archived) ? `<p class="small muted center">Archived: ${D.accounts.filter((a) => a.archived).map((a) => `<button class="link" data-act="openAccount" data-id="${a.id}">${esc(a.name)}</button>`).join(', ')}</p>` : '');
}

function renderAccount(m, id) {
  const a = accById(id);
  if (!a) { ui.view = null; return render(); }
  const t = typeOf(a.type);
  setTop(a.name, { back: 'closeView', action: (D.holdings.some((h) => h.accountId === a.id && h.qty != null) ? refreshBtn : '') + `<button class="link" data-act="editAccount" data-id="${a.id}">Edit</button>` });
  const b = balance(a);
  const txs = D.transactions.filter((x) => x.accountId === a.id).sort((p, q) => q.date.localeCompare(p.date) || (q.time || '').localeCompare(p.time || ''));
  recordPrices();
  let h = `<div class="card"><h2>${esc(t.label)}${a.last4 ? ' ••' + a.last4 : ''}</h2><div class="big num" data-nwval>${inr(b)}</div>${chartCard('acc', { accId: a.id })}`;
  const hasHold = D.holdings.some((x) => x.accountId === a.id);
  if (t.mode === 'value' && hasHold) h += `<div class="small muted">${D.settings.priceRelay && D.holdings.some((x) => x.accountId === a.id && x.type !== 'mf') ? 'Market value at live prices' : D.holdings.some((x) => x.accountId === a.id && x.type === 'mf' && x.qty != null) ? 'Market value at latest NAVs' : 'Market value from your last holdings file'}</div>`;
  else if (t.mode === 'value') {
    const v = latestValuation(a.id);
    h += `<div class="small muted">${v ? `Value as on ${fmtDate(v.date, true)}` : 'No value entered yet'}</div><div style="margin-top:12px"><button class="btn" data-act="addValuation" data-id="${a.id}">Update value</button></div>`;
  }
  if (t.mode === 'ledger') h += `<div class="small muted">${a.balanceSetAt ? `You confirmed this balance on ${fmtDate(a.balanceSetAt, true)}` : a.statement?.periodTo ? `From statements up to ${fmtDate(a.statement.periodTo, true)}, plus later entries` : ''}</div>
    <div class="row" style="margin-top:12px"><button class="btn" style="flex:1" data-act="setBalance" data-id="${a.id}">Update balance</button><button class="btn ghost" style="flex:1" data-act="transferSheet" data-from="${a.id}">Transfer</button></div>`;
  h += `</div>`;
  if (hasHold) h += holdingsCard(a);
  if (a.epf) h += epfCard(a);
  if (isLoanType(a.type)) h += a.loan ? loanCard(a) : `<div class="card row"><div class="grow small">Track this loan's EMIs automatically?</div><button class="btn ghost" data-act="editAccount" data-id="${a.id}">Set up EMI</button></div>`;
  const st = a.statement;
  if (a.type === 'credit_card' && st) {
    const d = st.dueDate ? daysUntil(st.dueDate) : null;
    const emi = unbilledEmi(a);
    const lastStmt = a.statementBalanceCheck;
    h += `<div class="card"><h2>Latest statement · ${fmtDate(st.statementDate, true)}</h2>
      <div class="split"><div><div class="small muted">Total due</div><div class="mid num">${inr(st.totalDue, 0)}</div></div>
      <div><div class="small muted">Minimum due</div><div class="mid num">${inr(st.minDue, 0)}</div></div></div>
      <p class="small" style="margin:10px 0 0">Due <b>${fmtDate(st.dueDate, true)}</b>${d != null ? ` (${d === 0 ? 'today' : d < 0 ? `${-d} days ago` : `in ${d} days`})` : ''}
      ${st.totalDue > 0 ? ` · <button class="link" data-act="togglePaid" data-id="${a.id}">${st.paid ? 'Marked paid ✓' : 'Mark as paid'}</button>` : ''}</p>
      ${st.creditLimit ? `<p class="small muted" style="margin:6px 0 0">Limit ${inr(st.creditLimit, 0)} · available ${inr(st.availableLimit, 0)}</p>` : ''}
      ${lastStmt ? `<p class="small" style="margin:8px 0 0">${lastStmt.ok ? '<span class="badge">Balance matches statement</span>' : `<span class="badge warn">Balance differs from statement by ${inr(lastStmt.diff)}</span>`}</p>` : ''}
      ${lastStmt?.strays ? `<p class="small warn" style="margin:6px 0 0">${lastStmt.strays} SMS entries in this period were not on the statement (declined or reversed?). <button class="link" data-act="showStrays" data-id="${a.id}">Review</button></p>` : ''}
    </div>`;
    if (st.emiLoans?.length) {
      h += `<div class="card"><h2>Card EMIs · ${inr(emi, 0)} principal not yet billed</h2><table class="t"><tr><th>Booked</th><th class="r">Amount</th><th class="r">Left</th><th class="r">Months</th></tr>
      ${st.emiLoans.map((l) => `<tr><td>${fmtDate(l.booked)}<div class="tiny muted">${l.rate}% · ${l.tenure}m</div></td><td class="r num">${inr(l.amount, 0)}</td><td class="r num">${inr(l.principalLeft, 0)}</td><td class="r">${l.monthsLeft}</td></tr>`).join('')}</table>
      <p class="tiny muted" style="margin:8px 0 0">Plus ${inr(st.emiLoans.reduce((s, l) => s + (l.interestLeft || 0), 0), 0)} interest still to be charged. Net worth counts the unbilled principal as debt.</p></div>`;
    }
  }
  if (t.mode === 'value') {
    const vals = D.valuations.filter((v) => v.accountId === a.id).sort((p, q) => q.date.localeCompare(p.date));
    if (vals.length) h += `<div class="day"><span>Value history</span></div><div class="list">${vals.map((v) => `<button class="item" data-act="editValuation" data-id="${v.id}"><div class="grow">${fmtDate(v.date, true)}${v.note ? `<div class="s">${esc(v.note)}</div>` : ''}</div><div class="a num">${inr(v.value, 0)}</div></button>`).join('')}</div>`;
  }
  if (t.mode === 'ledger') {
    h += `<div class="day"><span>${txs.length} transactions</span><button class="link" data-act="addTx" data-acc="${a.id}">+ Add</button></div>`;
    h += txs.length ? `<div class="list">${txs.slice(0, 200).map((x) => txItem(x, false)).join('')}</div>` : `<div class="empty">No transactions yet.</div>`;
    if (txs.length > 200) h += `<p class="small muted">Showing the latest 200. Use Activity to see the rest.</p>`;
  }
  m.innerHTML = h;
}

// ---------- import ----------
function renderImport(m) {
  setTop('Import');
  if (ui.imp) return renderImportPreview(m);
  if (ui.batch?.length) return renderBatch(m);
  const imps = [...D.imports].sort((a, b) => b.at.localeCompare(a.at));
  m.innerHTML = `
  <div class="card"><h2>Add statements</h2>
    <button class="btn wide" data-act="pickFile" data-kind="any">Upload statements</button>
    <p class="small muted">Pick one or several PDFs or CSVs at once. Ledger recognises each one and sets up the accounts for you. Works now: HDFC credit cards, DNS Bank savings, Zerodha holdings (Excel), CAMS/KFintech CAS, distributor portfolio summaries, any bank CSV or Excel export. Password-protected files are fine.</p>
  </div>
  <div class="card"><h2>Bank SMS</h2>
    <button class="btn wide" data-act="pickFile" data-kind="inbox">Read SMS inbox file</button>
    <p class="small muted">Picks up new SMS saved by your Shortcut. Already-read messages are skipped.</p>
    <div class="row"><button class="btn ghost" style="flex:1" data-act="pasteSms">Paste an SMS</button><button class="btn ghost" style="flex:1" data-act="smsSetup">Set up auto-capture</button></div>
  </div>
  ${D.inbox.length ? `<div class="day"><span>${D.inbox.length} SMS need attention</span></div><div class="list">${D.inbox.map(inboxItem).join('')}</div>` : ''}
  ${imps.length ? `<div class="day"><span>Past imports</span></div><div class="list">${imps.map((i) => `<div class="item"><div class="grow"><div class="t">${esc(accShort(accById(i.accountId)) || 'Deleted account')}</div>
    <div class="s">${esc(i.fileName)} · ${i.count} added${i.period ? ` · ${fmtDate(i.period.from)} to ${fmtDate(i.period.to, true)}` : ''}</div></div>
    <button class="link" data-act="undoImport" data-id="${i.id}">Undo</button></div>`).join('')}</div>` : ''}`;
}

async function loadPdfjs() {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}
async function readPdf(file, password) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, password, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] })));
  }
  await doc.destroy();
  return pages;
}
// Opens a PDF, trying saved statement passwords before asking. Returns pages or null (prompt shown).
async function openPdf(file, password) {
  const tries = password != null ? [password] : [undefined, ...(D.settings.pdfPasswords || []).map((p) => p.pw)];
  for (const pw of tries) {
    try { return { pages: await readPdf(file, pw), pw }; }
    catch (e) { if (e?.name !== 'PasswordException') throw e; }
  }
  return null;
}
function askPdfPassword(file, wrong) {
  pendingFile = file;
  openSheet(`<h3>Password for ${esc(file.name)}</h3><p class="small muted">${wrong ? 'That password did not work. ' : ''}HDFC cards: first 4 letters of your name in capitals + last 4 card digits. HDFC savings: your Customer ID. CAS: your PAN. DNS Bank: your Customer ID.</p>
    <form data-form="pdfPass"><input class="i" name="pw" type="password" autocomplete="off" autofocus>
    <label class="row small" style="margin:10px 0"><input type="checkbox" class="chk" name="remember" checked><span>Remember it in my encrypted vault, so next month's statement opens by itself</span></label>
    <button class="btn wide">Open</button></form>`);
}
// Turns a file into an import draft (imp), or explains why it can't.
async function draftFromPdf(file, password) {
  const opened = await openPdf(file, password);
  if (!opened) return { needPassword: true, wrong: password != null };
  const { pages } = opened;
  const text = P.toLines(pages).map((l) => l.text).join('\n');
  if (P.detectEpfPassbook(text)) { const ep = P.parseEpfPassbook(text); return ep ? { epf: ep } : { unsupported: true }; }
  if (P.detectHdfcCard(text)) {
    const parsed = P.parseHdfcCard(pages);
    const match = D.accounts.find((a) => a.type === 'credit_card' && !a.archived && a.last4 && a.last4 === parsed.statement.cardLast4);
    return { imp: { kind: 'card', fileName: file.name, parsed, accountId: match?.id || '_new', newName: `HDFC ${parsed.statement.product || 'Credit Card'}`, newType: 'credit_card', rows: [] }, pw: opened.pw };
  }
  if (P.detectCas(text) || P.detectHoldingsReport(text)) {
    const isCas = P.detectCas(text);
    const parsed = isCas ? P.parseCas(pages) : P.parseHoldingsReport(pages);
    const st = parsed.statement;
    const match = D.accounts.find((a) => !a.archived && a.type === 'mutual_fund' && st.pan && (a.mfPan === st.pan || (a.mfKey || '').startsWith(st.pan + '|')));
    return { imp: { kind: 'cas', fileName: file.name, parsed, accountId: match?.id || '_new', newName: isCas ? 'Mutual funds' : `Mutual funds${st.holder ? ' · ' + st.holder.split(/\s+/)[0].toLowerCase().replace(/^./, (c) => c.toUpperCase()) : ''}`, newType: 'mutual_fund', rows: [] }, pw: opened.pw };
  }
  if (P.detectMfSummary(text)) {
    const parsed = P.parseMfSummary(pages);
    const st = parsed.statement;
    const match = D.accounts.find((a) => !a.archived && a.type === 'mutual_fund' && ((st.pan && a.mfKey === `${st.pan}|${st.distributor}`) || (!a.mfKey && a.institution === st.distributor)));
    return { imp: { kind: 'mfsummary', fileName: file.name, parsed, accountId: match?.id || '_new', newName: 'Mutual funds', newType: 'mutual_fund', rows: [] }, pw: opened.pw };
  }
  if (P.detectBankStatement(text)) {
    const parsed = P.parseBankPdf(pages);
    const st = parsed.statement;
    const match = D.accounts.find((a) => !a.archived && a.type !== 'credit_card' && a.last4 && a.last4 === st.last4 && (!a.institution || !st.bank || a.institution === st.bank));
    const loans = [...new Set(parsed.transactions.filter((t) => t.loanAccount).map((t) => t.loanAccount))]
      .filter((no) => !D.accounts.some((a) => a.last4 === no.slice(-4) && typeOf(a.type).side === 'liability'));
    return { imp: { kind: 'bankpdf', fileName: file.name, parsed, accountId: match?.id || '_new', newName: `${st.bank || 'Bank'} ${st.accountType === 'current' ? 'Current' : 'Savings'}`.trim(), newType: st.accountType || 'savings', rows: [], loans: loans.map((no) => ({ no, create: true, type: 'home_loan', name: `${st.bank} Home Loan`.trim(), outstanding: '' })) }, pw: opened.pw };
  }
  return { unsupported: true };
}
async function handlePdf(file, password) {
  let r;
  try { r = await draftFromPdf(file, password); } catch (e) { console.error(e); toast('Could not read that PDF.'); return; }
  if (r.needPassword) return askPdfPassword(file, r.wrong);
  if (r.unsupported) { toast(`${file.name}: this statement type isn't supported yet. Send a sample to Claude.`, 4500); return; }
  if (password && pendingRemember) rememberPassword(password);
  if (r.epf) return epfSheet(r.epf);
  queueDraft(r.imp);
}
let pendingRemember = false;
function rememberPassword(pw) {
  D.settings.pdfPasswords ||= [];
  if (!D.settings.pdfPasswords.some((p) => p.pw === pw)) { D.settings.pdfPasswords.push({ pw, at: new Date().toISOString() }); save(); }
}
// Drafts collect into a batch; the review screen shows them all with one Confirm.
function queueDraft(imp) {
  ui.batch ||= [];
  ui.batch.push(imp);
  ui.imp = imp; buildRows();
  ui.imp = null;
  ui.tab = 'import'; ui.view = null; $('#toast').classList.remove('on'); render();
}
let pendingFile = null;

async function handleXlsx(file) {
  const sheets = await readXlsx(await file.arrayBuffer());
  if (P.detectZerodhaHoldings(sheets)) {
    const parsed = P.parseZerodhaHoldings(sheets);
    const st = parsed.statement;
    const match = D.accounts.find((a) => !a.archived && ((st.clientId && a.brokerId === st.clientId) || (!a.brokerId && a.institution === 'Zerodha' && a.type === 'stocks')));
    queueDraft({ kind: 'holdings', fileName: file.name, parsed, accountId: match?.id || '_new', newName: 'Zerodha', newType: 'stocks', rows: [] });
    return;
  }
  // Any other spreadsheet: treat the first sheet with data like a CSV (bank statement exports)
  const sh = sheets.find((x) => x.rows.length > 2) || sheets[0];
  if (!sh) return toast('That spreadsheet is empty.');
  const rows = sh.rows.map((r) => Array.from(r, (c) => c == null ? '' : typeof c === 'number' && c > 20000 && c < 80000 && Number.isInteger(c) ? excelDate(c) : String(c).trim())).filter((r) => r.some((c) => c !== ''));
  const map = P.guessCsvMapping(rows);
  queueDraft({ kind: 'csv', fileName: file.name, csvRows: rows, map, accountId: D.accounts.find((a) => ['savings', 'current'].includes(a.type))?.id || '_new', newName: '', newType: 'savings', rows: [] });
}
// Excel stores dates as days since 1899-12-30
function excelDate(n) { const d = new Date(Date.UTC(1899, 11, 30) + n * 864e5); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; }

async function handleCsv(file) {
  const text = await file.text();
  const rows = P.parseCSV(text);
  if (rows.length < 2) return toast('That file has no rows.');
  const map = P.guessCsvMapping(rows);
  queueDraft({ kind: 'csv', fileName: file.name, csvRows: rows, map, accountId: D.accounts.find((a) => ['savings', 'current'].includes(a.type))?.id || '_new', newName: '', newType: 'savings', rows: [] });
}

function txHash(accountId, t, n) { return [accountId, t.date, t.amount, squash(t.raw || t.description), t.ref || '', n].join('|'); }

function buildRows() {
  const imp = ui.imp;
  if (['holdings', 'mfsummary', 'cas'].includes(imp.kind)) { imp.rows = []; return; }
  let src;
  if (imp.kind === 'card' || imp.kind === 'bankpdf') src = imp.parsed.transactions;
  else { const r = P.csvToTransactions(imp.csvRows, imp.map); src = r.transactions; imp.warnings = r.warnings; }
  const acc = imp.accountId;
  const existing = new Set(D.transactions.filter((x) => x.accountId === acc).map((x) => x.hash));
  const smsPool = D.transactions.filter((x) => x.accountId === acc && (x.source === 'sms' || x.source === 'transfer' || x.source === 'emi' || x.source === 'log'));
  const claimed = new Set();
  const seen = new Map();
  imp.rows = src.map((t) => {
    const k = [t.date, t.amount, squash(t.raw || t.description), t.ref || ''].join('|');
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    const hash = txHash(acc, t, n);
    const payee = t.self ? 'Self transfer' : payeeFrom(t.counterparty || t.description);
    const c = categorize({ ...t, payee, accountId: acc }, D.rules);
    if (!c.categoryId && t.self) c.categoryId = 'self_transfer';
    if (!c.categoryId && t.loanAccount) c.categoryId = 'loan_repayment';
    const dup = existing.has(hash);
    let smsMatch = null;
    if (!dup) {
      const hit = smsPool.find((x) => !claimed.has(x.id) && x.amount === t.amount && daysApart(x.date, t.date) <= 3);
      if (hit) { claimed.add(hit.id); smsMatch = hit.id; }
    }
    return { ...t, hash, payee: c.payee || payee, categoryId: c.categoryId, include: !dup, dup, smsMatch };
  });
}

function renderImportPreview(m) {
  const imp = ui.imp;
  setTop('Review rows', { back: 'batchBack' });
  const isCard = imp.kind === 'card', isStmt = imp.kind === 'card' || imp.kind === 'bankpdf';
  const accFilter = isCard ? (a) => a.type === 'credit_card' : (a) => typeOf(a.type).mode === 'ledger' && a.type !== 'credit_card';
  const st = imp.parsed?.statement;
  const rec = imp.parsed?.recon;
  const inc = imp.rows.filter((r) => r.include);
  const dups = imp.rows.filter((r) => r.dup).length;
  let h = `<div class="card"><h2>${esc(imp.fileName)}</h2>`;
  if (imp.kind === 'bankpdf') {
    h += bankSummary(imp);
  } else if (isCard) {
    h += `<div class="split"><div><div class="small muted">Total due</div><div class="mid num">${inr(st.totalDue, 0)}</div></div><div><div class="small muted">Due date</div><div class="mid">${fmtDate(st.dueDate, true)}</div></div></div>
      <p class="small muted" style="margin:8px 0">${fmtDate(st.periodFrom)} to ${fmtDate(st.periodTo, true)} · card ••${esc(st.cardLast4 || '????')}</p>
      ${rec?.ok ? `<span class="badge">All ${imp.rows.length} rows match the statement totals</span>` : rec?.ok === false ? `<span class="badge warn">Rows differ from statement totals by ${inr(rec.debitDiff)} / ${inr(rec.creditDiff)}</span>` : ''}`;
  } else {
    const hdr = imp.csvRows[imp.map.headerRow] || [];
    const sel = (key, label, optional) => `<label class="f"><span>${label}</span><select class="i" data-map="${key}">${optional ? '<option value="-1">(none)</option>' : ''}${hdr.map((c, i) => `<option value="${i}" ${imp.map[key] === i ? 'selected' : ''}>${esc(c || 'Column ' + (i + 1))}</option>`).join('')}</select></label>`;
    h += `<p class="small muted">Match the columns. Use either Withdrawal + Deposit, or Amount (+ Dr/Cr if there is one).</p>
      <label class="f"><span>Header row</span><select class="i" data-map="headerRow">${imp.csvRows.slice(0, 30).map((r, i) => `<option value="${i}" ${imp.map.headerRow === i ? 'selected' : ''}>${i + 1}: ${esc(r.slice(0, 4).join(' | ').slice(0, 60))}</option>`).join('')}</select></label>
      ${sel('date', 'Date')}${sel('description', 'Description / narration')}
      <div class="split">${sel('debit', 'Withdrawal (money out)', true)}${sel('credit', 'Deposit (money in)', true)}</div>
      <div class="split">${sel('amount', 'Amount', true)}${sel('drcr', 'Dr / Cr', true)}</div><div class="split">${sel('ref', 'Reference', true)}${sel('balance', 'Closing balance', true)}</div>`;
  }
  h += `</div><div class="card"><h2>Add to account</h2><select class="i" id="impAcc">${accOptions(imp.accountId, accFilter)}<option value="_new" ${imp.accountId === '_new' ? 'selected' : ''}>+ New account…</option></select>
    ${imp.accountId === '_new' ? `<div style="height:10px"></div><input class="i" id="impNewName" placeholder="Account name, e.g. HDFC Savings" value="${esc(imp.newName)}">
      ${!isStmt ? `<div style="height:10px"></div><select class="i" id="impNewType">${ACCOUNT_TYPES.filter((t) => t.mode === 'ledger' && t.id !== 'credit_card').map((t) => `<option value="${t.id}" ${imp.newType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>` : ''}` : ''}
  </div>
  <div class="row" style="margin:0 4px 8px"><div class="grow small muted">${inc.length} of ${imp.rows.length} selected${dups ? ` · ${dups} already imported` : ''}${imp.rows.some((r) => r.smsMatch) ? ` · ${imp.rows.filter((r) => r.smsMatch).length} match earlier entries` : ''}</div><button class="link" data-act="impAll">${inc.length === imp.rows.length ? 'Select none' : 'Select all'}</button></div>
  <div class="list">${imp.rows.map((r, i) => `<label class="item ${r.include ? '' : 'dup'}"><input type="checkbox" class="chk" data-imp="${i}" ${r.include ? 'checked' : ''}>
    <div class="grow"><div class="t">${esc(r.payee || r.description)}</div><div class="s">${fmtDate(r.date)} · ${r.categoryId ? esc(catName(r.categoryId)) : '<span class="warn">Uncategorised</span>'}${r.dup ? ' · already imported' : ''}${r.smsMatch ? ' · replaces your earlier entry' : ''}</div></div>
    <div class="a num ${r.amount > 0 ? 'in' : ''}">${r.amount > 0 ? '+' : ''}${inr(r.amount)}</div></label>`).join('')}</div>
  ${imp.warnings?.length ? `<p class="small warn">${imp.warnings.slice(0, 5).map(esc).join('<br>')}</p>` : ''}
  <button class="btn wide" data-act="batchBack">Done</button>`;
  m.innerHTML = h;
  $('#impAcc').addEventListener('change', (e) => { imp.accountId = e.target.value; buildRowsFor(imp); render(); });
  $('#impNewName')?.addEventListener('input', (e) => { imp.newName = e.target.value; });
  $('#impNewType')?.addEventListener('change', (e) => { imp.newType = e.target.value; });
  m.querySelectorAll('[data-imp]').forEach((el) => el.addEventListener('change', () => { imp.rows[+el.dataset.imp].include = el.checked; render(); }));
  m.querySelectorAll('[data-map]').forEach((el) => el.addEventListener('change', () => { imp.map[el.dataset.map] = +el.value; buildRowsFor(imp); render(); }));
}

// If the CSV has a running balance column, work out the balance before the first row
function csvOpening(imp) {
  const rows = imp.rows;
  if (rows.length) {
    // Statements list oldest-first or newest-first: use the oldest row
    const oldest = rows[0].date <= rows[rows.length - 1].date ? rows[0] : rows[rows.length - 1];
    if (oldest.balance != null) return { amount: oldest.balance - oldest.amount, date: oldest.date, source: 'import' };
  }
  return { amount: 0, date: rows[0]?.date || todayIso(), source: 'manual' };
}

function buildRowsFor(imp) { const prev = ui.imp; ui.imp = imp; buildRows(); ui.imp = prev; }
function draftKey(imp) { return (imp.owner || '') + '|' + draftKey0(imp); }
function draftKey0(imp) { if (imp.kind === 'holdings') return 'hold:' + (imp.parsed.statement.clientId || ''); if (imp.kind === 'mfsummary' || imp.kind === 'cas') return 'mf:' + (imp.parsed.statement.pan || ''); return imp.kind === 'card' ? 'card:' + imp.parsed.statement.cardLast4 : imp.kind === 'bankpdf' ? 'bank:' + imp.parsed.statement.bank + ':' + imp.parsed.statement.last4 : 'csv:' + imp.fileName; }
// Imports one draft. Returns { acc, added, upgraded } (throws on a problem the user must fix).
function commitDraft(imp, createdInBatch = {}) {
  if (['holdings', 'mfsummary', 'cas'].includes(imp.kind)) return commitHoldings(imp, createdInBatch);
  let acc = accById(imp.accountId);
  if (!acc && createdInBatch[draftKey(imp)]) acc = createdInBatch[draftKey(imp)];
  if (!acc) {
    const name = (imp.newName || '').trim();
    if (!name) throw new Error(`Give the new account for ${imp.fileName} a name.`);
    const now = new Date().toISOString();
    if (imp.kind === 'card') acc = { id: uid(), name, type: 'credit_card', institution: imp.parsed.institution, last4: imp.parsed.statement.cardLast4 || '', currency: 'INR', createdAt: now };
    else if (imp.kind === 'bankpdf') { const st = imp.parsed.statement; acc = { id: uid(), name, type: imp.newType || 'savings', institution: st.bank || '', last4: st.last4 || '', currency: 'INR', createdAt: now, opening: { amount: st.openingBalance || 0, date: st.periodFrom || imp.rows[0]?.date || todayIso(), source: 'statement' } }; }
    else acc = { id: uid(), name, type: imp.newType || 'savings', institution: '', last4: '', currency: 'INR', createdAt: now, opening: csvOpening(imp) };
    acc.owner = imp.owner || guessOwner(imp);
    D.accounts.push(acc);
    createdInBatch[draftKey(imp)] = acc;
  }
  if (imp.accountId !== acc.id) {
    // hashes were built against another id; rebuild against the real one, keeping the user's ticks
    imp.accountId = acc.id; const keep = imp.rows.map((r) => r.include); buildRowsFor(imp); imp.rows.forEach((r, i) => { r.include = keep[i] && !r.dup; });
  }
  const importId = uid();
  const rows = imp.rows.filter((r) => r.include);
  let upgraded = 0;
  for (const r of rows) {
    const sx = r.smsMatch && D.transactions.find((x) => x.id === r.smsMatch);
    if (sx) {
      // The statement is the authoritative record: upgrade the SMS entry, keep what the user set
      Object.assign(sx, { date: r.date, time: r.time || sx.time || null, description: r.description, raw: r.raw || r.description, ref: r.ref || sx.ref, importId, hash: r.hash, source: 'statement', smsRaw: sx.source === 'sms' ? sx.raw : sx.smsRaw, points: r.points ?? null });
      if (!sx.payeeManual && !sx.transferId) sx.payee = r.payee;
      if (!sx.catManual && r.categoryId) sx.categoryId = r.categoryId;
      upgraded++; continue;
    }
    D.transactions.push({ id: uid(), accountId: acc.id, date: r.date, time: r.time || null, amount: r.amount, description: r.description, raw: r.raw || r.description, payee: r.payee, categoryId: r.categoryId, notes: '', ref: r.ref || null, importId, hash: r.hash, points: r.points ?? null });
  }
  const rec = { id: importId, accountId: acc.id, fileName: imp.fileName, kind: imp.kind, at: new Date().toISOString(), count: rows.length };
  if (imp.kind === 'bankpdf') {
    const st = imp.parsed.statement;
    rec.period = { from: st.periodFrom, to: st.periodTo }; rec.statement = st;
    const otherTx = D.transactions.some((x) => x.accountId === acc.id && x.importId !== importId && x.source !== 'sms');
    if (acc.opening?.source !== 'manual' || (!otherTx && !acc.opening.amount)) {
      if (!acc.opening || !otherTx || st.periodFrom < acc.opening.date) acc.opening = { amount: st.openingBalance || 0, date: st.periodFrom, source: 'statement' };
    }
    if (!acc.statement || st.periodTo >= acc.statement.periodTo) {
      acc.statement = { ...st };
      const bal = (acc.opening?.amount || 0) + D.transactions.filter((x) => x.accountId === acc.id && x.date <= st.periodTo).reduce((s2, x) => s2 + x.amount, 0);
      acc.statementBalanceCheck = { ok: Math.abs(bal - st.closingBalance) < 100, diff: bal - st.closingBalance, strays: D.transactions.filter((x) => x.accountId === acc.id && x.source === 'sms' && x.date >= st.periodFrom && x.date <= st.periodTo).length };
    }
    for (const l of imp.loans || []) {
      if (!l.create || D.accounts.some((a) => a.last4 === l.no.slice(-4) && typeOf(a.type).side === 'liability')) continue;
      const la = { id: uid(), name: l.name || 'Home Loan', type: l.type || 'home_loan', institution: st.bank || '', last4: l.no.slice(-4), currency: 'INR', createdAt: new Date().toISOString(), loanAccountNo: l.no };
      D.accounts.push(la);
      const v = parseRupees(l.outstanding || '');
      if (v != null) D.valuations.push({ id: uid(), accountId: la.id, date: todayIso(), value: Math.abs(v), note: 'Entered at import', at: Date.now() });
    }
  }
  if (imp.kind === 'card') {
    const st = imp.parsed.statement;
    rec.period = { from: st.periodFrom, to: st.periodTo };
    rec.statement = st;
    // Opening balance = what was owed before the earliest statement we have
    const otherTx = D.transactions.some((x) => x.accountId === acc.id && x.importId !== importId && x.source !== 'sms');
    const manualPlaceholder = acc.opening?.source === 'manual' && !otherTx && !acc.opening.amount;
    if (!acc.opening || manualPlaceholder || (acc.opening.source !== 'manual' && (!otherTx || st.periodFrom < acc.opening.date))) {
      acc.opening = { amount: -(st.previousDues || 0), date: st.periodFrom, source: 'statement' };
    }
    if (!acc.statement || st.statementDate >= acc.statement.statementDate) {
      acc.statement = { ...st, paid: false };
      // Check: our running balance up to the statement date vs what the bank says is due
      const bal = (acc.opening?.amount || 0) + D.transactions.filter((x) => x.accountId === acc.id && x.date <= st.periodTo).reduce((s, x) => s + x.amount, 0);
      const diff = -bal - st.totalDue;
      const strays = D.transactions.filter((x) => x.accountId === acc.id && x.source === 'sms' && x.date >= st.periodFrom && x.date <= st.periodTo).length;
      acc.statementBalanceCheck = { ok: Math.abs(diff) < 100, diff, strays };
    }
  }
  rec.count = rows.length - upgraded; rec.upgraded = upgraded;
  D.imports.push(rec);
  return { acc, added: rows.length - upgraded, upgraded };
}
function commitHoldings(imp, created) {
  const st = imp.parsed.statement;
  const isMf = imp.kind === 'mfsummary' || imp.kind === 'cas';
  let acc = accById(imp.accountId) || created[draftKey(imp)];
  if (!acc) {
    acc = isMf
      ? { id: uid(), name: (imp.newName || 'Mutual funds').trim(), type: 'mutual_fund', institution: st.distributor || st.registrar || '', last4: '', mfKey: `${st.pan || ''}|${st.distributor || st.registrar || ''}`, mfPan: st.pan || '', currency: 'INR', createdAt: new Date().toISOString() }
      : { id: uid(), name: (imp.newName || 'Zerodha').trim(), type: 'stocks', institution: 'Zerodha', last4: '', brokerId: st.clientId || '', currency: 'INR', createdAt: new Date().toISOString() };
    acc.owner = imp.owner || guessOwner(imp);
    D.accounts.push(acc); created[draftKey(imp)] = acc;
  }
  if (st.clientId && !acc.brokerId) acc.brokerId = st.clientId;
  const importId = uid();
  if (!acc.holdingsAsOn || (st.asOn || '') >= acc.holdingsAsOn) {
    const mapH = imp.kind === 'cas' ? (h) => ({ id: uid(), accountId: acc.id, importId, ...h, qty: h.units, price: h.nav * 100, avg: h.units ? h.cost / h.units : 0, priceDate: h.navDate, schemeCode: D.holdings.find((o) => o.schemeCode && ((h.isin && o.isin === h.isin) || o.name === h.name))?.schemeCode })
      : isMf ? (h) => ({ id: uid(), accountId: acc.id, importId, ...h, qty: null, price: null, priceDate: st.asOn })
      : (h) => ({ id: uid(), accountId: acc.id, importId, ...h, avg: h.avg * 100, price: h.price * 100, priceDate: st.asOn });
    D.holdings = D.holdings.filter((h) => h.accountId !== acc.id).concat(imp.parsed.holdings.map(mapH));
    acc.holdingsAsOn = st.asOn || todayIso();
    if (imp.kind === 'mfsummary') acc.sips = imp.parsed.sips || [];
    if (st.pan) acc.mfPan = st.pan;
  }
  D.valuations.push({ id: uid(), accountId: acc.id, date: st.asOn || todayIso(), value: st.value, note: 'Holdings file', at: Date.now() });
  D.imports.push({ id: importId, accountId: acc.id, fileName: imp.fileName, kind: imp.kind, at: new Date().toISOString(), count: imp.parsed.holdings.length, period: st.asOn ? { from: st.asOn, to: st.asOn } : null });
  return { acc, added: 0, upgraded: 0 };
}
function commitBatch() {
  const created = {}; let added = 0, upgraded = 0; const accs = new Set();
  // oldest statements first, so opening balances come from the earliest one
  const list = [...ui.batch].sort((a, b) => (a.parsed?.statement?.periodFrom || '').localeCompare(b.parsed?.statement?.periodFrom || ''));
  try {
    for (const imp of list) { const r = commitDraft(imp, created); added += r.added; upgraded += r.upgraded; accs.add(r.acc.id); }
  } catch (e) { save(); toast(e.message, 4000); return; }
  // Name the main person from the first statement that prints a holder name
  const me = D.members.find((x) => x.id === 'me');
  if (me && me.name === 'Me') { const h = list.filter((x) => (x.owner || 'me') === 'me').map((x) => x.parsed?.statement?.holder).find(Boolean); if (h) me.name = h.split(/\s+/)[0].toLowerCase().replace(/^./, (c) => c.toUpperCase()); }
  const tm = matchTransfers();
  save();
  ui.batch = null; ui.imp = null;
  toast(`${added} transactions added${upgraded ? `, ${upgraded} earlier entries confirmed` : ''}${tm ? `, ${tm} transfers matched` : ''}`, 3500);
  if (accs.size === 1) { ui.tab = 'accounts'; ui.view = { page: 'account', id: [...accs][0] }; } else { ui.tab = 'accounts'; ui.view = null; }
  render();
}
function guessOwner(imp) {
  const st = imp.parsed?.statement || {};
  const name = st.holder || st.applicant || imp.parsed?.holderName || '';
  if (name) return ownerFromName(name);
  return D.settings.who !== 'all' ? D.settings.who : 'me';
}
function bankSummary(imp) {
  const st = imp.parsed.statement, rec = imp.parsed.recon;
  return `<div class="split"><div><div class="small muted">Closing balance</div><div class="mid num">${inr(st.closingBalance, 0)}</div></div><div><div class="small muted">Opening</div><div class="mid num">${inr(st.openingBalance, 0)}</div></div></div>
    <p class="small muted" style="margin:8px 0">${esc(st.bank)} ${st.accountType} ••${esc(st.last4 || '????')} · ${fmtDate(st.periodFrom)} to ${fmtDate(st.periodTo, true)}</p>
    ${rec?.ok ? `<span class="badge">All ${imp.rows.length} rows add up to the closing balance</span>` : rec?.ok === false ? `<span class="badge warn">Rows don't add up to the closing balance. Check before importing.</span>` : ''}`;
}
function renderBatch(m) {
  setTop('Review', { back: 'cancelImport' });
  const created = new Set();
  let h = `<p class="small muted" style="margin:0 4px 10px">${ui.batch.length} statement${ui.batch.length > 1 ? 's' : ''} ready. Check the accounts, then confirm.</p>`;
  ui.batch.forEach((imp, i) => {
    if (multi()) imp.owner ??= guessOwner(imp);
    const acc = accById(imp.accountId);
    const key = draftKey(imp); const willReuse = !acc && created.has(key); if (!acc) created.add(key);
    const inc = imp.rows.filter((r) => r.include).length, dups = imp.rows.filter((r) => r.dup).length, sms = imp.rows.filter((r) => r.smsMatch).length;
    const st = imp.parsed?.statement;
    const title = imp.kind === 'cas' ? (imp.parsed.kind === 'hreport' ? `Mutual funds · ${st.holder || ''}` : `Mutual funds · ${st.registrar} CAS`) : imp.kind === 'mfsummary' ? `Mutual funds${st.distributor ? ' · ' + st.distributor : ''}` : imp.kind === 'holdings' ? `Zerodha holdings${st.clientId ? ' · ' + st.clientId : ''}` : imp.kind === 'card' ? `Credit card ••${st.cardLast4}` : imp.kind === 'bankpdf' ? `${st.bank} ${st.accountType} ••${st.last4}` : imp.fileName;
    const what = ['holdings', 'mfsummary', 'cas'].includes(imp.kind) ? inr(st.value, 0) : imp.kind === 'card' ? `${inr(st.totalDue, 0)} due ${fmtDate(st.dueDate)}` : imp.kind === 'bankpdf' ? `Balance ${inr(st.closingBalance, 0)}` : `${imp.rows.length} rows`;
    const ok = imp.parsed?.recon?.ok;
    h += `<div class="card"><div class="row"><div class="grow"><div class="t" style="font-weight:600">${esc(title)}</div><div class="small muted">${esc(imp.fileName)}${st?.periodFrom ? ` · ${fmtDate(st.periodFrom)} to ${fmtDate(st.periodTo, true)}` : ''}</div></div><div class="num" style="font-weight:600">${what}</div></div>
      <p class="small" style="margin:10px 0 6px">${acc ? `Adds to <b>${esc(accShort(acc))}</b>` : willReuse ? `Adds to the new account above` : `<b>Creates a new account</b>${st?.last4 || st?.cardLast4 ? ' ••' + esc(st.last4 || st.cardLast4) : ''}:`}</p>
      ${(() => { const hn = st?.holder; if (!hn) return ''; const first = hn.trim().split(/\s+/)[0]; const known = D.members.some((mb) => mb.name.toLowerCase().split(/\s+/)[0] === first.toLowerCase()); return known ? '' : `<p class="small warn" style="margin:0 0 8px">This statement is in the name of ${esc(hn)}. <button class="link" data-act="addHolder" data-name="${esc(first)}" data-i="${i}">Add ${esc(first.charAt(0) + first.slice(1).toLowerCase())} to the household</button></p>`; })()}
      ${!acc && !willReuse && multi() ? `<label class="row small" style="margin:0 0 8px"><span style="flex:none">Belongs to</span><select class="i" data-newowner="${i}" style="min-height:38px;padding:6px 10px">${ownerOptions(imp.owner ??= guessOwner(imp))}</select></label>` : ''}
      ${!acc && !willReuse ? `<input class="i" data-newname="${i}" value="${esc(imp.newName)}" placeholder="Account name, e.g. HDFC Savings" style="margin-bottom:8px">${imp.kind === 'csv' ? `<select class="i" data-newtype="${i}" style="margin-bottom:8px">${ACCOUNT_TYPES.filter((t) => t.mode === 'ledger' && t.id !== 'credit_card').map((t) => `<option value="${t.id}" ${imp.newType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>` : ''}` : ''}
      ${imp.kind === 'cas' ? `<p class="small muted" style="margin:0 0 8px">${imp.parsed.holdings.length} funds with units · invested ${inr(st.cost, 0)} · gain <span class="${st.value >= st.cost ? 'in' : 'bad'}">${inrS(st.value - st.cost, 0)}</span> ${imp.parsed.recon?.ok ? '· <span class="in">matches the statement total</span>' : ''}</p><p class="tiny muted" style="margin:0 0 8px">${acc ? 'Replaces the funds in ' + esc(acc.name) + '. ' : ''}Values will update daily from official NAVs.</p>` : imp.kind === 'mfsummary' ? `<p class="small muted" style="margin:0 0 8px">${imp.parsed.holdings.length} funds · invested ${inr(st.cost, 0)} · gain <span class="${st.value >= st.cost ? 'in' : 'bad'}">${inrS(st.value - st.cost, 0)}</span>${st.xirr != null ? ` · XIRR ${st.xirr}%` : ''} ${imp.parsed.recon?.ok ? '· <span class="in">matches the statement total</span>' : ''}</p>` : imp.kind === 'holdings' ? `<p class="small muted" style="margin:0 0 8px">${imp.parsed.holdings.length} holdings · invested ${inr(st.invested, 0)} · P&amp;L <span class="${st.value >= st.invested ? 'in' : 'bad'}">${inrS(st.value - st.invested, 0)}</span> ${imp.parsed.recon?.ok ? '· <span class="in">matches Zerodha\'s total</span>' : ''}</p><p class="tiny muted" style="margin:0 0 8px">${imp.parsed.holdings.slice(0, 6).map((h) => esc(h.symbol)).join(', ')}${imp.parsed.holdings.length > 6 ? '…' : ''}</p>` : `
      <p class="small muted" style="margin:0 0 8px">${inc} new transactions${dups ? ` · ${dups} already imported` : ''}${sms ? ` · ${sms} confirm earlier entries` : ''} ${ok ? '· <span class="in">totals check out</span>' : ok === false ? '· <span class="warn">totals off</span>' : ''}</p>
      ${(imp.loans || []).map((l, j) => `<label class="row small" style="margin:6px 0"><input type="checkbox" class="chk" data-loan="${i}:${j}" ${l.create ? 'checked' : ''}><span>Payments go to loan account ••${esc(l.no.slice(-4))}. Add it as a home loan?</span></label>
        ${l.create ? `<input class="i num" data-loan-amt="${i}:${j}" inputmode="decimal" placeholder="Outstanding today (₹), optional" value="${esc(l.outstanding)}" style="margin-bottom:6px">` : ''}`).join('')}
      `}<div class="row">${['holdings', 'mfsummary', 'cas'].includes(imp.kind) ? '' : `<button class="chip" data-act="batchOpen" data-i="${i}">Review rows / change account</button>`}<button class="chip" data-act="batchDrop" data-i="${i}">Remove</button></div></div>`;
  });
  h += `<button class="btn wide" data-act="commitBatch">Confirm and import</button><div style="height:10px"></div><button class="btn wide ghost" data-act="pickFile" data-kind="any">Add more files</button><div style="height:10px"></div><button class="btn wide ghost" data-act="cancelImport">Cancel</button>`;
  m.innerHTML = h;
  m.querySelectorAll('[data-newowner]').forEach((el) => el.addEventListener('change', () => { ui.batch[+el.dataset.newowner].owner = el.value; }));
  m.querySelectorAll('[data-newname]').forEach((el) => el.addEventListener('input', () => { ui.batch[+el.dataset.newname].newName = el.value; }));
  m.querySelectorAll('[data-newtype]').forEach((el) => el.addEventListener('change', () => { ui.batch[+el.dataset.newtype].newType = el.value; }));
  m.querySelectorAll('[data-loan]').forEach((el) => el.addEventListener('change', () => { const [i, j] = el.dataset.loan.split(':').map(Number); ui.batch[i].loans[j].create = el.checked; render(); }));
  m.querySelectorAll('[data-loan-amt]').forEach((el) => el.addEventListener('input', () => { const [i, j] = el.dataset.loanAmt.split(':').map(Number); ui.batch[i].loans[j].outstanding = el.value; }));
}

// ---------- sheets ----------
// A short, distinctive pattern: banks truncate names differently on different rows ("AUTO SERV" vs "AUTO SERVICES")
function suggestPattern(x) {
  const words = (x.payee || '').split(/\s+/).filter(Boolean);
  return (words.length > 2 ? words.slice(0, 2) : words).join(' ');
}

function txSheet(x, accId) {
  const isNew = !x;
  x ||= { id: '', accountId: accId || D.accounts.find((a) => typeOf(a.type).mode === 'ledger')?.id, date: todayIso(), amount: 0, payee: '', description: '', categoryId: '', notes: '' };
  const ledger = (a) => typeOf(a.type).mode === 'ledger';
  if (!D.accounts.some(ledger)) return toast('Add a bank, cash or card account first.');
  openSheet(`<h3>${isNew ? 'Add transaction' : 'Transaction'}</h3>
  <form data-form="tx" data-id="${x.id}">
    <label class="f"><span>Payee</span><input class="i" name="payee" value="${esc(x.payee)}" ${isNew ? 'autofocus' : ''} required></label>
    <div class="split">
      <label class="f"><span>Amount (₹)</span><input class="i num" name="amount" inputmode="decimal" value="${x.amount ? (Math.abs(x.amount) / 100).toFixed(2) : ''}" required></label>
      <label class="f"><span>Direction</span><select class="i" name="dir"><option value="out" ${x.amount <= 0 ? 'selected' : ''}>Money out</option><option value="in" ${x.amount > 0 ? 'selected' : ''}>Money in</option></select></label>
    </div>
    <label class="f"><span>Category</span><select class="i" name="categoryId" id="txCat">${catOptions(x.categoryId)}</select></label>
    <div class="hidden" id="ruleRow" style="margin:-4px 0 12px"><label class="row small"><input type="checkbox" class="chk" name="makeRule" checked><span>Also apply to past and future transactions whose bank text contains:</span></label>
      <input class="i" name="rulePattern" value="${esc(suggestPattern(x))}" style="margin-top:6px"></div>
    <div class="split">
      <label class="f"><span>Date</span><input class="i" type="date" name="date" value="${x.date}" required></label>
      <label class="f"><span>Account</span><select class="i" name="accountId">${accOptions(x.accountId, ledger)}</select></label>
    </div>
    <label class="f"><span>Trip or event</span><input class="i" name="tags" list="tagList" placeholder="Optional, e.g. Goa, Dec 2026 (separate two with ;)" value="${esc(tagsOf(x).join('; '))}">${tagDatalist()}</label>
    <label class="f"><span>Notes</span><textarea class="i" name="notes">${esc(x.notes)}</textarea></label>
    ${isNew ? '' : `${receiptThumbs(receiptsFor(x.id))}<button type="button" class="btn ghost wide" data-act="txAttach" data-id="${x.id}" style="margin:0 0 12px">📎 Attach a receipt or bill</button>`}
    ${x.raw ? `<p class="tiny muted">${x.source === 'sms' ? 'SMS' : 'Bank text'}: ${esc(x.raw)}${x.points ? ` · ${x.points} reward points` : ''}</p>` : ''}
    ${x.smsRaw ? `<p class="tiny muted">Confirmed by statement. Original SMS: ${esc(x.smsRaw)}</p>` : ''}
    ${x.transferId ? (() => { const o = D.transactions.find((t) => t.transferId === x.transferId && t.id !== x.id); return o ? `<p class="tiny muted">Matched with ${inr(o.amount)} on ${esc(accShort(accById(o.accountId)))}, ${fmtDate(o.date, true)}. <button class="link" type="button" data-act="unlinkTransfer" data-id="${x.id}">Unlink</button></p>` : ''; })() : ''}
    <button class="btn wide">Save</button>
  </form>
  ${isNew || x.transferId ? '' : `<div style="height:10px"></div><button class="btn wide ghost" data-act="linkTransferSheet" data-id="${x.id}">This was a transfer ${x.amount < 0 ? 'to' : 'from'} my other account</button>`}
  ${isNew ? '' : `<div style="height:10px"></div><button class="btn wide danger" data-act="deleteTx" data-id="${x.id}">Delete transaction</button>`}`);
  const orig = x.categoryId || '';
  if (!isNew) $('#txCat').addEventListener('change', (e) => $('#ruleRow').classList.toggle('hidden', e.target.value === orig || !e.target.value));
}

function accountSheet(a) {
  const isNew = !a;
  a ||= { id: '', name: '', type: 'savings', institution: '', last4: '', opening: null };
  const t = typeOf(a.type);
  openSheet(`<h3>${isNew ? 'Add account' : 'Edit account'}</h3>
  <form data-form="account" data-id="${a.id}">
    <label class="f"><span>Type</span><select class="i" name="type" id="accType" ${isNew ? '' : 'disabled'}>${typeOptions(a.type)}</select></label>
    <label class="f"><span>Name</span><input class="i" name="name" value="${esc(a.name)}" placeholder="e.g. HDFC Savings, PPF, Zerodha" required></label>
    ${multi() ? `<label class="f"><span>Belongs to</span><select class="i" name="owner">${ownerOptions(a.owner || (isNew && D.settings.who !== 'all' ? D.settings.who : 'me'))}</select></label>` : ''}
    <div class="split">
      <label class="f"><span>Bank / institution</span><input class="i" name="institution" value="${esc(a.institution)}"></label>
      <label class="f"><span>Last 4 digits</span><input class="i" name="last4" inputmode="numeric" maxlength="4" value="${esc(a.last4)}"></label>
    </div>
    <div id="accLedger" class="${t.mode === 'ledger' ? '' : 'hidden'}">
      <div class="split">
        <label class="f"><span id="openLbl">${a.type === 'credit_card' ? 'Amount owed on start date' : 'Balance on start date'} (₹)</span><input class="i num" name="opening" inputmode="decimal" value="${a.opening ? (Math.abs(a.opening.amount) / 100).toFixed(2) : ''}"></label>
        <label class="f"><span>Start date</span><input class="i" type="date" name="openingDate" value="${a.opening?.date || todayIso()}"></label>
      </div>
      ${a.opening?.source === 'statement' ? '<p class="tiny muted" style="margin-top:-6px">Set from your first statement. Changing it makes it manual.</p>' : ''}
    </div>
    <div id="accValue" class="${isNew && t.mode === 'value' ? '' : 'hidden'}">
      <label class="f"><span id="valLbl">${t.side === 'liability' ? 'Outstanding principal today' : 'Current value'} (₹)</span><input class="i num" name="value" inputmode="decimal"></label>
    </div>
    <div id="accLoan" class="${isLoanType(a.type) ? '' : 'hidden'}">
      <h2 class="small muted" style="text-transform:uppercase;letter-spacing:.06em;margin:4px 0 10px">EMI</h2>
      <div class="split">
        <label class="f"><span>EMI amount (₹)</span><input class="i num" name="emi" inputmode="decimal" value="${a.loan?.emi ? (a.loan.emi / 100).toFixed(2) : ''}"></label>
        <label class="f"><span>EMIs left</span><input class="i num" name="remaining" inputmode="numeric" value="${a.loan?.remaining ?? ''}"></label>
      </div>
      <div class="split">
        <label class="f"><span>Interest % a year</span><input class="i num" name="rate" inputmode="decimal" placeholder="0 = no-cost EMI" value="${a.loan?.rate != null ? +(+a.loan.rate).toFixed(2) : ''}"></label>
        <label class="f"><span>Next EMI date</span><input class="i" type="date" name="nextDue" value="${a.loan?.nextDue || ''}"></label>
      </div>
      <label class="f"><span>Paid from</span><select class="i" name="paidFrom"><option value="">Outside Ledger (another account, cash, someone else)</option>${accOptions(a.loan?.paidFrom || '', (o) => typeOf(o.type).mode === 'ledger')}</select></label>
      <p class="tiny muted" style="margin-top:-6px">Fill in what you know: with any two of outstanding, EMI and EMIs left (plus the rate), Ledger works out the rest. Each month it records the EMI, splits off the interest as an expense and lowers what you owe.</p>
    </div>
    <button class="btn wide">Save</button>
  </form>
  ${isNew ? '' : `<div style="height:10px"></div><button class="btn wide ghost" data-act="archiveAccount" data-id="${a.id}">${a.archived ? 'Unarchive' : 'Archive (hide)'}</button>
  <div style="height:10px"></div><button class="btn wide danger" data-act="deleteAccount" data-id="${a.id}">Delete account and its transactions</button>`}`);
  $('#accType').addEventListener('change', (e) => {
    const nt = typeOf(e.target.value);
    $('#accLedger').classList.toggle('hidden', nt.mode !== 'ledger');
    $('#accValue').classList.toggle('hidden', nt.mode !== 'value');
    $('#accLoan').classList.toggle('hidden', !isLoanType(nt.id));
    $('#openLbl').textContent = (nt.id === 'credit_card' ? 'Amount owed on start date' : 'Balance on start date') + ' (₹)';
    $('#valLbl').textContent = (nt.side === 'liability' ? 'Outstanding principal today' : 'Current value') + ' (₹)';
  });
}

function valuationSheet(accId, v) {
  const a = accById(accId);
  v ||= { id: '', date: todayIso(), value: latestValuation(accId)?.value || 0, note: '' };
  openSheet(`<h3>${esc(a.name)}</h3><form data-form="valuation" data-acc="${accId}" data-id="${v.id}">
    <label class="f"><span>${typeOf(a.type).side === 'liability' ? 'Outstanding amount' : 'Value'} (₹)</span><input class="i num" name="value" inputmode="decimal" value="${v.value ? (v.value / 100).toFixed(2) : ''}" required autofocus></label>
    <label class="f"><span>As on</span><input class="i" type="date" name="date" value="${v.date}" required></label>
    <label class="f"><span>Note</span><input class="i" name="note" value="${esc(v.note)}" placeholder="optional"></label>
    <button class="btn wide">Save</button></form>
    ${v.id ? `<div style="height:10px"></div><button class="btn wide danger" data-act="deleteValuation" data-id="${v.id}">Delete this entry</button>` : ''}`);
}

// ---------- More ----------
function renderMore(m) {
  setTop('More');
  const userRules = D.rules;
  m.innerHTML = `
  <div class="day"><span>Household</span></div>
  <div class="list">${D.members.map((mb) => `<button class="item" data-act="memberSheet" data-id="${mb.id}"><div class="ico">${esc(initials(mb.name))}</div><div class="grow">${esc(mb.name)}<div class="s">${D.accounts.filter((a) => ownerOf(a) === mb.id).length} accounts</div></div><div class="muted">›</div></button>`).join('')}
    <button class="item" data-act="memberSheet"><div class="grow" style="color:var(--brand)">+ Add a person</div></button></div>
  <div class="list"><button class="item" data-act="tab" data-tab="import"><div class="ico tone-sage" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/></svg></div><div class="grow">Import statements &amp; SMS<div class="s">Bank, card, Zerodha, CAS and SMS inbox</div></div><div class="muted">›</div></button></div>
  <div class="day"><span>Quick add & Shortcut</span></div>
  <div class="list">
    <button class="item" data-act="payWithSheet"><div class="grow">Where quick entries go<div class="s">UPI: ${esc(accShort(payAccount('upi', false)) || 'not set')} · Card: ${esc(accShort(payAccount('card', false)) || 'not set')}</div></div><div class="muted">›</div></button>
    <button class="item" data-act="shortcutHelp"><div class="grow">Set up "Log to Ledger" for Siri</div><div class="muted">›</div></button>
    <button class="item" data-act="openBudgets"><div class="grow">Budgets<div class="s">${Object.keys(D.budgets || {}).length ? Object.keys(D.budgets).length + ' set' : 'Monthly limits by category'}</div></div><div class="muted">›</div></button>
    <button class="item" data-act="openTags"><div class="grow">Trips & events<div class="s">What each trip or occasion cost</div></div><div class="muted">›</div></button>
    <button class="item" data-act="openInvest"><div class="grow">Investments<div class="s">Returns and where your money sits</div></div><div class="muted">›</div></button>
    <button class="item" data-act="openDupes"><div class="grow">Possible duplicates<div class="s">Check payments counted twice</div></div><div class="muted">›</div></button>
    <button class="item" data-act="summarySheet"><div class="grow">Summary for AI<div class="s">Copy your month into Claude or ChatGPT for a report</div></div><div class="muted">›</div></button>
    <button class="item" data-act="openVault"><div class="grow">Family vault<div class="s">${(D.vault || []).length} policies and documents, encrypted</div></div><div class="muted">›</div></button>
    <button class="item" data-act="openReceipts"><div class="grow">Receipts & bills<div class="s">${D.receipts.length} kept, encrypted</div></div><div class="muted">›</div></button>
    <button class="item" data-act="toggleBackupReceipts"><div class="grow">Include receipts in backups</div><div class="muted">${D.settings.backupReceipts === false ? 'No' : 'Yes'} ›</div></button>
  </div>
  <div class="day"><span>Net worth</span></div>
  <div class="list"><button class="item" data-act="toggleLoans"><div class="grow">Keep loans out of net worth<div class="s">Home, car and personal loans are shown separately</div></div><div class="muted">${D.settings.loansSeparate ? 'On' : 'Off'} ›</div></button></div>
  <div class="day"><span>Security</span></div>
  <div class="list">
    <button class="item" data-act="toggleLock"><div class="grow">App lock<div class="s">${vault.lockOff ? 'Off: Ledger opens without Face ID or passphrase' : 'On: Face ID or passphrase to open'}</div></div><div class="muted">${vault.lockOff ? 'Off' : 'On'} ›</div></button>
    ${vault.lockOff ? '' : `<button class="item" data-act="toggleFaceId"><div class="grow">Face ID unlock</div><div class="muted">${vault.hasPasskey ? 'On' : 'Off'} ›</div></button>
    <label class="item"><div class="grow">Auto-lock after</div><select id="autoLock" class="chip">${[1, 5, 15, 60].map((n) => `<option value="${n}" ${D.settings.autoLockMin === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></label>
    <button class="item" data-act="lockNow"><div class="grow">Lock now</div></button>`}
    <button class="item" data-act="changePass"><div class="grow">Change recovery passphrase</div><div class="muted">›</div></button>
  </div>
  <div class="day"><span>Your data</span></div>
  <div class="list">
    <button class="item" data-act="backup"><div class="grow">Back up (encrypted file)<div class="s">${D.settings.lastBackupAt ? 'Last: ' + fmtDate(D.settings.lastBackupAt.slice(0, 10), true) : 'Never backed up'}</div></div><div class="muted">›</div></button>
    <button class="item" data-act="restorePick"><div class="grow">Restore from backup</div><div class="muted">›</div></button>
    <button class="item" data-act="pwSheet"><div class="grow">Saved statement passwords</div><div class="muted">${(D.settings.pdfPasswords || []).length} ›</div></button>
    <button class="item" data-act="exportCsv"><div class="grow">Export transactions (CSV)</div><div class="muted">›</div></button>
    <div class="item"><div class="grow">Storage<div class="s" id="storageInfo">Checking…</div></div></div>
  </div>
  <div class="day"><span>Prices</span></div>
  <div class="list"><button class="item" data-act="stocksSheet"><div class="grow">Live stock prices<div class="s">${D.settings.priceRelay ? 'On, via your Cloudflare relay' : 'Off'}</div></div><div class="muted">›</div></button></div>
  <div class="day"><span>On-device AI</span></div>
  <div class="list"><button class="item" data-act="aiSetup"><div class="grow">Ask Ledger<div class="s">${D.settings.ai?.model ? esc(AI.modelById(D.settings.ai.model)?.label || '') : 'Off'}</div></div><div class="muted">›</div></button></div>
  <div class="day"><span>Categorising</span></div>
  <div class="list">
    <button class="item" data-act="manageCats"><div class="grow">Categories</div><div class="muted">${D.categories.length} ›</div></button>
    <button class="item" data-act="manageRules"><div class="grow">My rules</div><div class="muted">${userRules.length} ›</div></button>
    <button class="item" data-act="myUpiSheet"><div class="grow">My UPI IDs</div><div class="muted">${(D.settings.myUpi || []).length} ›</div></button>
  </div>
  <div class="day"><span>About</span></div>
  <div class="card small"><p style="margin-top:0"><b>Ledger ${APP_VERSION}</b>. Your data never leaves this phone. It is encrypted with a key unlocked by Face ID or your recovery passphrase. The only network requests are for loading the app itself and, if you turn on Ask Ledger, a one-time download of the AI model from Hugging Face.</p>
  <p class="muted" style="margin-bottom:0">Inspired by the open-source Sure app. Not affiliated with it or with any bank.</p></div>
  <button class="btn wide ghost" data-act="forceUpdate">Get the latest version</button><div style="height:10px"></div>
  <button class="btn wide danger" data-act="eraseAll">Erase everything on this phone</button>`;
  $('#autoLock')?.addEventListener('change', (e) => { D.settings.autoLockMin = +e.target.value; save(); });
  storageInfo();
}
async function storageInfo() {
  const el = $('#storageInfo'); if (!el) return;
  let s = '';
  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    s = `${persisted ? 'Protected from automatic clean-up' : 'Not yet protected: add to Home Screen'}${est ? ` · ${(est.usage / 1024).toFixed(0)} KB used` : ''}`;
  } catch { s = 'Unknown'; }
  el.textContent = s;
}

function catsSheet() {
  const used = new Map(); for (const x of D.transactions) used.set(x.categoryId, (used.get(x.categoryId) || 0) + 1);
  const groups = {}; for (const c of D.categories) (groups[c.group] ||= []).push(c);
  openSheet(`<h3>Categories</h3>
  <form data-form="addCat" class="row" style="margin-bottom:14px"><input class="i" name="name" placeholder="New category" required>
  <select class="i" name="group" style="max-width:40%">${Object.keys(groups).map((g) => `<option>${esc(g)}</option>`).join('')}</select><button class="btn">Add</button></form>
  ${Object.entries(groups).map(([g, cs]) => `<div class="day"><span>${esc(g)}${cs[0].kind !== 'expense' ? ` · ${cs[0].kind}` : ''}</span></div><div class="list">${cs.map((c) => `<button class="item" data-act="editCat" data-id="${c.id}"><div class="grow">${esc(c.name)}</div><div class="muted small">${used.get(c.id) || 0} ›</div></button>`).join('')}</div>`).join('')}`);
}
function rulesSheet() {
  openSheet(`<h3>My rules</h3><p class="small muted">Checked before the built-in Indian merchant rules. If the bank text contains the pattern, the category is applied.</p>
  <form data-form="addRule"><label class="f"><span>Bank text contains</span><input class="i" name="pattern" placeholder="e.g. VIKRAM AUTO" required></label>
  <div class="split"><label class="f"><span>Category</span><select class="i" name="categoryId" required>${catOptions('', { allowNone: false })}</select></label>
  <label class="f"><span>Applies to</span><select class="i" name="sign"><option value="">In and out</option><option value="out">Money out only</option><option value="in">Money in only</option></select></label></div>
  <label class="f"><span>Rename payee to (optional)</span><input class="i" name="payee"></label>
  <button class="btn wide">Add rule and apply to past transactions</button></form>
  ${D.rules.length ? `<div class="day"><span>${D.rules.length} rules</span></div><div class="list">${D.rules.map((r) => `<div class="item"><div class="grow"><div class="t">${esc(r.pattern)}</div><div class="s">→ ${esc(catName(r.categoryId))}${r.payee ? ` · “${esc(r.payee)}”` : ''}${r.sign ? ` · ${r.sign} only` : ''}</div></div><button class="link" data-act="deleteRule" data-id="${r.id}">Delete</button></div>`).join('')}</div>` : ''}`);
}

function applyRule(rule) {
  let n = 0;
  for (const x of D.transactions) {
    const c = categorize(x, [rule], []);
    if (c.ruleId === rule.id) { if (x.categoryId !== rule.categoryId || (rule.payee && x.payee !== rule.payee)) n++; x.categoryId = rule.categoryId; if (rule.payee) x.payee = rule.payee; }
  }
  return n;
}

// iOS only allows the share sheet straight from a tap, so the encrypted file is prepared first
// and a second tap shares it.
let pendingBackup = null;
async function doBackup() {
  openSheet(`<h3>Back up</h3><p class="small muted">Preparing your encrypted backup…</p>`);
  try {
    const b = await vault.exportBackup({ files: D.settings.backupReceipts === false ? [] : D.receipts.map((r) => r.id) });
    const name = `ledger-backup-${todayIso()}.json`;
    pendingBackup = new File([JSON.stringify(b)], name, { type: 'application/json' });
    const url = URL.createObjectURL(pendingBackup);
    openSheet(`<h3>Backup ready</h3>
      <p class="small">${pendingBackup.size > 1048576 ? (pendingBackup.size / 1048576).toFixed(1) + ' MB' : (pendingBackup.size / 1024).toFixed(0) + ' KB'}, encrypted${D.receipts.length ? (D.settings.backupReceipts === false ? ', without receipts' : `, including ${D.receipts.length} receipt${D.receipts.length > 1 ? 's' : ''}`) : ''}. Save it to <b>Files → iCloud Drive</b> so it survives if the phone or app is lost. Restoring needs your recovery passphrase.</p>
      ${navigator.canShare?.({ files: [pendingBackup] }) ? '<button class="btn wide" data-act="shareBackup">Save to Files…</button><div style="height:10px"></div>' : ''}
      <a class="btn wide ghost" href="${url}" download="${name}" data-act="backupDownloaded">Download instead</a>`);
  } catch (e) { console.error(e); openSheet(`<h3>Backup failed</h3><p class="small">${esc(e.message || String(e))}</p><button class="btn wide ghost" data-act="closeSheet">Close</button>`); }
}
function markBackedUp() { D.settings.lastBackupAt = new Date().toISOString(); save(); }
function exportCsv() {
  const rows = [['Date', 'Account', 'Payee', 'Category', 'Amount', 'Notes', 'Bank text']];
  for (const x of [...D.transactions].sort((a, b) => a.date.localeCompare(b.date))) rows.push([x.date, accShort(accById(x.accountId)), x.payee, catName(x.categoryId), (x.amount / 100).toFixed(2), x.notes || '', x.raw || x.description]);
  const csv = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
  const file = new File([csv], `ledger-transactions-${todayIso()}.csv`, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
  else { const u = URL.createObjectURL(file); const a = document.createElement('a'); a.href = u; a.download = file.name; a.click(); }
}

// ---------- SMS inbox ----------
const smsHash = (text) => 'sms|' + squash(text).slice(0, 400);
function smsAccount(last4, isCard) {
  if (!last4) return null;
  const c = D.accounts.filter((a) => !a.archived && (a.last4 === last4 || (a.smsLast4 || []).includes(last4)));
  return c.find((a) => (a.type === 'credit_card') === !!isCard) || c[0] || null;
}
function smsToTx(acc, p, hash) {
  const raw = smsPayee(p);
  const payee = payeeFrom(raw.replace(/^(NEFT|IMPS|RTGS)\s*(Cr|Dr)?-?/i, '')) || raw;
  const t = { accountId: acc.id, date: p.date, amount: p.amount, description: p.merchant || p.channel || 'SMS', payee };
  if (isMyUpi(p.merchant)) return { id: uid(), ...t, payee: 'Self transfer', time: null, raw: p.text, categoryId: 'self_transfer', notes: '', ref: p.ref, importId: null, hash, source: 'sms', upi: p.merchant };
  let c = categorize(t, D.rules);
  // Money in with no match on the payee: look at the whole SMS (e.g. "...NEFT Cr-AIR INDIA EXPRESS-SALARY")
  if (!c.categoryId && p.amount > 0) { const c2 = categorize({ ...t, description: p.text }, D.rules); if (c2.categoryId) c = { ...c2, payee: c2.payee || c.payee }; }
  return { id: uid(), ...t, time: null, raw: p.text, payee: c.payee || payee, categoryId: c.categoryId, notes: '', ref: p.ref, importId: null, hash, source: 'sms', upi: /@/.test(p.merchant) ? p.merchant : undefined };
}
const isMyUpi = (h) => !!h && (D.settings.myUpi || []).includes(String(h).toLowerCase());
// UPI IDs that look like the user's own (start with their first name from a bank statement), not yet confirmed
function possibleOwnUpi() {
  const holder = D.accounts.map((a) => a.statement?.holder).find(Boolean);
  const first = holder ? holder.split(/\s+/)[0].toLowerCase() : null;
  if (!first || first.length < 3) return [];
  const asked = new Set([...(D.settings.myUpi || []), ...(D.settings.notMyUpi || [])]);
  return [...new Set(D.transactions.filter((x) => x.upi && x.upi.toLowerCase().startsWith(first)).map((x) => x.upi.toLowerCase()))].filter((h) => !asked.has(h));
}
function markUpi(h, mine) {
  h = h.toLowerCase();
  if (mine) {
    D.settings.myUpi = [...new Set([...(D.settings.myUpi || []), h])];
    D.transactions.forEach((x) => { if (x.upi?.toLowerCase() === h && !x.catManual) { x.categoryId = 'self_transfer'; x.payee = 'Self transfer'; } });
  } else D.settings.notMyUpi = [...new Set([...(D.settings.notMyUpi || []), h])];
  matchTransfers(); save(); render();
}
// Adds one parsed SMS. Returns 'added' | 'known' (already covered by a statement row)
function addSms(acc, p, hash) {
  // Read late, after the statement already has it? Then just remember we saw it.
  const dupe = D.transactions.find((x) => x.accountId === acc.id && x.source !== 'sms' && x.amount === p.amount && daysApart(x.date, p.date) <= 3 && !x.smsRaw);
  if (dupe) { dupe.smsRaw = p.text; if (dupe.source === 'transfer') { dupe.source = 'sms'; dupe.raw = p.text; dupe.ref = p.ref; } return 'known'; }
  D.transactions.push(smsToTx(acc, p, hash));
  return 'added';
}
// Which account a quick entry or Shortcut log goes to: UPI, card or cash (More → Quick add)
function payAccount(via, create = true) {
  const pw = (D.settings.payWith ||= {});
  let a = pw[via] && accById(pw[via]);
  if (a && !a.archived) return a;
  const live = D.accounts.filter((x) => !x.archived && typeOf(x.type).mode === 'ledger' && ownerOf(x) === 'me');
  if (via === 'card') a = live.find((x) => x.type === 'credit_card');
  else if (via === 'cash') a = live.find((x) => x.type === 'cash');
  else a = live.find((x) => /hdfc/i.test(`${x.name} ${x.institution || ''}`) && x.type !== 'credit_card') || live.find((x) => x.type === 'savings');
  if (!a && via === 'cash' && create) { a = { id: uid(), name: 'Cash wallet', type: 'cash', owner: 'me', opening: { amount: 0 } }; D.accounts.push(a); }
  if (a) pw[via] = a.id;
  return a || null;
}
function guessCategory(payee, amount) {
  const prev = [...D.transactions].reverse().find((x) => x.categoryId && (x.payee || '').toLowerCase() === payee.toLowerCase());
  if (prev) return prev.categoryId;
  return categorize({ description: payee, payee, amount }, D.rules).categoryId || null;
}
// One "Log to Ledger" entry. If the bank SMS for it is already in, keep that and add your words to it.
function addLog(lg, receivedAt, hash) {
  // "Card 5678" or "UPI 1234": the account with those last 4 digits wins
  const byDigits = lg.last4 && D.accounts.find((a) => !a.archived && (a.last4 === lg.last4 || (a.smsLast4 || []).includes(lg.last4)));
  const acc = byDigits || payAccount(lg.via); if (!acc) return 'skipped';
  const date = receivedAt ? isoOf(new Date(receivedAt)) : todayIso();
  const amount = lg.income ? lg.amount : -lg.amount;
  const twin = D.transactions.find((x) => x.accountId === acc.id && x.amount === amount && daysApart(x.date, date) <= 2 && x.source !== 'log' && !x.logged);
  if (twin) { twin.logged = lg.what; if (!twin.payeeManual) { twin.notes = [twin.notes, lg.what].filter(Boolean).join(' · '); } if (!twin.catManual && !twin.categoryId) twin.categoryId = guessCategory(lg.what, amount); return 'known'; }
  D.transactions.push({ id: uid(), accountId: acc.id, date, amount, payee: lg.what, description: lg.what, categoryId: guessCategory(lg.what, amount), notes: '', raw: '', hash, source: 'log', importId: null, ref: null, time: receivedAt ? new Date(receivedAt).toTimeString().slice(0, 5) : null });
  return 'added';
}
async function handleInbox(text, source) {
  const items = splitInbox(text);
  if (!items.length) {
    const blank = (String(text).match(/===SMS===/g) || []).length;
    openSheet(`<h3>No messages yet</h3>${blank ? `<p>The file has ${blank} entr${blank > 1 ? 'ies' : 'y'} with a date but no message text. That's what a test run with ▶ writes, so it's expected until a real bank SMS arrives.</p><p class="small muted">If a real HDFC or DNS SMS has arrived since and it still says this, the Shortcut isn't passing the message: in the Text block, tap Shortcut Input and choose the message content.</p>` : '<p>The file is empty.</p>'}<button class="btn wide" data-act="closeSheet">OK</button>`);
    return;
  }
  const res = { added: 0, known: 0, skipped: 0, attention: 0, old: 0, reasons: {} };
  ui.inboxReadAt = Date.now();
  // Messages a newer parser can now read: retry anything waiting under "need attention" as unreadable
  for (const x of [...D.inbox]) {
    if (x.status !== 'unparsed') continue;
    const p = parseSms(x.text, x.receivedAt); if (!p.ok) continue;
    const acc = smsAccount(p.last4, p.isCard);
    if (acc) { res[addSms(acc, p, x.h)]++; D.inbox = D.inbox.filter((y) => y.id !== x.id); } else Object.assign(x, { status: 'noaccount', parsed: p });
  }
  // Already handled = became a transaction, matched a statement row, or waits in the inbox
  const done = new Set([...D.transactions.map((x) => x.hash), ...D.transactions.filter((x) => x.smsRaw).map((x) => smsHash(x.smsRaw)), ...D.inbox.map((x) => x.h)]);
  // Skipped by this version of the parser (an older version gets another go)
  const seen = new Set(D.smsSeen.filter((s) => s.pv === SMS_PV).map((s) => s.h));
  for (const it of items) {
    const h = it.kind === 'log' ? 'log|' + (it.receivedAt || '') + '|' + squash(it.text) : smsHash(it.text);
    if (done.has(h) || seen.has(h)) { res.old++; continue; }
    if (it.kind === 'log') {
      seen.add(h); done.add(h); D.smsSeen.push({ h, at: Date.now(), pv: SMS_PV });
      const lg = parseLog(it.text); if (!lg) { res.skipped++; res.reasons['Unreadable log'] = (res.reasons['Unreadable log'] || 0) + 1; continue; }
      res[addLog(lg, it.receivedAt, h)]++; continue;
    }
    seen.add(h); done.add(h); D.smsSeen = D.smsSeen.filter((s) => s.h !== h); D.smsSeen.push({ h, at: Date.now(), pv: SMS_PV });
    const p = parseSms(it.text, it.receivedAt);
    if (!p.ok && /OTP|Declined|Upcoming|Statement|request|Empty|Zero/.test(p.skip)) { res.skipped++; res.reasons[p.skip] = (res.reasons[p.skip] || 0) + 1; continue; }
    if (!p.ok) { D.inbox.push({ id: uid(), text: it.text, receivedAt: it.receivedAt, status: 'unparsed', why: p.skip, h }); res.attention++; continue; }
    const acc = smsAccount(p.last4, p.isCard);
    if (!acc) { D.inbox.push({ id: uid(), text: it.text, receivedAt: it.receivedAt, status: 'noaccount', parsed: p, h }); res.attention++; continue; }
    res[addSms(acc, p, h)]++;
  }
  // Keep a year of fingerprints
  const cutoff = Date.now() - 400 * 864e5; D.smsSeen = D.smsSeen.filter((s) => s.at > cutoff);
  const tm = matchTransfers();
  save(); render();
  const why = Object.entries(res.reasons).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
  openSheet(`<h3>SMS read</h3>
    <p><b>${res.added}</b> new transactions added${res.known ? `, ${res.known} already in Ledger (matched)` : ''}${tm ? `, ${tm} transfers matched` : ''}.</p>
    ${res.attention ? `<p class="warn">${res.attention} need your attention (on the Import tab).</p>` : ''}
    ${res.skipped ? `<p class="small muted">Ignored ${res.skipped}: ${esc(why)}.</p>` : ''}
    ${res.old ? `<p class="small muted">${res.old} were read before and skipped.</p>` : ''}
    ${possibleOwnUpi().map((h) => `<div class="card" style="background:var(--bg)"><p class="small" style="margin-top:0">Is <b>${esc(h)}</b> your own UPI ID? If yes, money sent to it is a transfer between your accounts, not spending.</p><div class="row"><button class="btn" style="flex:1" data-act="upiMine" data-h="${esc(h)}">Yes, it's mine</button><button class="btn ghost" style="flex:1" data-act="upiNot" data-h="${esc(h)}">No</button></div></div>`).join('')}
    <button class="btn wide" data-act="closeSheet">Done</button>`);
}
function inboxItem(it) {
  const p = it.parsed;
  const head = p ? `${inrS(p.amount)} · ${fmtDate(p.date)} · ${p.isCard ? 'card' : 'account'} ••${esc(p.last4 || '????')}` : esc(it.why || 'Could not read');
  return `<div class="item" style="display:block"><div class="t">${head}</div><div class="s" style="white-space:normal">${esc(it.text.slice(0, 160))}</div>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">${it.status === 'noaccount' ? `<select class="chip" data-inbox-acc="${it.id}"><option value="">Assign to account…</option>${accOptions('', (a) => typeOf(a.type).mode === 'ledger')}</select>` : `<button class="chip" data-act="inboxManual" data-id="${it.id}">Enter by hand</button>${D.settings.ai?.model ? `<button class="chip" data-act="inboxAI" data-id="${it.id}">Read with AI</button>` : ''}`}
    <button class="chip" data-act="inboxDismiss" data-id="${it.id}">Dismiss</button></div></div>`;
}
function assignInbox(id, accId) {
  const it = D.inbox.find((x) => x.id === id); const acc = accById(accId); if (!it || !acc) return;
  const l4 = it.parsed.last4;
  if (l4 && acc.last4 !== l4) { acc.smsLast4 = [...new Set([...(acc.smsLast4 || []), l4])]; }
  let n = 0;
  for (const x of [...D.inbox]) {
    if (x.status !== 'noaccount' || (x.id !== id && x.parsed.last4 !== l4)) continue;
    addSms(acc, x.parsed, x.h); D.inbox = D.inbox.filter((y) => y.id !== x.id); n++;
  }
  matchTransfers(); save(); render(); toast(`${n} added to ${acc.name}. Future SMS for ••${l4} go there automatically.`, 3500);
}

function smsSetupSheet() {
  openSheet(`<h3>Auto-capture bank SMS</h3>
  <p class="small">A Shortcuts automation saves each bank SMS to a text file in iCloud Drive, silently. Ledger reads that file when you tap <b>Read SMS inbox file</b>. Nothing is uploaded anywhere.</p>
  <ol class="small" style="padding-left:18px;line-height:1.5">
    <li>Open <b>Shortcuts</b> → <b>Automation</b> tab → <b>+</b> → <b>Message</b>.</li>
    <li>Set <b>Message Contains</b> to <code>HDFC Bank</code>. Choose <b>Run Immediately</b> and turn off <b>Notify When Run</b>. Tap <b>Next</b>, then <b>New Blank Automation</b>.</li>
    <li>Add a <b>Text</b> action. Type <code>===SMS===</code> and a space, insert the <b>Current Date</b> variable (tap it, set Date Format to <b>ISO 8601</b> with time), press return, then insert <b>Shortcut Input</b> (if asked, pick <b>Content</b>).</li>
    <li>Add <b>Append to Text File</b>. Set the text to the <b>Text</b> from step 3, the file to <code>Ledger Inbox.txt</code> in the <b>Shortcuts</b> folder, and turn on <b>Make New Line</b>.</li>
    <li>Tap <b>Done</b>. Next HDFC SMS will create the file.</li>
  </ol>
  <p class="small">In Ledger: Import → <b>Read SMS inbox file</b> → iCloud Drive → Shortcuts → <b>Ledger Inbox.txt</b>. Read it as often as you like; messages already read are skipped, and OTPs, reminders and declined payments are ignored.</p>
  <p class="small"><b>DNS Bank:</b> make a second automation the same way, with <code>DNS Bank</code> in step 2. Both write to the same file. Any other bank: same again with that bank's name.</p>
  <p class="small muted">Unfamiliar formats land under "need attention" and Ask Ledger can read them.</p>
  <button class="btn wide" data-act="closeSheet">Got it</button>`);
}

// ---------- daily mutual fund NAVs ----------
// Only scheme codes / ISINs are sent; units and values never leave the phone.
const MFAPI = 'https://api.mfapi.in';
async function getJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
const dmy = (s) => { const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
async function findSchemeCode(h) {
  const ws = h.name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !/^(fund|funds|plan|growth|regular|direct|option|cumulative|the|of|and|reg|dir|gr)$/i.test(w));
  // Search names differ slightly from CAS names ("&", "FoF"), so widen the search until something comes back
  let list = [];
  for (const k of [4, 3, 2]) { list = await getJSON(`${MFAPI}/mf/search?q=${encodeURIComponent(ws.slice(0, k).join(' '))}`).catch(() => []); if (list?.length) break; }
  const plan = (h.plan || '').toLowerCase();
  const cands = (list || []).sort((a, b) => {
    const sc = (x) => (/growth/i.test(x.schemeName) ? 2 : 0) + (plan && x.schemeName.toLowerCase().includes(plan) ? 2 : 0) - (/idcw|dividend|bonus/i.test(x.schemeName) ? 3 : 0);
    return sc(b) - sc(a);
  }).slice(0, 8);
  for (const c of cands) {
    if (!h.isin && (/idcw|dividend|bonus/i.test(c.schemeName) || (h.plan === 'Regular' && /direct/i.test(c.schemeName)) || (h.plan === 'Direct' && !/direct/i.test(c.schemeName)))) continue;
    const d = await getJSON(`${MFAPI}/mf/${c.schemeCode}/latest`);
    const m = d.meta || {};
    if (h.isin && [m.isin_growth, m.isin_div_reinvestment].includes(h.isin)) return { code: c.schemeCode, latest: d };
    // No ISIN on the statement: accept the growth plan whose NAV is within 3% of the statement's NAV
    const nav = parseFloat(d.data?.[0]?.nav);
    if (!h.isin && nav > 0 && Math.abs(nav * 100 - h.price) / h.price < 0.03) return { code: c.schemeCode, latest: d };
  }
  return null;
}
async function refreshNavs({ force = false } = {}) {
  const mfs = D.holdings.filter((h) => h.type === 'mf' && h.qty != null && (h.isin || h.name));
  if (!mfs.length || !navigator.onLine) return 0;
  const accs = [...new Set(mfs.map((h) => h.accountId))].map(accById).filter(Boolean);
  if (!force && accs.every((a) => a.navCheckedAt && Date.now() - a.navCheckedAt < 6 * 3600e3)) return 0;
  let n = 0;
  for (const h of mfs) {
    try {
      let latest = null;
      if (!h.schemeCode) { const f = await findSchemeCode(h); if (f) { h.schemeCode = f.code; latest = f.latest; } }
      if (h.schemeCode && !latest) latest = await getJSON(`${MFAPI}/mf/${h.schemeCode}/latest`);
      const row = latest?.data?.[0]; const nav = row ? parseFloat(row.nav) : NaN; const date = row ? dmy(row.date) : null;
      if (nav > 0 && date && date >= (h.priceDate || '')) { h.price = nav * 100; h.priceDate = date; n++; }
    } catch (e) { console.warn('NAV refresh failed for', h.name, e); }
  }
  recordPrices();
  accs.forEach((a) => { a.navCheckedAt = Date.now(); const d = D.holdings.filter((h) => h.accountId === a.id).map((h) => h.priceDate).sort().pop(); if (d) a.holdingsAsOn = d; });
  save();
  return n;
}

// ---------- stock & ETF prices ----------
// Primary: your own Cloudflare relay (near-live; only ticker symbols are sent).
// Fallback: a price file built by the Ledger repo for every NSE symbol (so it reveals nothing about you).
const PRICES_URL = 'https://raw.githubusercontent.com/sahilgp6/Ledger/prices/prices.json';
const yahooSym = (s2) => String(s2).toUpperCase().replace(/-(E|F|BE|BZ|SM|ST|EQ)$/, '');
const hasStocks = () => D.holdings.some((h) => (h.type === 'stock' || h.type === 'etf') && h.qty != null);
function applyQuote(h, price, prev, when) {
  h.price = price * 100; h.prevClose = prev ? prev * 100 : null;
  const t = when ? new Date(when) : new Date(); h.priceAt = t.toISOString();
  h.priceDate = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
async function refreshStocks({ force = false } = {}) {
  const hs = D.holdings.filter((h) => (h.type === 'stock' || h.type === 'etf') && h.qty != null);
  if (!hs.length || !navigator.onLine) return 0;
  const relay = (D.settings.priceRelay || '').replace(/\/+$/, '');
  if (!force && D.settings.stocksCheckedAt && Date.now() - D.settings.stocksCheckedAt < (relay ? 60e3 : 10 * 60e3)) return 0;
  let n = 0;
  if (relay) {
    const syms = [...new Set(hs.map((h) => yahooSym(h.symbol)))];
    for (let i = 0; i < syms.length; i += 50) {
      const r = await fetch(`${relay}/quote?symbols=${encodeURIComponent(syms.slice(i, i + 50).join(','))}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('price relay replied ' + r.status);
      const { quotes } = await r.json();
      for (const h of hs) { const q = quotes?.[yahooSym(h.symbol)]; if (q?.price > 0) { applyQuote(h, q.price, q.prevClose, q.time); n++; } }
    }
  } else {
    const data = await getJSON(PRICES_URL + '?t=' + Math.floor(Date.now() / 60000));
    const P2 = data.prices || {};
    for (const h of hs) { const row = P2[yahooSym(h.symbol)] || P2[h.symbol.toUpperCase()]; if (row && row[0] > 0) { applyQuote(h, row[0], row[1], row[2] ? row[2] * 1000 : data.updatedAt); n++; } }
  }
  D.settings.stocksCheckedAt = Date.now();
  recordPrices();
  for (const a of new Set(hs.map((h) => h.accountId))) { const acc = accById(a); if (acc) acc.holdingsAsOn = hs.filter((h) => h.accountId === a).map((h) => h.priceDate).sort().pop(); }
  save();
  return n;
}
const marketOpen = () => { const t = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60e3); const d = t.getDay(), m = t.getHours() * 60 + t.getMinutes(); return d >= 1 && d <= 5 && m >= 555 && m <= 935; };
// While Ledger is open in market hours, live prices refresh every 2 minutes
setInterval(() => {
  if (!D || document.hidden || !D.settings.priceRelay || !marketOpen() || !hasStocks()) return;
  refreshStocks().then((n) => { if (n && !$('#sheet').classList.contains('on') && !ui.batch) render(); }).catch(() => {});
}, 120e3);
let workerCode = '';
function stocksSheet() {
  fetch(new URL('../cloudflare-worker.js', import.meta.url)).then((r) => r.text()).then((t) => { workerCode = t; }).catch(() => {});
  openSheet(`<h3>Live stock prices</h3>
  <p class="small">Ledger gets stock and ETF prices through your own free Cloudflare relay. Only ticker symbols are sent; quantities and values stay on this phone. Prices are about a minute behind and refresh every 2 minutes while Ledger is open in market hours.</p>
  <ol class="small" style="padding-left:18px;line-height:1.55">
    <li>Tap <b>Copy relay code</b> below.</li>
    <li>Open <b>dash.cloudflare.com</b> in Safari and sign up (free).</li>
    <li>Go to <b>Workers &amp; Pages → Create → Create Worker</b>, name it <code>ledger-prices</code>, tap <b>Deploy</b>.</li>
    <li>Tap <b>Edit code</b>, select all, paste, then <b>Deploy</b>.</li>
    <li>Copy the worker's address (ends in <code>.workers.dev</code>) and paste it below.</li>
  </ol>
  <button class="btn wide ghost" data-act="copyWorker">Copy relay code</button><div style="height:12px"></div>
  <form data-form="relay"><label class="f"><span>Relay address</span><input class="i" name="url" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://ledger-prices.yourname.workers.dev" value="${esc(D.settings.priceRelay || '')}"></label>
  <button class="btn wide">Save and test</button></form>
  ${D.settings.priceRelay ? `<div style="height:10px"></div><button class="btn wide danger" data-act="relayOff">Turn off live prices</button>` : ''}`);
}

// ---------- loans & EMIs ----------
const LOAN_TYPES = ['home_loan', 'car_loan', 'personal_loan', 'education_loan', 'emi_loan', 'other_liability'];
const isLoanType = (t) => LOAN_TYPES.includes(t);
const mrate = (annualPct) => (annualPct || 0) / 1200;
// EMI for principal P (paise), monthly rate r, n months
const emiFor = (P, r, n) => r ? Math.round(P * r * (1 + r) ** n / ((1 + r) ** n - 1)) : Math.ceil(P / n);
const principalFor = (E, r, n) => r ? Math.round(E * ((1 + r) ** n - 1) / (r * (1 + r) ** n)) : E * n;
function monthsFor(P, E, r) {
  if (P <= 0) return 0;
  if (!r) return Math.ceil(P / E);
  const x = 1 - (r * P) / E; if (x <= 0) return null; // EMI does not even cover the interest
  return Math.ceil(-Math.log(x) / Math.log(1 + r));
}
function rateFor(P, E, n) { // annual %, by bisection
  if (E * n <= P) return 0;
  let lo = 0, hi = 0.05;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (emiFor(P, mid, n) > E) hi = mid; else lo = mid; }
  return lo * 1200;
}
function nextDateOnDay(day, after) {
  const d = new Date(after + 'T00:00:00'); let y = d.getFullYear(), m = d.getMonth();
  const mk = (yy, mm) => { const last = new Date(yy, mm + 1, 0).getDate(); return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`; };
  let c = mk(y, m); if (c <= after) { m++; if (m > 11) { m = 0; y++; } c = mk(y, m); }
  return c;
}
function setupLoan(a, { outstanding, emi, remaining, rate, nextDue, paidFrom }) {
  const prev = a.loan || {};
  let P = outstanding != null ? Math.abs(outstanding) : (latestValuation(a.id)?.value ?? null);
  if (P === 0 && !a.loan) P = null;
  emi = emi != null ? Math.abs(emi) : prev.emi ?? null;
  remaining = Number.isFinite(remaining) && remaining > 0 ? remaining : null;
  let r = rate;
  let note = '';
  if (P == null && emi && remaining && r != null) { P = principalFor(emi, mrate(r), remaining); note = `Outstanding worked out as ${inr(P, 0)}.`; }
  if (P != null && emi && remaining && r == null) { r = rateFor(P, emi, remaining); note = r ? `Interest worked out as ${r.toFixed(2)}% a year.` : 'Treated as a no-cost EMI (0%).'; }
  if (P != null && !emi && remaining) { emi = emiFor(P, mrate(r || 0), remaining); note = `EMI worked out as ${inr(emi)}.`; }
  if (P != null && emi && !remaining) { remaining = monthsFor(P, emi, mrate(r || 0)); if (remaining == null) return { error: 'That EMI does not cover the interest. Check the amounts.' }; note = `${remaining} EMIs left.`; }
  if (P == null || !emi) {
    if (!emi && !remaining) { a.loan = null; return { note: '' }; } // plain loan without EMI tracking
    return { error: 'Add the outstanding principal, or the EMI, EMIs left and rate.' };
  }
  if (r == null) r = 0;
  const day = nextDue ? +nextDue.slice(8, 10) : prev.day || new Date().getDate();
  a.loan = { emi, rate: r, day, remaining, paidFrom: paidFrom || null, nextDue: nextDue || prev.nextDue || nextDateOnDay(day, todayIso()), paid: prev.paid || 0 };
  const cur = latestValuation(a.id)?.value;
  // If the next EMI date is already past, the outstanding you entered is from before that EMI
  const setDate = a.loan.nextDue < todayIso() ? (() => { const d = new Date(a.loan.nextDue + 'T00:00:00'); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })() : todayIso();
  if (cur !== P) D.valuations.push({ id: uid(), accountId: a.id, date: setDate, value: P, note: 'Loan set up', at: Date.now() });
  return { note };
}
// Records every EMI that has fallen due. Returns how many were recorded.
function processEmis() {
  let n = 0; const today = todayIso();
  for (const a of D.accounts) {
    const L = a.loan; if (!L || a.archived) continue;
    let guard = 0;
    while (L.nextDue && L.nextDue <= today && guard++ < 600) {
      const P = latestValuation(a.id)?.value || 0;
      if (P <= 0) { L.nextDue = null; break; }
      const interest = Math.round(P * mrate(L.rate));
      const pay = Math.min(L.emi, P + interest);
      const principal = pay - interest;
      const newP = Math.max(0, P - principal);
      D.valuations.push({ id: uid(), accountId: a.id, date: L.nextDue, value: newP, note: `EMI paid: ${inr(principal)} principal, ${inr(interest)} interest`, at: Date.now() });
      const from = L.paidFrom && accById(L.paidFrom);
      if (from) D.transactions.push({ id: uid(), accountId: from.id, date: L.nextDue, time: null, amount: -pay, payee: `EMI · ${a.name}`, description: `EMI ${a.name}`, raw: '', notes: interest ? `${inr(principal)} principal + ${inr(interest)} interest` : 'No-cost EMI', ref: null, importId: null, hash: 'emi|' + uid(), source: 'emi', categoryId: 'loan_repayment', catManual: true, interest, loanId: a.id });
      L.paid = (L.paid || 0) + 1; L.remaining = Math.max(0, (L.remaining || 0) - 1);
      L.nextDue = newP > 0 ? nextDateOnDay(L.day, L.nextDue) : null;
      n++;
    }
  }
  return n;
}
function loanCard(a) {
  const L = a.loan; if (!L) return '';
  const P = latestValuation(a.id)?.value || 0, r = mrate(L.rate);
  // remaining interest if the same EMI continues
  let left = P, int = 0, k = 0; while (left > 100 && k++ < 600) { const i = Math.round(left * r); int += i; left -= Math.min(L.emi, left + i) - i; }
  const payoff = L.nextDue ? (() => { let d = L.nextDue; for (let j = 1; j < k; j++) d = nextDateOnDay(L.day, d); return d; })() : null;
  const from = L.paidFrom ? accById(L.paidFrom) : null;
  const borrowed = L.borrowed || Math.max(P, ...D.valuations.filter((v) => v.accountId === a.id).map((v) => v.value));
  const paidPct = borrowed > 0 ? Math.max(0, Math.min(1, 1 - P / borrowed)) : 0;
  const C = 2 * Math.PI * 52;
  const ring = `<div class="card loanring"><svg width="132" height="132" viewBox="0 0 120 120" role="img" aria-label="${(paidPct * 100).toFixed(1)}% repaid"><circle cx="60" cy="60" r="52" fill="none" stroke="var(--line)" stroke-width="9"/><circle class="ringarc" cx="60" cy="60" r="52" fill="none" stroke="var(--brand-bg)" stroke-width="9" stroke-linecap="round" transform="rotate(-90 60 60)" style="stroke-dasharray:${C.toFixed(1)};--off:${(C * (1 - paidPct)).toFixed(1)};stroke-dashoffset:${ui.draw ? C.toFixed(1) : (C * (1 - paidPct)).toFixed(1)}"/><text x="60" y="60" text-anchor="middle" class="serif" style="font-size:22px;fill:var(--ink)">${(paidPct * 100).toFixed(1)}%</text><text x="60" y="78" text-anchor="middle" style="font-size:10px;fill:var(--muted)">repaid</text></svg>
    <div class="grow"><div class="small muted">Still to pay</div><div class="mid num">${inr(P, 0)}</div><div class="small muted" style="margin-top:8px">Borrowed</div><div class="num">${inr(borrowed, 0)} <button class="link tiny" data-act="setBorrowed" data-id="${a.id}">${L.borrowed ? 'Edit' : 'Set'}</button></div></div></div>`;
  const maxPre = Math.min(P, 2500000 * 100 / 100 * 100);
  const pre = `<div class="card"><div class="row"><h2 class="grow" style="margin:0"><label for="pp-${a.id}">If I prepay</label></h2><span class="mid num" id="ppAmt" style="color:var(--brand)">Nothing yet</span></div>
    <input id="pp-${a.id}" class="pp" type="range" min="0" max="${Math.max(5000000, Math.min(maxPre, 250000000))}" step="5000000" value="0" data-acc="${a.id}" aria-label="Prepayment amount">
    <div class="row tiny muted" style="justify-content:space-between"><span>₹0</span><span>${inr(Math.max(5000000, Math.min(maxPre, 250000000)), 0)}</span></div>
    <div class="split" style="margin-top:8px"><div><div class="small muted">Interest saved</div><div class="mid num" id="ppSaved" style="color:var(--brand)">₹0</div></div><div><div class="small muted">Loan ends</div><div class="mid num" id="ppEnds">${payoff ? MON[+payoff.slice(5, 7) - 1] + ' ' + payoff.slice(0, 4) : ''}</div></div>
    <div><div class="small muted">EMIs left</div><div class="num" id="ppEmis">${k}</div></div><div><div class="small muted">Interest still to pay</div><div class="num" id="ppLeft">${inr(int, 0)}</div></div></div>
    <p class="tiny muted" style="margin:8px 0 0">Ask the bank to reduce the tenure, not the EMI.</p></div>`;
  return ring + `<div class="card"><h2>EMI</h2>
    <div class="split"><div><div class="small muted">Monthly EMI</div><div class="mid num">${inr(L.emi, 0)}</div></div><div><div class="small muted">EMIs left</div><div class="mid">${k}</div></div></div>
    <p class="small" style="margin:10px 0 0">${L.nextDue ? `Next on <b>${fmtDate(L.nextDue, true)}</b>` : 'Fully repaid'} · ${L.rate ? `${(+L.rate).toFixed(2)}% a year` : 'no-cost (0%)'} · paid from ${from ? esc(accShort(from)) : 'outside Ledger'}</p>
    ${payoff ? `<p class="small muted" style="margin:6px 0 0">Ends ${fmtDate(payoff, true)}${int ? ` · ${inr(int, 0)} interest still to pay` : ''}</p>` : ''}
    ${P > 0 && P <= L.emi * 2 && L.rate ? `<p class="small warn" style="margin:8px 0 0">The outstanding (${inr(P, 0)}) is about one EMI, so Ledger thinks this loan is nearly over. If it isn't, tap <b>Update value</b> above and enter what you still owe from your loan statement.</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn ghost" style="flex:1" data-act="editAccount" data-id="${a.id}">Edit EMI</button><button class="btn ghost" style="flex:1" data-act="prepaySheet" data-id="${a.id}">Record a prepayment</button></div></div>` + (L.rate && P > 0 ? pre : '');
}

// ---------- manual transfers & balance updates ----------
const isCardAcc = (a) => a?.type === 'credit_card';
function transferCat(a, b) { return isCardAcc(a) || isCardAcc(b) ? 'card_payment' : (typeOf(b?.type).side === 'liability' || typeOf(a?.type).side === 'liability') ? 'loan_repayment' : 'self_transfer'; }
// For loans and investments (balance = latest value), a transfer moves the value
function adjustValue(a, delta, date, note) {
  const cur = latestValuation(a.id)?.value || 0;
  D.valuations.push({ id: uid(), accountId: a.id, date, value: Math.max(0, cur + delta), note, at: Date.now() });
}
// Creates both sides of a transfer. amount > 0 = paise moved from `from` to `to`.
function createTransfer(fromId, toId, amount, date, note = '') {
  const from = accById(fromId), to = accById(toId), t = uid(), cat = transferCat(from, to);
  const base = { time: null, notes: note, ref: null, importId: null, source: 'transfer', transferId: t, categoryId: cat, catManual: true, raw: '' };
  for (const [acc, other, amt, dir] of [[from, to, -amount, 'to'], [to, from, amount, 'from']]) {
    if (typeOf(acc.type).mode === 'ledger') D.transactions.push({ id: uid(), accountId: acc.id, date, amount: amt, payee: `${dir === 'to' ? 'To' : 'From'} ${other.name}`, description: `Transfer ${dir} ${accShort(other)}`, hash: 'transfer|' + uid(), ...base });
    else adjustValue(acc, typeOf(acc.type).side === 'liability' ? -amt : amt, date, `Transfer ${dir} ${other.name}`);
  }
}
// Turns one existing entry into a transfer: links the other side if it is there, otherwise adds it
function linkAsTransfer(x, otherId) {
  const other = accById(otherId), me = accById(x.accountId);
  const t = uid(), cat = transferCat(me, other);
  x.transferId = t; x.categoryId = cat; x.catManual = true;
  if (!x.payeeManual) x.payee = `${x.amount < 0 ? 'To' : 'From'} ${other.name}`;
  const hit = D.transactions.find((y) => y.accountId === otherId && !y.transferId && y.amount === -x.amount && daysApart(y.date, x.date) <= 4);
  if (hit) { hit.transferId = t; hit.categoryId = cat; hit.catManual = true; if (!hit.payeeManual) hit.payee = `${hit.amount < 0 ? 'To' : 'From'} ${me.name}`; return 'linked'; }
  if (typeOf(other.type).mode !== 'ledger') { adjustValue(other, typeOf(other.type).side === 'liability' ? x.amount : -x.amount, x.date, `Transfer from ${me.name}`); return 'value'; }
  D.transactions.push({ id: uid(), accountId: otherId, date: x.date, time: null, amount: -x.amount, payee: `${x.amount < 0 ? 'From' : 'To'} ${me.name}`, description: `Transfer ${x.amount < 0 ? 'from' : 'to'} ${accShort(me)}`, raw: '', notes: '', ref: x.ref || null, importId: null, hash: 'transfer|' + uid(), source: 'transfer', transferId: t, categoryId: cat, catManual: true });
  return 'created';
}
function setBalanceSheet(accId) {
  const a = accById(accId), cur = balance(a);
  openSheet(`<h3>Update balance</h3><p class="small muted" style="margin-top:-8px">${esc(accShort(a))}</p>
  <form data-form="setBalance" data-id="${a.id}">
    <label class="f"><span>${a.type === 'credit_card' ? 'Amount you owe right now' : 'Balance right now'} (₹)</span><input class="i num" name="bal" inputmode="decimal" value="${(Math.abs(cur) / 100).toFixed(2)}" required></label>
    <label class="f"><span>As on</span><input class="i" type="date" name="date" value="${todayIso()}" required></label>
    <p class="small" style="margin:0 0 6px">Ledger shows ${inr(cur)}. If yours is different, why?</p>
    <label class="row small" style="margin:6px 0"><input type="radio" name="why" value="transfer" checked class="chk"><span>I moved money to or from my other account:</span></label>
    <select class="i" name="other" style="margin:0 0 8px">${accOptions('', (o) => o.id !== a.id)}</select>
    <label class="row small" style="margin:6px 0"><input type="radio" name="why" value="adjust" class="chk"><span>Just correct it (missing entries, cash, interest)</span></label>
    <p class="tiny muted">Either way it won't count as spending or income. A transfer also corrects the other account.</p>
    <button class="btn wide">Save</button>
  </form>`);
}
function transferSheet(fromId) {
  const live = D.accounts.filter((a) => !a.archived);
  if (live.length < 2) return toast('Add your other account first.');
  fromId ||= live[0].id;
  openSheet(`<h3>Transfer between my accounts</h3><form data-form="transfer">
    <label class="f"><span>From</span><select class="i" name="from">${accOptions(fromId)}</select></label>
    <label class="f"><span>To</span><select class="i" name="to">${accOptions((live.find((a) => a.id !== fromId && typeOf(a.type).mode === 'ledger' && a.type !== 'credit_card') || live.find((a) => a.id !== fromId))?.id)}</select></label>
    <div class="split"><label class="f"><span>Amount (₹)</span><input class="i num" name="amount" inputmode="decimal" required></label>
    <label class="f"><span>Date</span><input class="i" type="date" name="date" value="${todayIso()}" required></label></div>
    <label class="f"><span>Note</span><input class="i" name="note" placeholder="optional"></label>
    <p class="small muted">Money out of one, into the other; neither counts as spending or income. If a statement or SMS later shows the same transfer, it replaces this entry instead of doubling it.</p>
    <button class="btn wide">Save transfer</button></form>`);
}

// ---------- transfer matching ----------
// A card payment from a bank account and the matching credit on the card are one movement of money
function matchTransfers() {
  const isCard = (x) => accById(x.accountId)?.type === 'credit_card';
  const cardIns = D.transactions.filter((x) => isCard(x) && x.amount > 0 && !x.transferId && (x.categoryId === 'card_payment' || /payment/i.test(x.payee + ' ' + x.description)));
  const bankOuts = D.transactions.filter((x) => !isCard(x) && x.amount < 0 && !x.transferId && (!x.categoryId || ['card_payment', 'self_transfer'].includes(x.categoryId)) && typeOf(accById(x.accountId)?.type).mode === 'ledger');
  let n = 0;
  for (const i of cardIns) {
    const o = bankOuts.find((b) => !b.transferId && b.amount === -i.amount && daysApart(b.date, i.date) <= 4);
    if (!o) continue;
    const t = uid(); i.transferId = o.transferId = t; i.categoryId = o.categoryId = 'card_payment'; n++;
  }
  // Money moved between your own bank/cash accounts
  const isLedger = (x) => !isCard(x) && typeOf(accById(x.accountId)?.type).mode === 'ledger';
  const selfish = (x) => !x.transferId && (!x.categoryId || x.categoryId === 'self_transfer');
  const outs = D.transactions.filter((x) => isLedger(x) && x.amount < 0 && selfish(x));
  for (const i of D.transactions.filter((x) => isLedger(x) && x.amount > 0 && selfish(x))) {
    const o = outs.find((b) => !b.transferId && b.accountId !== i.accountId && b.amount === -i.amount && daysApart(b.date, i.date) <= 3 && (b.categoryId === 'self_transfer' || i.categoryId === 'self_transfer'));
    if (!o) continue;
    const t = uid(); i.transferId = o.transferId = t; i.categoryId = o.categoryId = 'self_transfer'; n++;
  }
  return n;
}

// ---------- Ask Ledger ----------
function renderAsk(m) {
  setTop('Ask Ledger', { back: 'closeView' });
  const ex = ['How much did I spend on Swiggy since July?', 'How can I spend less?', 'Top categories last month', 'Show my Amazon orders', 'Spending by month this FY', 'What is my net worth?'];
  m.innerHTML = `<form data-form="ask" class="row" style="margin-bottom:10px"><input class="i" name="q" placeholder="Ask about your money" autocomplete="off" enterkeyhint="send" required><button class="btn">Ask</button></form>
  <div class="chips">${ex.map((q) => `<button class="chip" data-act="askEx" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
  <div class="small muted" id="aiStatus" style="margin:0 4px 10px">${esc(ui.aiStatus)}</div>
  ${ui.ask.map((a) => `<div class="card"><div class="small muted" style="margin-bottom:6px">${esc(a.q)}</div>${a.html}</div>`).join('') ||
    `<p class="small muted" style="margin:0 4px">Answers are calculated from your data on this phone, so the numbers are exact. Nothing is sent anywhere.${D.settings.ai?.model ? ' The on-device AI helps with questions Ledger can\'t read on its own.' : ''}</p>`}`;
}
function setAiStatus(t) { ui.aiStatus = t; const el = $('#aiStatus'); if (el) el.textContent = t; }
async function ensureModel() {
  const id = D.settings.ai?.model; if (!id) throw new Error('Set up Ask Ledger in More first.');
  if (AI.isLoaded(id)) return;
  const g = await AI.gpuStatus(); if (!g.ok) throw new Error(g.why);
  await AI.load(id, (p) => setAiStatus(`${p.progress < 1 ? 'Loading model' : 'Starting'}… ${Math.round(p.progress * 100)}%`));
  setAiStatus('');
}
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '';
function runQuery(plan) {
  const from = isoOk(plan.from), to = isoOk(plan.to);
  const words = (plan.payee || '').toLowerCase().split(/[^a-z0-9@&]+/).filter((w) => w.length > 1);
  const cat = catById(plan.category) ? plan.category : '';
  const accWords = (plan.account || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !['card', 'account', 'my', 'the', 'bank'].includes(w));
  const accs = accWords.length ? D.accounts.filter((a) => accWords.some((w) => `${a.name} ${a.institution} ${a.last4}`.toLowerCase().includes(w))) : [];
  const txs = D.transactions.filter((x) => {
    if (from && x.date < from) return false;
    if (to && x.date > to) return false;
    if (cat && x.categoryId !== cat) return false;
    if (accs.length && !accs.some((a) => a.id === x.accountId)) return false;
    if (words.length) { const hay = `${x.payee} ${x.description} ${x.raw || ''}`.toLowerCase(); const sq = squash(hay); if (!words.every((w) => hay.includes(w) || sq.includes(squash(w)))) return false; }
    return true;
  });
  const kind = (x) => catById(x.categoryId)?.kind;
  const spendTx = txs.filter((x) => (cat ? true : kind(x) !== 'transfer') && kind(x) !== 'income' && !(x.amount > 0 && !x.categoryId));
  const spent = -spendTx.reduce((s, x) => s + x.amount, 0);
  const received = txs.filter((x) => x.amount > 0 && (cat ? true : kind(x) !== 'transfer')).reduce((s, x) => s + x.amount, 0);
  const period = from || to ? `${from ? fmtDate(from, true) : 'the start'} to ${to ? fmtDate(to, true) : 'today'}` : 'all time';
  const chips = [words.length ? `“${esc(plan.payee)}”` : '', cat ? esc(catName(cat)) : '', accs.length ? esc(accs.map((a) => a.name).join(', ')) : '', period].filter(Boolean).map((c) => `<span class="badge">${c}</span>`).join(' ');
  const list = (xs) => `<div class="list" style="margin:10px 0 0">${xs.slice(0, 30).map((x) => txItem(x)).join('')}</div>${xs.length > 30 ? `<p class="small muted">and ${xs.length - 30} more</p>` : ''}`;
  const rows = (pairs) => `<table class="t" style="margin-top:8px">${pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${inr(v, 0)}</td></tr>`).join('')}</table>`;
  const group = (xs, keyFn) => { const mm = new Map(); for (const x of xs) { const k = keyFn(x); mm.set(k, (mm.get(k) || 0) - x.amount); } return [...mm.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]); };
  let head = '', body = '';
  switch (plan.intent) {
    case 'unsupported': return `<p>I can only answer questions about your money: transactions, accounts, net worth, or tips on spending.</p>`;
    case 'net_worth': { const nw = netWorth(), ln = loansTotal(); return `<div class="mid num">${inr(nw.net, 0)}</div><p class="small muted">Assets ${inr(nw.assets, 0)} · liabilities ${inr(nw.liabilities, 0)}${D.settings.loansSeparate && ln ? ` · loans ${inr(ln, 0)} kept separate` : ''}</p>`; }
    case 'account_balance': { const as = (accs.length ? accs : D.accounts.filter((a) => !a.archived)); return rows(as.map((a) => [accShort(a), balance(a)])); }
    case 'total_received': head = `<div class="mid num in">${inr(received, 0)}</div><p class="small">received, ${txs.filter((x) => x.amount > 0).length} transactions</p>`; body = list(txs.filter((x) => x.amount > 0)); break;
    case 'top_payees': head = `<p>Top payees by spending</p>`; body = rows(group(spendTx, (x) => x.payee || x.description).slice(0, 10)); break;
    case 'top_categories': head = `<p>Spending by category, ${inr(spent, 0)} in total</p>`; body = rows(group(spendTx, (x) => catName(x.categoryId)).slice(0, 10)); break;
    case 'monthly_trend': head = `<p>Spending by month</p>`; body = rows([...group(spendTx, (x) => ymOf(x.date))].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [monthLabel(k), v])); break;
    case 'list': case 'count': head = `<p><b>${txs.length}</b> transactions · net ${inr(txs.reduce((s, x) => s + x.amount, 0), 0)}</p>`; body = list([...txs].sort((a, b) => b.date.localeCompare(a.date))); break;
    default: head = `<div class="mid num">${inr(spent, 0)}</div><p class="small">${spent < 0 ? 'net refunds' : 'spent'} across ${spendTx.length} transactions</p>`; body = list([...spendTx].sort((a, b) => b.date.localeCompare(a.date)));
  }
  if (!txs.length) return `<p>No matching transactions.</p><p class="small">${chips}</p><p class="tiny muted">If that looks wrong, try naming the merchant or category differently.</p>`;
  return head + `<p class="small" style="margin:6px 0 0">${chips}</p>` + body;
}
// Spending summary the AI turns into advice: last 3 full months against the 3 before
function spendFacts() {
  const ym = ymOf(todayIso());
  const last3 = [-3, -2, -1].map((k) => addMonths(ym, k)), prev3 = [-6, -5, -4].map((k) => addMonths(ym, k));
  const st = (ms) => ms.map((m2) => monthStats(m2));
  const a = st(last3), b = st(prev3);
  const spend = a.reduce((t, x) => t + x.spend, 0), income = a.reduce((t, x) => t + x.income, 0);
  if (!spend) return null;
  const sumCats = (xs) => { const mm = new Map(); for (const x of xs) for (const [k, v] of x.byCat) mm.set(k, (mm.get(k) || 0) + v); return mm; };
  const ca = sumCats(a), cb = sumCats(b), prevHas = b.some((x) => x.spend);
  const cats = [...ca.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8);
  const vis = new Set(D.accounts.filter((x) => accVisible(x)).map((x) => x.id));
  const tx = D.transactions.filter((x) => vis.has(x.accountId) && x.amount < 0 && last3.includes(ymOf(x.date)) && catById(x.categoryId)?.kind !== 'transfer' && catById(x.categoryId)?.kind !== 'income');
  const byPayee = new Map(); for (const x of tx) { const k = x.payee || x.description; const e = byPayee.get(k) || { n: 0, v: 0, months: new Set() }; e.n++; e.v -= x.amount; e.months.add(ymOf(x.date)); byPayee.set(k, e); }
  const payees = [...byPayee.entries()].sort((p, q) => q[1].v - p[1].v).slice(0, 8);
  const small = tx.filter((x) => -x.amount < 50000); const smallV = small.reduce((t, x) => t - x.amount, 0);
  const recurring = [...byPayee.entries()].filter(([, e]) => e.months.size === 3 && e.n <= 4).sort((p, q) => q[1].v - p[1].v).slice(0, 6);
  const r0 = (v) => inr(Math.round(v / 100) * 100, 0);
  const lines = [
    `Period: ${monthLabel(last3[0])} to ${monthLabel(last3[2])}. Monthly average spending ${r0(spend / 3)}${income ? `, income ${r0(income / 3)}, savings rate ${Math.round((1 - spend / income) * 100)}%` : ''}.`,
    'Top categories (monthly average' + (prevHas ? ', change vs the 3 months before' : '') + '):',
    ...cats.map(([k, v]) => `- ${k === '_none' ? 'Uncategorised' : catName(k)}: ${r0(v / 3)}${prevHas && cb.get(k) ? ` (${v >= cb.get(k) ? '+' : ''}${Math.round((v / cb.get(k) - 1) * 100)}%)` : prevHas ? ' (new)' : ''}`),
    'Top payees over the 3 months:', ...payees.map(([k, e]) => `- ${k}: ${r0(e.v)} in ${e.n} payments`),
    `Payments under ₹500: ${small.length}, adding up to ${r0(smallV)}.`,
    recurring.length ? 'Paid every month (possible subscriptions or bills): ' + recurring.map(([k, e]) => `${k} ${r0(e.v / 3)}/month`).join('; ') : '',
    ca.get('interest_paid') ? `Interest paid: ${r0(ca.get('interest_paid'))}.` : '', ca.get('fees') ? `Bank charges and fees: ${r0(ca.get('fees'))}.` : '',
  ].filter(Boolean);
  const html = `<details style="margin-top:10px"><summary class="small">The figures used</summary><p class="small" style="white-space:pre-wrap">${esc(lines.join('\n'))}</p></details>`;
  const catsD = cats.map(([k, v]) => ({ id: k, name: k === '_none' ? 'Uncategorised' : catName(k), avg: v / 3, prev: cb.get(k) ? cb.get(k) / 3 : null }));
  return { text: lines.join('\n'), html, data: { spendAvg: spend / 3, incomeAvg: income / 3, cats: catsD, prevHas, payees, small: { n: small.length, v: smallV }, recurring, interest: ca.get('interest_paid') || 0, fees: ca.get('fees') || 0, uncat: ca.get('_none') || 0, spend } };
}
// Tips worked out by Ledger itself (used when the on-device AI is off or not working)
function builtinTips(d) {
  const r0 = (v) => inr(Math.round(v / 100) * 100, 0), out = [];
  const disc = new Set(['food_delivery', 'dining', 'shopping', 'entertainment', 'travel', 'personal_care', 'subscriptions', 'fuel', 'cabs', 'groceries']);
  const grew = d.cats.filter((c) => c.id !== '_none' && c.prev && c.avg >= 200000 && c.avg / c.prev >= 1.15).sort((x, y) => (y.avg - y.prev) - (x.avg - x.prev))[0];
  if (grew) out.push(`${grew.name} went up ${Math.round((grew.avg / grew.prev - 1) * 100)}% to ${r0(grew.avg)} a month. Getting back to ${r0(grew.prev)} saves ${r0(grew.avg - grew.prev)} a month.`);
  const top = d.cats.find((c) => c.id !== '_none' && c.id !== grew?.id);
  if (top) out.push(`${top.name} is your biggest spend at ${r0(top.avg)} a month (${Math.round(top.avg / d.spendAvg * 100)}% of spending)${disc.has(top.id) ? `. Trimming it by a fifth frees ${r0(top.avg / 5)} a month.` : '.'}`);
  if (d.small.n >= 15) out.push(`${d.small.n} payments under ₹500 added up to ${r0(d.small.v)} over 3 months, about ${r0(d.small.v / 3)} a month. Small spends are where money leaks.`);
  if (d.recurring.length) out.push(`You pay ${d.recurring.slice(0, 4).map(([k, e]) => `${k} (${r0(e.v / 3)})`).join(', ')} every month. Cancel any you no longer use.`);
  if (d.interest + d.fees > 0) out.push(`${r0(d.interest + d.fees)} went on interest and bank charges in 3 months. Paying card bills in full and on time avoids most of this.`);
  if (d.incomeAvg > 0) { const rate = Math.round((1 - d.spendAvg / d.incomeAvg) * 100); out.push(rate >= 0 ? `You kept ${rate}% of your income (${r0(d.incomeAvg - d.spendAvg)} a month).${rate < 20 ? ' Aiming for 20% would mean spending ' + r0(d.incomeAvg * 0.8) + ' a month or less.' : ''}` : `You spent ${r0(d.spendAvg - d.incomeAvg)} a month more than came in. Check that salary and transfers are categorised correctly.`); }
  if (d.uncat > d.spend * 0.2) out.push(`${r0(d.uncat)} of spending has no category, so these tips miss part of the picture. Categorise it for sharper advice.`);
  return out.slice(0, 5);
}
const aiOn = () => !!D.settings.ai?.model && !ui.aiBroken;
const tipsHtml = (tips) => `<ul style="padding-left:18px;margin:0">${tips.map((t2) => `<li style="margin-bottom:6px">${esc(t2.replace(/\*\*/g, ''))}</li>`).join('')}</ul>`;
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  const cats = D.categories.map((c) => ({ id: c.id, name: c.name }));
  const knownText = D.transactions.map((x) => `${x.payee} ${x.description}`).join(' ').toLowerCase();
  const accounts = D.accounts.filter((a) => !a.archived).map((a) => ({ name: a.name, words: [...new Set([...`${a.name} ${a.institution || ''}`.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['bank', 'card', 'account', 'savings', 'credit', 'the'].includes(w)), ...(a.last4 ? [a.last4] : [])])] }));
  // Ledger reads the question itself first: instant, exact, works with no AI
  let plan = planQuestion(q, { today: todayIso(), categories: cats, accounts, knownText }), note = '';
  const vague = plan.intent === 'total_spent' && !plan.payee && !plan.category && !plan.account && !plan.from;
  try {
    if (vague && aiOn()) {
      try {
        await ensureModel(); setAiStatus('Thinking…');
        plan = await AI.askJSON(AI.queryPrompt({ today: todayIso(), categories: cats, accounts: D.accounts.map((a) => accShort(a)) }), q, AI.querySchema(cats.map((c) => c.id)), 160);
      } catch (e) { console.error(e); ui.aiBroken = String(e?.message || e); note = 'The on-device AI is not working on this phone right now, so Ledger answered on its own.'; }
    }
    if (plan.intent === 'advice') {
      const f = spendFacts();
      if (!f) ui.ask.unshift({ q, plan, html: '<p>There is not enough spending history yet. Import a statement or two first.</p>' });
      else {
        let tips = null, by = 'Ledger worked these out from the figures below.';
        if (aiOn()) {
          try {
            await ensureModel(); setAiStatus('Looking at your spending…');
            const txt = await AI.askText(AI.advicePrompt(), f.text);
            tips = txt.split(/\n+/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 3);
            by = 'Written by the on-device AI from the figures below, which Ledger calculated.';
          } catch (e) { console.error(e); ui.aiBroken = String(e?.message || e); note = 'The on-device AI is not working on this phone right now, so Ledger answered on its own.'; }
        }
        if (!tips?.length) tips = builtinTips(f.data);
        ui.ask.unshift({ q, plan, html: `${tipsHtml(tips)}${f.html}<p class="tiny muted">${by}</p>${note ? `<p class="tiny muted">${note}</p>` : ''}` });
      }
    } else ui.ask.unshift({ q, plan, html: runQuery(plan) + (note ? `<p class="tiny muted">${note}</p>` : '') });
  } catch (e) { console.error(e); ui.ask.unshift({ q, html: `<p class="bad">${esc(e?.message || String(e) || 'Something went wrong')}</p>` }); }
  setAiStatus(''); render();
}
async function aiSuggest() {
  const uncats = D.transactions.filter((x) => !x.categoryId && !x.suggest);
  const byPayee = new Map(); for (const x of uncats) { const k = x.payee || x.description; if (!byPayee.has(k)) byPayee.set(k, x); }
  const todo = [...byPayee.entries()].slice(0, 40);
  if (!todo.length) return toast('Nothing left to suggest.');
  try {
    await ensureModel();
    const cats = D.categories.map((c) => ({ id: c.id, name: c.name }));
    const exMap = new Map(); for (const x of D.transactions) if (x.categoryId && x.catManual && exMap.size < 25) exMap.set(x.payee, x.categoryId);
    const examples = [...exMap.entries()].map(([payee, category]) => ({ payee, category }));
    let done = 0, got = 0;
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      setAiStatus(`Suggesting… ${done}/${todo.length}`);
      const user = batch.map(([k, x], j) => `${j}. ${k} | bank text: ${(x.raw || x.description).slice(0, 80)} | ${x.amount < 0 ? 'paid' : 'received'} ₹${Math.abs(x.amount / 100).toFixed(0)}`).join('\n');
      const r = await AI.askJSON(AI.categoryPrompt(cats, examples), user, AI.categorySchema(cats.map((c) => c.id), batch.length), 60 * batch.length);
      for (const it of r.items || []) {
        const b = batch[it.i]; if (!b || !catById(it.category)) continue;
        for (const x of uncats) if ((x.payee || x.description) === b[0]) x.suggest = it.category;
        got++;
      }
      done += batch.length;
    }
    save(); setAiStatus(`${got} suggestions. Tap one to accept, or edit the transaction.`); render();
  } catch (e) { console.error(e); setAiStatus(''); toast(e.message || 'AI suggestion failed', 4000); }
}
async function aiSheet() {
  openSheet(`<h3>Ask Ledger</h3><p class="small muted">Checking this phone…</p>`);
  const gpu = await AI.gpuStatus();
  const states = await Promise.all(AI.MODELS.map((m) => AI.isDownloaded(m.id)));
  const cur = D.settings.ai?.model;
  openSheet(`<h3>Ask Ledger</h3>
  <p class="small">An AI model that runs on this phone. It answers questions about your money, suggests categories, and reads SMS the built-in reader can't. Your data is never sent anywhere.</p>
  ${gpu.ok ? '' : `<p class="small bad">${esc(gpu.why)}</p>`}
  <div class="list">${AI.MODELS.map((m, i) => `<div class="item" style="display:block">
    <div class="row"><div class="grow"><div class="t">${m.label} ${cur === m.id ? '<span class="badge">In use</span>' : ''}</div><div class="s" style="white-space:normal">${m.size} download · ${esc(m.note)}</div></div></div>
    <div class="row" style="margin-top:8px">${states[i]
      ? `${cur === m.id ? '' : `<button class="chip" data-act="aiUse" data-id="${m.id}">Use this</button>`}<button class="chip" data-act="aiDelete" data-id="${m.id}">Delete download</button>`
      : `<button class="chip on" data-act="aiDownload" data-id="${m.id}" ${gpu.ok ? '' : 'disabled'}>Download</button>`}</div></div>`).join('')}</div>
  <div id="aiProg" class="hidden"><div class="bar"><i id="aiBar" style="width:0%"></i></div><p class="small muted" id="aiProgText"></p></div>
  <p class="tiny muted">Downloads come straight from Hugging Face (official MLC builds). Use Wi-Fi and keep Ledger open until it finishes. If iPhone storage runs very low, iOS may clear the model; you can download it again. ${cur ? '<button class="link" data-act="aiOff">Turn Ask Ledger off</button>' : ''}</p>`);
}

// ---------- lock / setup ----------
function showLock(html) { $('#lock').innerHTML = `<img class="logo" src="icons/icon-192.png" alt=""><div class="box">${html}</div>`; $('#lock').classList.add('on'); $('#app').classList.add('hidden'); closeSheet(); }
function hideLock() { $('#lock').classList.remove('on'); $('#lock').innerHTML = ''; $('#app').classList.remove('hidden'); }

function renderSetup() {
  showLock(`<h1>Ledger</h1><p class="lead">Your money, on your phone only. Nothing is uploaded anywhere.</p>
  <form data-form="setup">
    <label class="f"><span>Create a recovery passphrase</span><input class="i" type="password" name="p1" minlength="8" autocomplete="new-password" required></label>
    <label class="f"><span>Type it again</span><input class="i" type="password" name="p2" minlength="8" autocomplete="new-password" required></label>
    <p class="small muted">You'll use Face ID day to day. The passphrase is the only way back in if Face ID stops working, or to restore a backup. Write it down somewhere safe: it cannot be reset.</p>
    <button class="btn wide">Create my vault</button>
  </form>
  <p class="small" style="text-align:center"><button class="link" data-act="restorePick">Restore from a backup instead</button></p>`);
}
function renderUnlock(msg) {
  showLock(`<h1>Ledger</h1><p class="lead">Locked</p>
  ${vault.hasPasskey ? `<button class="btn wide" data-act="unlockFace">Unlock with Face ID</button><div style="height:18px"></div>` : ''}
  <form data-form="unlock" class="${vault.hasPasskey ? 'hidden' : ''}" id="passForm">
    <label class="f"><span>Recovery passphrase</span><input class="i" type="password" name="p" autocomplete="current-password" required></label>
    <button class="btn wide ${vault.hasPasskey ? 'ghost' : ''}">Unlock</button>
  </form>
  ${vault.hasPasskey ? `<p style="text-align:center"><button class="link" data-act="showPassForm">Use passphrase</button></p>` : ''}
  ${msg ? `<p class="small bad" style="text-align:center">${esc(msg)}</p>` : ''}`);
}
async function offerFaceId() {
  const sup = await passkeySupport();
  showLock(`<h1>Use Face ID?</h1><p class="lead">Unlock with Face ID instead of typing your passphrase. Your face never leaves the phone; iOS just releases the unlock key.</p>
  ${sup.ok ? `<button class="btn wide" data-act="enableFace">Turn on Face ID</button>` : `<p class="small warn" style="text-align:center">${esc(sup.why)}</p>`}
  <div style="height:12px"></div><button class="btn wide ghost" data-act="skipFace">${sup.ok ? 'Not now' : 'Continue'}</button>`);
}
async function afterUnlock() {
  D = migrate(vault.data); vault.data = D;
  if (processEmis() | processEpf()) save();
  refreshNavs().then((n) => { if (n && D) render(); }).catch(() => {});
  refreshStocks().then((n) => { if (n && D) render(); }).catch(() => {});
  hideLock(); render();
  requestPersistence().then(() => storageInfo());
}
function lockApp() { if (!D) return; AI.unload(); vault.saveNow().finally(() => { vault.lock(); D = null; ui.imp = null; ui.ask = []; $('#main').innerHTML = ''; renderUnlock(); }); }

document.addEventListener('visibilitychange', () => {
  if (!D) return;
  if (document.hidden) { hiddenAt = Date.now(); vault.saveNow().catch((e) => vault.onError(e)); }
  else if (!vault.lockOff && hiddenAt && Date.now() - hiddenAt > (D.settings.autoLockMin || 5) * 60000) lockApp();
});

// ---------- events ----------
const acts = {
  summarySheet: () => summarySheet(),
  safeSheet: () => safeSheet(),
  openBudgets: () => { ui.view = { page: 'budgets' }; render(); window.scrollTo(0, 0); },
  budgetSheet: (d) => budgetSheet(d.id),
  budgetRemove: (d) => { delete budgets()[d.id]; delete (D.settings.budgetSince || {})[d.id]; save(); closeSheet(); render(); },
  openDupes: () => { ui.view = { page: 'dupes' }; render(); window.scrollTo(0, 0); },
  dupeDel: (d) => { D.transactions = D.transactions.filter((x) => x.id !== d.id); for (const x of D.transactions) if (x.refundOf === d.id) delete x.refundOf; save(); render(); done('Deleted'); },
  dupeKeep: (d) => { (D.settings.notDupes ||= []).push(d.key); save(); render(); },
  openTags: () => { ui.view = { page: 'tags' }; render(); window.scrollTo(0, 0); },
  openTag: (d) => { ui.view = { page: 'tags', tag: d.tag }; render(); window.scrollTo(0, 0); },
  tagTrip: () => tagTripSheet(),
  tagRename: (d) => { const n = parseTags(prompt('New name', d.tag))[0]; if (!n || n === d.tag) return; for (const x of D.transactions) if (tagsOf(x).includes(d.tag)) x.tags = [...new Set(tagsOf(x).map((t) => (t === d.tag ? n : t)))]; save(); ui.view = { page: 'tags', tag: n }; render(); },
  tagRemove: (d) => { if (!confirm(`Remove #${d.tag} from all its transactions?`)) return; for (const x of D.transactions) if (tagsOf(x).includes(d.tag)) { x.tags = tagsOf(x).filter((t) => t !== d.tag); if (!x.tags.length) delete x.tags; } save(); ui.view = { page: 'tags' }; render(); },
  openInvest: () => { ui.view = { page: 'invest' }; render(); window.scrollTo(0, 0); },
  sumRefresh: () => { const top = $('#sheet').scrollTop; summarySheet(ui.sumPeriod); $('#sheet').scrollTop = top; },
  sumPeriod: (d) => { const top = $('#sheet').scrollTop; summarySheet(d.p); $('#sheet').scrollTop = top; },
  sumCopy: async () => { try { await navigator.clipboard.writeText(ui.sumText); done('Copied'); } catch { const t = $('#sheet textarea'); t.removeAttribute('readonly'); t.select(); document.execCommand('copy'); t.setAttribute('readonly', ''); done('Copied'); } },
  sumShare: async () => { try { await navigator.share({ text: ui.sumText }); } catch { /* cancelled */ } },
  openVault: () => { ui.tab = 'vault'; ui.view = null; render(); window.scrollTo(0, 0); },
  vaultOpen: (d) => vaultOpen(d.id),
  vaultEdit: (d) => vaultEdit(d.id),
  vaultAttach: async (d) => { const v = D.vault.find((x) => x.id === d.id); const fs = await pickFiles('image/*,application/pdf'); if (!fs.length || !v) return; for (const f of fs) { const rid = await saveReceipt(f, { title: v.title + ' · ' + f.name.replace(/\.\w+$/, ''), categoryId: 'insurance', note: 'Family vault' }); (v.files ||= []).push(rid); } save(); vaultOpen(v.id); done('Attached'); },
  vaultImport: async () => {
    const fs = await pickFiles('.json,application/json', false); if (!fs.length) return;
    try {
      const j = JSON.parse(await fs[0].text()); if (j.format !== 'ledger-vault') throw new Error('Not a Ledger vault file');
      let n = 0;
      for (const v of j.vault || []) {
        const ex = D.vault.find((x) => x.title === v.title);
        if (!ex) { D.vault.push({ id: uid(), files: [], ...v }); n++; continue; }
        // Already there: add any new contacts and claim steps, keep everything else as you edited it
        if (v.people) {
          if (JSON.stringify(ex.people || []) !== JSON.stringify(v.people)) { ex.people = v.people.map((p) => ({ ...p })); n++; }
          const inTiles = new Set(v.people.flatMap((p) => [p.email, p.phone, p.whatsapp && 'WhatsApp ' + p.whatsapp].filter(Boolean)));
          ex.contacts = (ex.contacts || []).filter((c) => !inTiles.has(c[1]) || (v.contacts || []).some((y) => y[1] === c[1]));
        }
        if (v.contacts?.length) { // file order and labels win; contacts you added by hand stay at the end
          const old = ex.contacts || [], vals = new Set(v.contacts.map((c) => c[1]));
          for (const c of v.contacts) { const y = old.find((y) => y[1] === c[1]); if (!y || y[0] !== c[0]) n++; }
          const next = [...v.contacts.map((c) => [...c]), ...old.filter((y) => !vals.has(y[1]))];
          if (JSON.stringify(next) !== JSON.stringify(old)) ex.contacts = next;
        }
        for (const c of v.claim || []) if (!(ex.claim ||= []).includes(c)) ex.claim.push(c);
      }
      for (const b of j.bills || []) if (!D.bills.some((x) => x.name === b.name)) D.bills.push({ id: uid(), ...b });
      for (const r of j.rules || []) if (!D.rules.some((x) => x.pattern === r.pattern)) { const rule = { id: uid(), sign: null, payee: null, createdAt: new Date().toISOString(), ...r }; D.rules.unshift(rule); applyRule(rule); }
      if (j.payWith) for (const [via, l4] of Object.entries(j.payWith)) { const a = D.accounts.find((x) => !x.archived && x.last4 === l4); if (a) (D.settings.payWith ||= {})[via] = a.id; }
      save(); render(); done(n ? `${n} added to the vault` : 'Vault is up to date');
    } catch (e) { toast(e.message || 'Could not read that file', 4000); }
  },
  vaultDelete: (d) => { if (!confirm('Delete this from the vault? Attached files stay in Receipts.')) return; D.vault = D.vault.filter((x) => x.id !== d.id); save(); closeSheet(); render(); },
  recapHide: () => { D.settings.recapSeen = addMonths(ymOf(todayIso()), -1); save(); render(); },
  recapSee: (d) => { ui.tab = 'tx'; ui.view = null; ui.month = d.ym; render(); window.scrollTo(0, 0); },
  recapShare: async (d) => { try { const f = await recapImage(d.ym); if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] }); else { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); } } catch (e) { if (e.name !== 'AbortError') toast('Could not make the image'); } },
  setBorrowed: (d) => { const a = accById(d.id); const v = prompt('How much did you borrow originally? (₹)', a.loan.borrowed ? a.loan.borrowed / 100 : ''); const p2 = v == null ? null : parseRupees(v); if (p2) { a.loan.borrowed = Math.abs(p2); save(); render(); } },
  swCat: (d) => { swClose(); const x = D.transactions.find((t) => t.id === d.id); if (!x) return; openSheet(`<h3>Category for ${esc(x.payee || 'this payment')}</h3><div class="list">${D.categories.filter((c) => (x.amount < 0) === (c.kind !== 'income') || c.kind === 'transfer').map((c) => `<button class="item" data-act="swSetCat" data-id="${x.id}" data-c="${c.id}">${catIcon(c.id)}<div class="grow">${esc(c.name)}<div class="s">${esc(c.group)}</div></div>${x.categoryId === c.id ? '<div class="in">✓</div>' : ''}</button>`).join('')}</div>`); },
  swSetCat: (d) => { const x = D.transactions.find((t) => t.id === d.id); if (!x) return; x.categoryId = d.c; x.catManual = true; delete x.suggest; save(); closeSheet(); render(); done(catName(d.c)); },
  swTransfer: (d) => { swClose(); acts.linkTransferSheet(d); },
  quickAdd: () => quickAdd(),
  qaKey: (d) => { const q = ui.qa; let a = q.amt; if (d.k === '⌫') a = a.slice(0, -1); else if (d.k === '.') { if (!a.includes('.')) a = (a || '0') + '.'; } else if (!/\.\d\d$/.test(a) && a.replace('.', '').length < 9) a = (a === '0' ? '' : a) + d.k; q.amt = a; q.payee = $('#qaPayee')?.value ?? q.payee; haptic(); renderQuick(); },
  qaPayee: (d) => { const q = ui.qa; q.payee = d.p; if (!q.catTouched) q.cat = guessCategory(d.p, -1) || ''; renderQuick(); },
  qaVia: (d) => { ui.qa.via = d.v; ui.qa.payee = $('#qaPayee')?.value ?? ui.qa.payee; haptic(); renderQuick(); },
  qaAttach: async () => { const fs = await pickFiles('image/*,application/pdf'); if (fs.length) { ui.qa.files.push(...fs); ui.qa.payee = $('#qaPayee')?.value ?? ui.qa.payee; renderQuick(); } },
  qaMore: () => { const q = ui.qa; const acc = payAccount(q.via); txSheet(null, acc?.id); setTimeout(() => { const f = document.querySelector('form[data-form=tx]'); if (!f) return; f.payee.value = $('#qaPayee')?.value || q.payee; if (q.amt) f.amount.value = q.amt; }, 0); },
  qaSave: () => qaSave(),
  payWithSheet: () => { const opt = (via, filter) => `<option value="">Not set</option>${accOptions(payAccount(via, false)?.id || '', filter)}`; const led = (a) => typeOf(a.type).mode === 'ledger'; openSheet(`<h3>Where quick entries go</h3><p class="small muted">Used by Quick add and by the "Log to Ledger" Shortcut.</p><form data-form="payWith">
    <label class="f"><span>UPI payments come from</span><select class="i" name="upi">${opt('upi', (a) => led(a) && a.type !== 'credit_card')}</select></label>
    <label class="f"><span>Card payments go on</span><select class="i" name="card">${opt('card', (a) => a.type === 'credit_card')}</select></label>
    <label class="f"><span>Cash</span><select class="i" name="cash">${opt('cash', led)}</select></label>
    <button class="btn wide">Save</button></form>`); },
  shortcutHelp: () => shortcutHelp(),
  openReceipts: () => { ui.view = { page: 'receipts' }; render(); window.scrollTo(0, 0); },
  addReceipt: async () => { const fs = await pickFiles('image/*,application/pdf'); if (fs.length) receiptForm(fs); },
  txAttach: async (d) => { const x = D.transactions.find((t) => t.id === d.id); const fs = await pickFiles('image/*,application/pdf'); if (!fs.length || !x) return; for (const f of fs) await saveReceipt(f, { txId: x.id, title: x.payee, date: x.date, categoryId: x.categoryId }); save(); txSheet(x); done('Receipt attached'); },
  openReceipt: (d) => openReceipt(d.id),
  shareReceipt: async (d) => { const r = D.receipts.find((x) => x.id === d.id); const f = r && await receiptFile(r); if (!f) return; if (navigator.canShare?.({ files: [f] })) navigator.share({ files: [f] }).catch(() => {}); else { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); } },
  deleteReceipt: async (d) => { if (!confirm('Delete this receipt? This cannot be undone.')) return; await vault.deleteFile(d.id); D.receipts = D.receipts.filter((x) => x.id !== d.id); save(); closeSheet(); render(); },
  toggleBackupReceipts: () => { D.settings.backupReceipts = D.settings.backupReceipts === false; save(); render(); },
  toggleLoans: () => { D.settings.loansSeparate = !D.settings.loansSeparate; save(); render(); toast(D.settings.loansSeparate ? 'Loans are now kept out of net worth' : 'Loans are now counted in net worth'); },
  openBills: () => { ui.view = { page: 'bills' }; render(); window.scrollTo(0, 0); },
  billSheet: (d) => { ui.pendingLast = null; billSheet(d.id ? D.bills.find((b) => b.id === d.id) : null, d.kind || 'reminder'); },
  subAdd: (d) => { const f = ui.found?.[+d.i]; if (!f) return; billSheet(null, 'subscription', { name: f.name, amount: f.amount, every: f.every, next: f.next, accountId: f.accountId, match: f.name.toLowerCase().split(/\s+/).slice(0, 2).join(' '), remind: 1 }); },
  subNo: (d) => { D.settings.subDismissed = [...new Set([...(D.settings.subDismissed || []), d.key])]; save(); render(); },
  billDone: (d) => { const b = D.bills.find((x) => x.id === d.id); if (!b) return; b.lastPaid = todayIso(); if (b.every === 'once') D.bills = D.bills.filter((x) => x.id !== b.id); else { const day = b.day || +b.next.slice(8); do { b.next = advance(b.next, b.every, day); } while (b.next <= todayIso()); } save(); closeSheet(); render(); done(b.every === 'once' ? 'Done' : `Next: ${fmtDate(b.next)}`); },
  billDelete: (d) => { D.bills = D.bills.filter((x) => x.id !== d.id); save(); closeSheet(); render(); },
  billCal: async (d) => {
    const b = D.bills.find((x) => x.id === d.id); if (!b) return;
    const ics = billIcs(b), name = b.name.replace(/[^\w ]+/g, '').trim() || 'reminder';
    const file = new File([ics], `${name}.ics`, { type: 'text/calendar' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics); a.download = `${name}.ics`; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove();
  },
  tab: (d) => { if (ui.tab !== d.tab) haptic(); ui.tab = d.tab; ui.view = null; if (d.tab !== 'tx') { ui.acc = ''; ui.cat = ''; ui.src = ''; } render(); window.scrollTo(0, 0); },
  closeSheet, closeView: () => { ui.view = ui.view?.page === 'tags' && ui.view.tag ? { page: 'tags' } : null; render(); },
  month: (d) => { ui.month = addMonths(ui.month, +d.d); render(); },
  showUncat: () => { ui.tab = 'tx'; ui.cat = '_none'; ui.month = ymOf(todayIso()); ui.view = null; render(); },
  showCat: (d) => { ui.tab = 'tx'; ui.cat = d.id; ui.month = ymOf(todayIso()); ui.view = null; render(); },
  editTx: (d) => txSheet(D.transactions.find((x) => x.id === d.id)),
  addTx: (d) => txSheet(null, d.acc || ui.view?.id),
  deleteTx: (d) => { if (!confirm('Delete this transaction?')) return; D.transactions = D.transactions.filter((x) => x.id !== d.id); save(); closeSheet(); render(); },
  openAccount: (d) => { ui.tab = 'accounts'; ui.view = { page: 'account', id: d.id }; render(); window.scrollTo(0, 0); },
  addAccount: () => openSheet(`<h3>Add an account</h3><div class="list"><button class="item" data-act="tab" data-tab="import"><div class="grow">Import a statement<div class="s">Ledger sets the account up from it</div></div><div class="muted">›</div></button><button class="item" data-act="addAccountManual"><div class="grow">Add by hand</div><div class="muted">›</div></button></div>`),
  addAccountManual: () => accountSheet(null),
  editAccount: (d) => accountSheet(accById(d.id)),
  archiveAccount: (d) => { const a = accById(d.id); a.archived = !a.archived; save(); closeSheet(); render(); },
  deleteAccount: (d) => {
    const a = accById(d.id); const n = D.transactions.filter((x) => x.accountId === a.id).length;
    if (!confirm(`Delete ${a.name} and its ${n} transactions? This cannot be undone.`)) return;
    D.transactions = D.transactions.filter((x) => x.accountId !== a.id); D.valuations = D.valuations.filter((v) => v.accountId !== a.id);
    D.accounts = D.accounts.filter((x) => x.id !== a.id); save(); closeSheet(); ui.view = null; render();
  },
  addValuation: (d) => valuationSheet(d.id),
  editValuation: (d) => { const v = D.valuations.find((x) => x.id === d.id); valuationSheet(v.accountId, v); },
  deleteValuation: (d) => { D.valuations = D.valuations.filter((v) => v.id !== d.id); save(); closeSheet(); render(); },
  togglePaid: (d) => { const a = accById(d.id); a.statement.paid = !a.statement.paid; save(); render(); },
  pickFile: (d) => { const f = $('#file'); f.dataset.kind = d.kind; f.multiple = d.kind === 'any'; f.accept = d.kind === 'pdf' ? 'application/pdf,.pdf' : d.kind === 'inbox' ? 'text/plain,.txt' : d.kind === 'any' ? 'application/pdf,.pdf,text/csv,.csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv,.csv,text/plain,.txt'; f.value = ''; f.click(); },
  cancelImport: () => { ui.imp = null; ui.batch = null; render(); },
  commitBatch,
  commitImport: commitBatch,
  batchOpen: (d) => { ui.imp = ui.batch[+d.i]; render(); window.scrollTo(0, 0); },
  batchBack: () => { ui.imp = null; render(); window.scrollTo(0, 0); },
  batchDrop: (d) => { ui.batch.splice(+d.i, 1); if (!ui.batch.length) ui.batch = null; render(); },
  impAll: () => { const all = ui.imp.rows.every((r) => r.include); ui.imp.rows.forEach((r) => { r.include = !all; }); render(); },
  undoImport: (d) => {
    const i = D.imports.find((x) => x.id === d.id); const n = D.transactions.filter((x) => x.importId === i.id).length;
    if (!confirm(`Remove the ${n} transactions added by this import?`)) return;
    D.transactions = D.transactions.filter((x) => x.importId !== i.id); D.imports = D.imports.filter((x) => x.id !== i.id);
    if (['holdings', 'mfsummary', 'cas'].includes(i.kind)) D.holdings = D.holdings.filter((h) => h.importId !== i.id);
    const a = accById(i.accountId);
    if (a?.statement && i.statement && a.statement.statementDate === i.statement.statementDate) {
      const prev = D.imports.filter((x) => x.accountId === a.id && x.statement).sort((p, q) => q.statement.statementDate.localeCompare(p.statement.statementDate))[0];
      a.statement = prev ? { ...prev.statement } : null; a.statementBalanceCheck = null;
    }
    save(); render();
  },
  backup: doBackup, exportCsv,
  shareBackup: () => {
    if (!pendingBackup) return;
    navigator.share({ files: [pendingBackup], title: 'Ledger backup' })
      .then(() => { markBackedUp(); closeSheet(); render(); toast('Backup saved'); })
      .catch((e) => { if (e.name !== 'AbortError') toast('Could not open the share sheet. Use Download instead.', 4000); });
  },
  backupDownloaded: () => { markBackedUp(); setTimeout(() => { closeSheet(); render(); }, 800); },
  restorePick: () => { $('#restoreFile').value = ''; $('#restoreFile').click(); },
  manageCats: catsSheet, manageRules: rulesSheet,
  editCat: (d) => {
    const c = catById(d.id);
    openSheet(`<h3>Edit category</h3><form data-form="editCat" data-id="${c.id}"><label class="f"><span>Name</span><input class="i" name="name" value="${esc(c.name)}" required></label><button class="btn wide">Save</button></form>
    <div style="height:10px"></div><button class="btn wide danger" data-act="deleteCat" data-id="${c.id}">Delete category</button>`);
  },
  deleteCat: (d) => {
    const n = D.transactions.filter((x) => x.categoryId === d.id).length;
    if (!confirm(`Delete this category?${n ? ` ${n} transactions become uncategorised.` : ''}`)) return;
    D.transactions.forEach((x) => { if (x.categoryId === d.id) x.categoryId = null; });
    D.rules = D.rules.filter((r) => r.categoryId !== d.id);
    D.categories = D.categories.filter((c) => c.id !== d.id); save(); catsSheet(); render();
  },
  deleteRule: (d) => { D.rules = D.rules.filter((r) => r.id !== d.id); save(); rulesSheet(); },
  lockNow: lockApp,
  stocksSheet: () => stocksSheet(),
  copyWorker: () => {
    if (!workerCode) return toast('Still loading, tap again in a second');
    navigator.clipboard.writeText(workerCode).then(() => toast('Relay code copied. Paste it in Cloudflare.')).catch(() => toast('Could not copy. Open sahilgp6.github.io/Ledger/cloudflare-worker.js and copy it from there.', 5000));
  },
  chartRange: (d) => { (D.settings.chartRange ||= {})[d.key] = d.r; haptic(); ui.draw = true; save(); render(); ui.draw = false; },
  toggleMask: () => { D.settings.masked = !D.settings.masked; haptic(); save(); render(); },
  relayOff: () => { D.settings.priceRelay = ''; save(); closeSheet(); render(); },
  refreshAll: async (d, el) => {
    if (el.disabled) return; el.disabled = true; el.style.opacity = '.5';
    toast('Refreshing prices…');
    const e = processEmis();
    let n = 0, sN = 0, sErr = false;
    try { n = await refreshNavs({ force: true }); } catch (err) { console.warn(err); }
    try { sN = await refreshStocks({ force: true }); } catch (err) { console.warn(err); sErr = true; }
    if (e) save();
    render();
    const funds = D.holdings.filter((h) => h.type === 'mf' && h.qty != null).length;
    const stocks = D.holdings.filter((h) => (h.type === 'stock' || h.type === 'etf') && h.qty != null).length;
    const parts = [];
    if (stocks) parts.push(sErr ? 'stock prices unavailable right now' : `${sN} of ${stocks} stock prices updated`);
    if (funds) parts.push(n ? `${n} of ${funds} fund NAVs updated` : 'fund NAVs already current');
    toast(navigator.onLine ? (parts.join(' · ') || 'Nothing to refresh').replace(/^./, (c) => c.toUpperCase()) : 'You are offline', 4000);
  },
  addHolder: (d) => {
    const name = d.name.charAt(0) + d.name.slice(1).toLowerCase();
    const me = D.members.find((x) => x.id === 'me');
    let id;
    if (me && me.name === 'Me') { me.name = name; id = 'me'; } else { id = 'm_' + uid().slice(0, 8); D.members.push({ id, name }); }
    const imp = ui.batch[+d.i]; imp.owner = id; if (imp.newName && !imp.newName.includes(name)) imp.newName = imp.newName.replace(/ · .*$/, '') + ' · ' + name;
    save(); render(); toast(`${name} added. This statement will be filed under ${name}.`, 3500);
  },
  refreshNav: async () => { toast('Checking NAVs…'); const n = await refreshNavs({ force: true }); render(); toast(n ? `${n} NAVs updated` : 'NAVs are already up to date (or the NAV service could not be reached)', 3500); },
  setWho: (d) => { if (D.settings.who === d.who) return; const o2 = [['all'], ...D.members.map((x) => [x.id])]; ui.whoFrom = Math.max(0, o2.findIndex((x) => x[0] === D.settings.who)); D.settings.who = d.who; haptic(); ui.draw = true; ui.swap = true; save(); render(); ui.draw = false; ui.swap = false; ui.whoFrom = null; },
  memberSheet: (d) => {
    const mb = D.members.find((x) => x.id === d.id);
    openSheet(`<h3>${mb ? 'Edit person' : 'Add a person'}</h3><form data-form="member" data-id="${mb?.id || ''}">
      <label class="f"><span>Name</span><input class="i" name="name" value="${esc(mb?.name || '')}" placeholder="e.g. your partner" required></label>
      <p class="small muted">Each account can belong to one person or be joint. Home, Accounts and Activity can then show each person or everyone combined. Joint accounts count half in each person's view.</p>
      <button class="btn wide">Save</button></form>
      ${mb && mb.id !== 'me' ? `<div style="height:10px"></div><button class="btn wide danger" data-act="memberDel" data-id="${mb.id}">Remove ${esc(mb.name)}</button>` : ''}`);
  },
  memberDel: (d) => {
    const n = D.accounts.filter((a) => ownerOf(a) === d.id).length;
    if (!confirm(`Remove this person?${n ? ` Their ${n} accounts move to ${memberName('me')}.` : ''}`)) return;
    D.accounts.forEach((a) => { if (a.owner === d.id) a.owner = 'me'; });
    D.members = D.members.filter((x) => x.id !== d.id); if (D.settings.who === d.id) D.settings.who = 'all';
    save(); closeSheet(); render();
  },
  forceUpdate: async () => {
    // Clears only the app's code cache; your data (IndexedDB) is untouched
    try { await vault.saveNow(); } catch (e) { if (!confirm('Your latest changes could not be saved (' + (e.message || e) + '). Reload anyway?')) return; }
    try { for (const k of await caches.keys()) if (k.startsWith('ledger-app-')) await caches.delete(k); } catch {}
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
    location.replace(location.pathname + '?v=' + Date.now());
  },
  prepaySheet: (d) => {
    const a = accById(d.id);
    openSheet(`<h3>Prepay ${esc(a.name)}</h3><form data-form="prepay" data-id="${a.id}">
      <div class="split"><label class="f"><span>Amount (₹)</span><input class="i num" name="amount" inputmode="decimal" required></label>
      <label class="f"><span>Date</span><input class="i" type="date" name="date" value="${todayIso()}" required></label></div>
      <label class="f"><span>Paid from</span><select class="i" name="from"><option value="">Outside Ledger</option>${accOptions(a.loan?.paidFrom || '', (o) => typeOf(o.type).mode === 'ledger')}</select></label>
      <label class="f"><span>After prepaying</span><select class="i" name="mode"><option value="tenure">Keep the EMI, finish sooner</option><option value="emi">Keep the end date, lower the EMI</option></select></label>
      <button class="btn wide">Record prepayment</button></form>`);
  },
  setBalance: (d) => setBalanceSheet(d.id),
  transferSheet: (d) => transferSheet(d.from || ui.view?.id || ui.acc),
  linkTransferSheet: (d) => {
    const x = D.transactions.find((t) => t.id === d.id);
    openSheet(`<h3>Transfer ${x.amount < 0 ? 'to' : 'from'} which account?</h3><p class="small muted">${inr(Math.abs(x.amount))} on ${fmtDate(x.date, true)}. If that account already has the matching entry, the two get linked; otherwise Ledger adds it there.</p>
      <form data-form="linkTransfer" data-id="${x.id}"><select class="i" name="other">${accOptions('', (o) => o.id !== x.accountId)}</select><div style="height:12px"></div><button class="btn wide">Link</button></form>`);
  },
  upiMine: (d, el) => { markUpi(d.h, true); el.closest('.card').remove(); toast('Marked as your own UPI ID'); },
  upiNot: (d, el) => { markUpi(d.h, false); el.closest('.card').remove(); },
  myUpiSheet: () => openSheet(`<h3>My UPI IDs</h3><p class="small muted">Money sent to these counts as a transfer between your own accounts.</p>
    <form data-form="addUpi" class="row" style="margin-bottom:12px"><input class="i" name="h" placeholder="name@bank" autocapitalize="off" required><button class="btn">Add</button></form>
    ${(D.settings.myUpi || []).map((h, i) => `<div class="item"><div class="grow">${esc(h)}</div><button class="link" data-act="upiDel" data-i="${i}">Remove</button></div>`).join('') || '<p class="small">None yet.</p>'}`),
  upiDel: (d) => { D.settings.myUpi.splice(+d.i, 1); save(); acts.myUpiSheet(); },
  pwSheet: () => openSheet(`<h3>Saved statement passwords</h3><p class="small muted">Kept inside your encrypted vault. Ledger tries these before asking when you upload a protected PDF.</p>
    ${(D.settings.pdfPasswords || []).length ? `<div class="list">${D.settings.pdfPasswords.map((p, i) => `<div class="item"><div class="grow num">${esc(p.pw.slice(0, 2))}${'•'.repeat(Math.max(3, p.pw.length - 2))}<div class="s">saved ${fmtDate(p.at.slice(0, 10), true)}</div></div><button class="link" data-act="pwDel" data-i="${i}">Delete</button></div>`).join('')}</div>` : '<p>None saved.</p>'}
    <button class="btn wide ghost" data-act="closeSheet">Close</button>`),
  pwDel: (d) => { D.settings.pdfPasswords.splice(+d.i, 1); save(); acts.pwSheet(); render(); },
  pasteSms: () => openSheet(`<h3>Paste an SMS</h3><form data-form="pasteSms"><textarea class="i" name="t" rows="7" placeholder="Txn Rs.198.00 On HDFC Bank Card 1234 …" required></textarea><div style="height:10px"></div><button class="btn wide">Add</button></form>`),
  smsSetup: () => smsSetupSheet(),
  inboxDismiss: (d) => { D.inbox = D.inbox.filter((x) => x.id !== d.id); save(); render(); },
  inboxManual: (d) => { const it = D.inbox.find((x) => x.id === d.id); D.inbox = D.inbox.filter((x) => x.id !== d.id); save(); render(); txSheet(null); const n = document.querySelector('form[data-form=tx] textarea[name=notes]'); if (n) n.value = it.text; },
  inboxAI: async (d) => {
    const it = D.inbox.find((x) => x.id === d.id); if (!it) return;
    try {
      toast('Reading with AI…'); await ensureModel();
      const r = await AI.askJSON(AI.smsPrompt(todayIso()), it.text, AI.SMS_SCHEMA, 120);
      if (!r.is_transaction || !r.amount) { toast('The AI says this is not a transaction.'); return; }
      const p = { ok: true, amount: Math.round(r.amount * 100) * (r.direction === 'credit' ? 1 : -1), last4: (r.last4 || '').slice(-4) || null, isCard: /card/i.test(it.text), merchant: r.merchant || '', ref: null, date: isoOk(r.date) || todayIso(), channel: /upi/i.test(it.text) ? 'UPI' : '', text: it.text };
      const acc = smsAccount(p.last4, p.isCard);
      if (acc) { addSms(acc, p, it.h); D.inbox = D.inbox.filter((x) => x.id !== it.id); toast(`Added ${inr(p.amount)} to ${acc.name}`); }
      else { it.status = 'noaccount'; it.parsed = p; toast('Read it. Now pick the account.'); }
      matchTransfers(); save(); render();
    } catch (e) { toast(e.message || 'AI could not read it', 4000); }
  },
  showStrays: (d) => { ui.tab = 'tx'; ui.view = null; ui.acc = d.id; ui.cat = ''; ui.q = ''; ui.src = 'sms'; render(); },
  clearSrc: () => { ui.src = ''; render(); },
  unlinkTransfer: (d) => { const x = D.transactions.find((t) => t.id === d.id); const tid = x.transferId; D.transactions.forEach((t) => { if (t.transferId === tid) delete t.transferId; }); save(); closeSheet(); render(); },
  openAsk: () => { ui.view = { page: 'ask' }; render(); window.scrollTo(0, 0); },
  askEx: (d) => ask(d.q),
  aiSetup: () => aiSheet(),
  aiSuggest: () => aiSuggest(),
  acceptSug: (d) => { const x = D.transactions.find((t) => t.id === d.id); x.categoryId = x.suggest; delete x.suggest; x.catManual = true; save(); render(); },
  acceptAllSug: () => { let n = 0; D.transactions.forEach((x) => { if (!x.categoryId && x.suggest) { x.categoryId = x.suggest; delete x.suggest; x.catManual = true; n++; } }); save(); render(); toast(`${n} categorised`); },
  aiUse: (d) => { D.settings.ai.model = d.id; save(); AI.unload(); aiSheet(); render(); },
  aiOff: () => { D.settings.ai.model = null; save(); AI.unload(); closeSheet(); render(); },
  aiDelete: async (d) => { if (!confirm('Delete this model download?')) return; await AI.remove(d.id); if (D.settings.ai.model === d.id) D.settings.ai.model = null; save(); aiSheet(); render(); },
  aiDownload: async (d, el) => {
    el.disabled = true; $('#aiProg').classList.remove('hidden');
    try {
      await AI.load(d.id, (p) => { const b = $('#aiBar'), t = $('#aiProgText'); if (b) b.style.width = Math.round(p.progress * 100) + '%'; if (t) t.textContent = p.text.replace(/\[.*?\]\s*/g, '').slice(0, 140); });
      D.settings.ai.model = d.id; save(); toast('Ask Ledger is ready'); aiSheet(); render();
    } catch (e) { console.error(e); el.disabled = false; const t = $('#aiProgText'); if (t) t.textContent = 'Failed: ' + (e.message || e); }
  },
  showPassForm: () => $('#passForm').classList.remove('hidden'),
  unlockFace: async () => {
    try { await vault.unlockWithPasskey(); await afterUnlock(); }
    catch (e) { renderUnlock(e.name === 'NotAllowedError' ? 'Face ID was cancelled.' : e.message || 'Face ID unlock failed.'); }
  },
  enableFace: async () => {
    try { await vault.enablePasskey(); toast('Face ID is on'); await afterUnlock(); }
    catch (e) { await offerFaceId(); toast(e.name === 'NotAllowedError' ? 'Cancelled' : (e.message || 'Could not turn on Face ID'), 3500); }
  },
  skipFace: () => afterUnlock(),
  toggleLock: () => openSheet(vault.lockOff
    ? `<h3>Turn app lock on?</h3><p>Ledger will ask for ${vault.hasPasskey ? 'Face ID' : 'your recovery passphrase'} every time it opens, and lock itself after a few minutes away.</p>${vault.hasPasskey ? '' : '<p class="small muted">You can turn on Face ID afterwards in More → Security.</p>'}<button class="btn wide" data-act="lockOnConfirm">Turn app lock on</button>`
    : `<h3>Turn app lock off?</h3><p>Ledger will open straight away, with no Face ID or passphrase.</p><ul class="small" style="padding-left:18px;line-height:1.5"><li>Anyone holding your unlocked iPhone can see your finances.</li><li>Your data stays encrypted on the phone, and backups still need your recovery passphrase.</li><li>Keep your passphrase safe: you need it to restore a backup or turn the lock back on later.</li></ul><button class="btn wide danger" data-act="lockOffConfirm">Turn app lock off</button><div style="height:10px"></div><button class="btn wide ghost" data-act="closeSheet">Keep it on</button>`),
  lockOffConfirm: async () => { try { await vault.setLockOff(); closeSheet(); render(); toast('App lock is off. Ledger opens without Face ID.'); } catch (e) { toast('Could not turn the lock off: ' + (e.message || e), 4000); } },
  lockOnConfirm: async () => { await vault.setLockOn(); closeSheet(); render(); toast('App lock is on'); },
  toggleFaceId: async () => {
    if (vault.hasPasskey) { if (confirm('Turn off Face ID unlock? You will need your passphrase.')) { await vault.disablePasskey(); render(); } return; }
    const sup = await passkeySupport();
    if (!sup.ok) return toast(sup.why, 4000);
    try { await vault.enablePasskey(); toast('Face ID is on'); render(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled' : e.message, 3500); }
  },
  changePass: () => openSheet(`<h3>Change recovery passphrase</h3><form data-form="changePass">
    <label class="f"><span>Current passphrase</span><input class="i" type="password" name="old" required></label>
    <label class="f"><span>New passphrase</span><input class="i" type="password" name="p1" minlength="8" required></label>
    <label class="f"><span>New passphrase again</span><input class="i" type="password" name="p2" minlength="8" required></label>
    <p class="small muted">Older backups still open with the passphrase that was in use when they were made.</p><button class="btn wide">Change</button></form>`),
  eraseAll: async () => {
    if (!confirm('Erase all Ledger data on this phone? Only a backup file can bring it back.')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    await Vault.erase(); vault.lock(); D = null; vault.meta = null; renderSetup();
  },
};
document.addEventListener('change', (e) => {
  const id = e.target.dataset?.inboxAcc; if (id && e.target.value) assignInbox(id, e.target.value);
});
// Swipe a transaction left to reveal Category and Transfer (tap anywhere else to close)
let swS = null, swOpen = null, swMoved = false;
function swClose() { if (swOpen) { swOpen.style.transform = ''; swOpen.closest('.sw')?.classList.remove('open'); swOpen = null; } }
document.addEventListener('touchstart', (e) => {
  const it = e.target.closest?.('.sw > .item'); swMoved = false;
  if (!it) { if (swOpen && !e.target.closest('.sw-acts')) swClose(); return; }
  if (swOpen && swOpen !== it) swClose();
  swS = { it, x: e.touches[0].clientX, y: e.touches[0].clientY, base: it === swOpen ? -152 : 0, dir: null };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swS) return;
  const dx = e.touches[0].clientX - swS.x, dy = e.touches[0].clientY - swS.y;
  if (!swS.dir) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; swS.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'; }
  if (swS.dir !== 'h') { swS = null; return; }
  swMoved = true; e.preventDefault();
  const x = Math.max(-190, Math.min(0, swS.base + dx));
  swS.it.style.transition = 'none'; swS.it.style.transform = `translateX(${x}px)`;
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (!swS) return; const it = swS.it; it.style.transition = '';
  const m = new DOMMatrixReadOnly(getComputedStyle(it).transform).m41;
  if (swS.dir === 'h') { if (m < -60) { it.style.transform = 'translateX(-152px)'; it.closest('.sw').classList.add('open'); swOpen = it; haptic(); } else { it.style.transform = ''; it.closest('.sw').classList.remove('open'); if (swOpen === it) swOpen = null; } }
  swS = null;
});
document.addEventListener('click', (e) => { if (swMoved && e.target.closest?.('.sw > .item')) { e.stopPropagation(); e.preventDefault(); swMoved = false; } else if (swOpen && e.target.closest?.('.sw > .item') === swOpen) { e.stopPropagation(); e.preventDefault(); swClose(); } }, true);
document.addEventListener('input', (e) => {
  if (!e.target.classList?.contains('pp')) return;
  const a = accById(e.target.dataset.acc); if (!a?.loan) return;
  const L = a.loan, P = latestValuation(a.id)?.value || 0, r = mrate(L.rate), amt = +e.target.value;
  const run = (p0) => { let left = p0, int = 0, k = 0; while (left > 100 && k++ < 600) { const i = Math.round(left * r); int += i; left -= Math.min(L.emi, left + i) - i; } return { k, int }; };
  const base = run(P), now = run(Math.max(0, P - amt));
  let d = L.nextDue || todayIso(); for (let j = 1; j < now.k; j++) d = nextDateOnDay(L.day, d);
  $('#ppAmt').textContent = amt ? inr(amt, 0) : 'Nothing yet';
  $('#ppSaved').textContent = inr(base.int - now.int, 0);
  $('#ppEnds').textContent = now.k ? MON[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : 'Paid off';
  $('#ppEmis').textContent = now.k + (amt ? ` (${base.k - now.k} fewer)` : '');
  $('#ppLeft').textContent = inr(now.int, 0);
});
document.addEventListener('touchstart', chartTouch, { passive: true });
document.addEventListener('touchmove', (e) => { if (e.target.closest?.('.chart .cwrap')) { e.preventDefault(); chartTouch(e); } }, { passive: false });
document.addEventListener('touchend', chartRelease);
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') { if (e.target.closest?.('.chart .cwrap')) chartTouch(e); else if (document.querySelector('.chart .cur:not([hidden])')) chartRelease(); } });
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = acts[el.dataset.act]; if (!fn) return;
  haptic();
  if (!(el.tagName === 'A' && el.hasAttribute('download'))) e.preventDefault();
  fn(el.dataset, el);
});

const forms = {
  budget: (f) => { const lim = parseRupees(f.get('lim')); const c = f.get('cat'); if (!c) return toast('Pick a category.'); if (!lim || lim <= 0) return toast('Enter a monthly limit.'); budgets()[c] = lim; (D.settings.budgetSince ||= {})[c] ||= ymOf(todayIso()); save(); closeSheet(); render(); done('Budget set'); },
  tagTrip: (f) => {
    const tag = parseTags(f.get('tag'))[0]; if (!tag) return toast('Give it a name.');
    const ids = new Set(f.getAll('ids')); let n = 0;
    for (const x of D.transactions) if (ids.has(x.id) && !tagsOf(x).includes(tag)) { x.tags = [...tagsOf(x), tag]; n++; }
    save(); closeSheet(); ui.view = { page: 'tags', tag }; render(); done(`${n} tagged #${tag}`);
  },
  epf: (f) => { const a = commitEpf(ui.epf, f.get('acc')); ui.epf = null; save(); closeSheet(); ui.tab = 'accounts'; ui.view = { page: 'account', id: a.id }; render(); done('EPF updated'); },
  vault: (f, form) => {
    const id = form.dataset.id; const amt = parseRupees(f.get('premium') || '');
    const vals = { kind: f.get('kind'), type: f.get('type'), title: f.get('title').trim(), provider: f.get('provider').trim(), policyNo: f.get('policyNo').trim(), cover: f.get('cover').trim(), premium: amt ? Math.abs(amt) : 0, freq: f.get('freq') || '', nextDue: f.get('nextDue') || '', nominee: f.get('nominee').trim(), notes: f.get('notes').trim() };
    let v; if (id) { v = D.vault.find((x) => x.id === id); Object.assign(v, vals); } else { v = { id: uid(), files: [], ...vals }; D.vault.push(v); }
    if (f.get('remind') && v.nextDue) D.bills.push({ id: uid(), kind: 'reminder', name: v.title + (v.premium ? ' premium' : ' renewal'), amount: v.premium || 0, every: v.freq || 'once', next: v.nextDue, day: +v.nextDue.slice(8), remind: 7, accountId: null, note: v.policyNo ? 'Policy ' + v.policyNo : '' });
    save(); closeSheet(); render(); done('Saved');
  },
  payWith: (f) => { D.settings.payWith = { upi: f.get('upi') || null, card: f.get('card') || null, cash: f.get('cash') || null }; save(); closeSheet(); render(); if (ui.qa) renderQuick(); else toast('Saved'); },
  receipt: async (f) => { const files = ui.rcPending || []; for (const file of files) await saveReceipt(file, { title: f.get('title').trim() + (files.length > 1 ? ' · ' + file.name : ''), date: f.get('date'), categoryId: f.get('categoryId') || null, note: f.get('note').trim() }); ui.rcPending = null; save(); closeSheet(); render(); done(files.length > 1 ? `${files.length} saved` : 'Receipt saved'); },
  bill: (f, form) => {
    const amt = parseRupees(f.get('amount') || '');
    const next = f.get('next'); if (!next) return toast('Pick a date.');
    const v = { name: f.get('name').trim(), amount: amt ? Math.abs(amt) : 0, every: f.get('every'), next, day: +next.slice(8), remind: +f.get('remind'), accountId: f.get('accountId') || null, note: (f.get('note') || '').trim() };
    if (form.dataset.kind === 'subscription') v.match = (f.get('match') || '').trim().toLowerCase();
    const id = form.dataset.id;
    if (id) Object.assign(D.bills.find((x) => x.id === id), v); else D.bills.push({ id: uid(), kind: form.dataset.kind, ...v, ...(ui.pendingLast && form.dataset.kind === 'subscription' ? { lastPaid: ui.pendingLast } : {}) });
    ui.pendingLast = null;
    processBills(); save(); closeSheet(); render(); toast('Saved');
  },
  setup: async (f) => {
    if (f.get('p1') !== f.get('p2')) return toast('The passphrases do not match.');
    toast('Creating your vault…');
    await vault.create(f.get('p1'), newData());
    await offerFaceId();
  },
  unlock: async (f) => {
    try { await vault.unlockWithPassphrase(f.get('p')); await afterUnlock(); } catch (e) { renderUnlock(e.message); if (vault.hasPasskey) $('#passForm').classList.remove('hidden'); }
  },
  changePass: async (f) => {
    if (f.get('p1') !== f.get('p2')) return toast('The new passphrases do not match.');
    try { await vault.changePassphrase(f.get('old'), f.get('p1')); closeSheet(); toast('Passphrase changed. Make a fresh backup.'); } catch (e) { toast(e.message); }
  },
  pdfPass: async (f) => { closeSheet(); pendingRemember = !!f.get('remember'); await handlePdf(pendingFile, f.get('pw')); pendingRemember = false; processQueue(); },
  pasteSms: async (f) => { closeSheet(); await handleInbox(f.get('t'), 'paste'); },
  prepay: (f, form) => {
    const a = accById(form.dataset.id), amt = parseRupees(f.get('amount')); if (!amt) return toast('Enter an amount.');
    const date = f.get('date');
    if (f.get('from')) createTransfer(f.get('from'), a.id, Math.abs(amt), date, 'Loan prepayment');
    else adjustValue(a, -Math.abs(amt), date, 'Prepayment');
    const L = a.loan, P = latestValuation(a.id)?.value || 0;
    if (L && P > 0) {
      if (f.get('mode') === 'emi') L.emi = emiFor(P, mrate(L.rate), Math.max(1, L.remaining || 1));
      else L.remaining = monthsFor(P, L.emi, mrate(L.rate)) || L.remaining;
    } else if (L && P <= 0) L.nextDue = null;
    save(); closeSheet(); render();
    toast(L ? (f.get('mode') === 'emi' ? `New EMI ${inr(L.emi, 0)}` : `${L.remaining} EMIs left now`) : 'Prepayment recorded', 3500);
  },
  setBalance: (f, form) => {
    const a = accById(form.dataset.id); const v = parseRupees(f.get('bal')); if (v == null) return toast('Enter the balance.');
    const actual = a.type === 'credit_card' ? -Math.abs(v) : v; const date = f.get('date');
    const diff = actual - balance(a);
    a.balanceSetAt = date;
    const asTransfer = f.get('why') === 'transfer' && f.get('other');
    if (diff) {
      if (asTransfer) { if (diff > 0) createTransfer(f.get('other'), a.id, diff, date, 'Balance update'); else createTransfer(a.id, f.get('other'), -diff, date, 'Balance update'); }
      else D.transactions.push({ id: uid(), accountId: a.id, date, time: null, amount: diff, payee: 'Balance adjustment', description: 'Balance adjustment', raw: '', notes: `Set balance to ${inr(actual)}`, ref: null, importId: null, hash: 'adjust|' + uid(), source: 'adjustment', categoryId: 'adjustment', catManual: true });
    }
    save(); closeSheet(); render();
    toast(!diff ? 'Balance confirmed' : asTransfer ? `${inr(Math.abs(diff))} recorded as a transfer ${diff > 0 ? 'from' : 'to'} ${accById(f.get('other')).name}` : `Adjusted by ${inrS(diff)}`, 3500);
  },
  transfer: (f) => {
    const amt = parseRupees(f.get('amount')); if (!amt) return toast('Enter an amount.');
    if (f.get('from') === f.get('to')) return toast('Pick two different accounts.');
    createTransfer(f.get('from'), f.get('to'), Math.abs(amt), f.get('date'), f.get('note').trim()); save(); closeSheet(); render(); toast('Transfer saved');
  },
  linkTransfer: (f, form) => {
    const x = D.transactions.find((t) => t.id === form.dataset.id); const r = linkAsTransfer(x, f.get('other'));
    save(); closeSheet(); render(); toast(r === 'linked' ? 'Linked with the matching entry' : r === 'created' ? 'Marked as a transfer and added to the other account' : 'Marked as a transfer');
  },
  member: (f, form) => {
    const name = f.get('name').trim(); if (!name) return;
    const id = form.dataset.id;
    if (id) D.members.find((x) => x.id === id).name = name;
    else D.members.push({ id: 'm_' + uid().slice(0, 8), name });
    save(); closeSheet(); render(); toast(id ? 'Saved' : `${name} added. Upload their statements, or set "Belongs to" on an account.`, 4000);
  },
  relay: async (f) => {
    let url = (f.get('url') || '').trim().replace(/\/+$/, '');
    if (!url) return toast('Paste the relay address first.');
    if (!/^https:\/\//.test(url)) url = 'https://' + url;
    try {
      const r = await fetch(url + '/quote?symbols=NIFTYBEES', { cache: 'no-store' });
      const j = await r.json();
      if (!j.quotes?.NIFTYBEES?.price) throw new Error(j.error || 'no price came back');
      D.settings.priceRelay = url; save();
      const n = await refreshStocks({ force: true }).catch(() => 0);
      closeSheet(); render(); toast(`Live prices on: NIFTYBEES ₹${j.quotes.NIFTYBEES.price}. ${n} holdings updated.`, 4500);
    } catch (e) { toast('The relay did not answer correctly: ' + (e.message || e), 5000); }
  },
  addUpi: (f) => { markUpi(f.get('h').trim(), true); acts.myUpiSheet(); },
  ask: async (f, form) => { const q = f.get('q'); form.reset(); await ask(q); },
  tx: (f, form) => {
    const amt = parseRupees(f.get('amount')); if (amt == null || amt === 0) return toast('Enter an amount.');
    const signed = f.get('dir') === 'in' ? Math.abs(amt) : -Math.abs(amt);
    const id = form.dataset.id;
    const vals = { payee: f.get('payee').trim(), amount: signed, categoryId: f.get('categoryId') || null, date: f.get('date'), accountId: f.get('accountId'), notes: f.get('notes').trim(), tags: parseTags(f.get('tags')) };
    if (!vals.tags.length) vals.tags = undefined;
    let x;
    if (id) {
      x = D.transactions.find((t) => t.id === id);
      if ((x.categoryId || null) !== vals.categoryId) { x.catManual = true; delete x.suggest; }
      if (x.payee !== vals.payee) x.payeeManual = true;
      Object.assign(x, vals);
    }
    else { x = { id: uid(), description: vals.payee, raw: '', hash: 'manual|' + uid(), importId: null, ref: null, time: null, ...vals }; D.transactions.push(x); }
    let msg = 'Saved';
    if (f.get('makeRule') && vals.categoryId && !$('#ruleRow').classList.contains('hidden')) {
      const pattern = (f.get('rulePattern') || '').trim() || x.payee;
      const rule = { id: uid(), pattern, categoryId: vals.categoryId, payee: null, sign: null, createdAt: new Date().toISOString() };
      D.rules.unshift(rule);
      const n = applyRule(rule);
      msg = `Saved. Rule added${n ? `, ${n} other transactions updated` : ''}.`;
    }
    save(); closeSheet(); render(); toast(msg);
  },
  account: (f, form) => {
    const id = form.dataset.id;
    const type = id ? accById(id).type : f.get('type');
    const t = typeOf(type);
    const vals = { name: f.get('name').trim(), institution: f.get('institution').trim(), last4: f.get('last4').trim() };
    if (f.get('owner')) vals.owner = f.get('owner');
    let a;
    if (id) { a = accById(id); Object.assign(a, vals); }
    else { a = { id: uid(), type, currency: 'INR', createdAt: new Date().toISOString(), ...vals }; D.accounts.push(a); }
    if (t.mode === 'ledger') {
      const o = parseRupees(f.get('opening') || '0') || 0;
      const signed = t.side === 'liability' ? -Math.abs(o) : o;
      const date = f.get('openingDate') || todayIso();
      if (!a.opening || a.opening.amount !== signed || a.opening.date !== date) a.opening = { amount: signed, date, source: 'manual' };
    } else if (!id) {
      const v = parseRupees(f.get('value') || '');
      if (v != null && !isLoanType(type)) D.valuations.push({ id: uid(), accountId: a.id, date: todayIso(), value: Math.abs(v), note: '', at: Date.now() });
    }
    if (isLoanType(type)) {
      const r = setupLoan(a, { outstanding: id ? null : parseRupees(f.get('value') || ''), emi: parseRupees(f.get('emi') || ''), remaining: parseInt(f.get('remaining'), 10), rate: f.get('rate') === '' ? null : parseFloat(f.get('rate')), nextDue: f.get('nextDue'), paidFrom: f.get('paidFrom') || null });
      if (r.error) { toast(r.error, 4000); if (!id) D.accounts = D.accounts.filter((x) => x.id !== a.id); return; }
      const n = processEmis();
      const note = (r.note || '').replace(/^\d+ EMIs left\.$/, '');
      if (note || n) toast(`${note}${n ? ` ${n} past EMI${n > 1 ? 's' : ''} recorded, ${a.loan?.remaining} left.` : ''}`.trim(), 4500);
    }
    save(); closeSheet(); if (!id) { ui.tab = 'accounts'; ui.view = { page: 'account', id: a.id }; } render();
  },
  valuation: (f, form) => {
    const v = parseRupees(f.get('value')); if (v == null) return toast('Enter a value.');
    const id = form.dataset.id;
    if (id) Object.assign(D.valuations.find((x) => x.id === id), { value: Math.abs(v), date: f.get('date'), note: f.get('note').trim(), at: Date.now() });
    else D.valuations.push({ id: uid(), accountId: form.dataset.acc, value: Math.abs(v), date: f.get('date'), note: f.get('note').trim(), at: Date.now() });
    save(); closeSheet(); render();
  },
  addCat: (f) => {
    const g = f.get('group'); const kind = D.categories.find((c) => c.group === g)?.kind || 'expense';
    D.categories.push({ id: 'c_' + uid().slice(0, 8), name: f.get('name').trim(), group: g, kind }); save(); catsSheet();
  },
  editCat: (f, form) => { catById(form.dataset.id).name = f.get('name').trim(); save(); catsSheet(); render(); },
  addRule: (f) => {
    const rule = { id: uid(), pattern: f.get('pattern').trim(), categoryId: f.get('categoryId'), payee: f.get('payee').trim() || null, sign: f.get('sign') || null, createdAt: new Date().toISOString() };
    D.rules.unshift(rule); const n = applyRule(rule); save(); rulesSheet(); render(); toast(`Rule added${n ? `, ${n} transactions updated` : ''}`);
  },
};
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]'); if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try { await forms[form.dataset.form](new FormData(form), form); }
  catch (err) { console.error(err); toast(err.message || 'Something went wrong'); }
  finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
});

let fileQueue = [];
async function processQueue() {
  while (fileQueue.length) {
    if ($('#sheet').classList.contains('on') && pendingFile) return; // waiting for a password
    const file = fileQueue.shift();
    toast('Reading ' + file.name + '…');
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') await handlePdf(file);
      else if (/\.xlsx$/i.test(file.name)) await handleXlsx(file);
      else await handleCsv(file);
    } catch (err) { console.error(err); toast('Could not read ' + file.name); }
    if ($('#sheet').classList.contains('on')) return; // a password prompt is open; resumes after it
  }
}
$('#file').addEventListener('change', async (e) => {
  const files = [...e.target.files]; const kind = e.target.dataset.kind; e.target.value = ''; if (!files.length) return;
  if (kind === 'inbox') { try { await handleInbox(await files[0].text(), files[0].name); } catch (err) { toast('Could not read that file.'); } return; }
  pendingFile = null;
  fileQueue.push(...files);
  processQueue();
});
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  let json; try { json = JSON.parse(await file.text()); } catch { return toast('That is not a backup file.'); }
  openSheet(`<h3>Restore backup</h3><p class="small">From ${esc(json.exportedAt ? fmtDate(json.exportedAt.slice(0, 10), true) : 'unknown date')}. This replaces everything currently in the app.</p>
    <form data-form="restore"><label class="f"><span>Passphrase used when the backup was made</span><input class="i" type="password" name="p" required></label><button class="btn wide">Restore</button></form>`);
  forms.restore = async (f) => {
    try { await Vault.restoreBackup(json, f.get('p')); }
    catch (err) { return toast(err.message); }
    closeSheet(); vault.lock(); D = null; await vault.exists(); await vault.unlockWithPassphrase(f.get('p'));
    toast('Restored. Turn Face ID on again in More.', 3500); await afterUnlock();
  };
});

// ---------- boot ----------
vault.onError = (e) => { console.error(e); toast('Could not save your changes: ' + (e.message || e), 6000); };
async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    // A new version took over: reload straight away if nothing is in progress, otherwise on next open
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      if (!D || (!ui.batch && !$('#sheet').classList.contains('on'))) { reloading = true; location.reload(); }
      else toast('Update installed. It applies next time you open Ledger.', 4000);
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  try {
    if (await vault.exists()) {
      if (vault.lockOff) { try { await vault.unlockWithDevice(); await afterUnlock(); return; } catch (e) { console.warn('Lock-off open failed', e); } }
      renderUnlock();
    } else renderSetup();
  } catch (e) {
    showLock(`<h1>Storage unavailable</h1><p class="lead">This browser is blocking on-device storage (Private Browsing does this). Open the app normally or from the Home Screen.</p>`);
  }
}
boot();

// Exposed for automated tests only
window.__ledger = { get data() { return D; }, vault, ui, render, runQuery, recapCard, spendFacts, ask, builtinTips, detectSubs, processBills, billIcs, handleInbox, matchTransfers, AI };

// Savings goal and AI style on the Summary sheet: saved as you leave each box
document.addEventListener('change', (e) => {
  if (e.target.id === 'safeExtra') { const v = parseRupees(e.target.value); D.settings.safeExtra = v && v > 0 ? v : 0; save(); render(); safeSheet(); return; }
  if (e.target.id === 'safeAcct') { D.settings.safeAcct = e.target.value; save(); render(); safeSheet(); return; }
  if (e.target.dataset?.safe) { safeOpts()[e.target.dataset.safe] = e.target.checked; save(); render(); const t = $('#sheet').scrollTop; safeSheet(); $('#sheet').scrollTop = t; return; }
  if (e.target.id === 'safeGoal') { const v = parseRupees(e.target.value); D.settings.saveTarget = v && v > 0 ? v : 0; save(); render(); safeSheet(); return; }
  if (e.target.id === 'sumTarget') { const v = parseRupees(e.target.value); D.settings.saveTarget = v && v > 0 ? v : 0; save(); acts.sumRefresh(); }
  else if (e.target.id === 'sumAll') { D.settings.sumAll = e.target.checked; save(); acts.sumRefresh(); }
  else if (e.target.id === 'sumStyle') { D.settings.aiStyle = e.target.value.trim().slice(0, 300); save(); acts.sumRefresh(); }
});
