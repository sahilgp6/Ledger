import { Vault, passkeySupport, requestPersistence } from './store.js';
import * as P from './parsers.js';
import { ACCOUNT_TYPES, typeOf, DEFAULT_CATEGORIES, categorize, payeeFrom, squash } from './rules.js';
import { parseSms, smsPayee, splitInbox } from './sms.js';
import * as AI from './ai.js';

const APP_VERSION = '0.5.0';
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
function closeSheet() { $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on'); }
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
  d.inbox ||= []; d.smsSeen ||= []; d.settings.ai ||= { model: null };
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
  const v = latestValuation(a.id)?.value || 0;
  return t.side === 'liability' ? -v : v;
}
// Card EMIs still to be billed (not yet in the statement balance) are real debt
const unbilledEmi = (a) => (a.type === 'credit_card' ? (a.statement?.emiLoans || []).reduce((s, l) => s + (l.principalLeft || 0), 0) : 0);

function netWorth() {
  let assets = 0, liabilities = 0;
  for (const a of D.accounts) {
    if (a.archived) continue;
    const b = balance(a) - unbilledEmi(a);
    if (b >= 0 && typeOf(a.type).side === 'asset') assets += b; else liabilities += b;
  }
  return { assets, liabilities, net: assets + liabilities };
}

function monthStats(ym) {
  let spend = 0, income = 0, uncategorised = 0;
  const byCat = new Map();
  for (const x of D.transactions) {
    if (!x.date.startsWith(ym)) continue;
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
function render() {
  if (!D) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const m = $('#main');
  if (ui.view?.page === 'account') return renderAccount(m, ui.view.id);
  if (ui.view?.page === 'ask') return renderAsk(m);
  ({ home: renderHome, tx: renderTx, accounts: renderAccounts, import: renderImport, more: renderMore }[ui.tab])(m);
}

function txItem(x, showAcc = true) {
  const c = catById(x.categoryId);
  const a = accById(x.accountId);
  const sug = !c && x.suggest && catById(x.suggest) ? ` <span class="badge" data-act="acceptSug" data-id="${x.id}">AI: ${esc(catName(x.suggest))} ✓</span>` : '';
  const sub = [c ? c.name : '<span class="warn">Uncategorised</span>' + sug, showAcc && a ? esc(accShort(a)) : '', x.source === 'sms' ? 'from SMS' : '', x.transferId ? 'matched transfer' : ''].filter(Boolean).join(' · ');
  return `<button class="item" data-act="editTx" data-id="${x.id}">
    <div class="ico">${esc(initials(x.payee || x.description))}</div>
    <div class="grow"><div class="t">${esc(x.payee || x.description)}</div><div class="s">${sub}</div></div>
    <div class="a num ${x.amount > 0 ? 'in' : ''}">${x.amount > 0 ? '+' : ''}${inr(x.amount)}</div></button>`;
}

function renderHome(m) {
  setTop('Ledger');
  if (!D.accounts.length) {
    m.innerHTML = `<div class="card"><h2>Welcome</h2><p>Everything you add stays on this phone, encrypted. Start with a statement.</p>
      <button class="btn wide" data-act="tab" data-tab="import">Import a statement</button>
      <p class="small muted" style="margin-top:12px">Or <button class="link" data-act="addAccount">add an account by hand</button>.</p></div>`;
    return;
  }
  const nw = netWorth();
  const ym = ymOf(todayIso());
  const s = monthStats(ym), prev = monthStats(addMonths(ym, -1));
  const months = [-5, -4, -3, -2, -1, 0].map((k) => { const y = addMonths(ym, k); return { y, v: monthStats(y).spend }; });
  const maxV = Math.max(1, ...months.map((x) => x.v));
  const top = s.byCat.slice(0, 5); const topMax = Math.max(1, ...top.map((x) => x[1]));
  const dues = D.accounts.filter((a) => a.type === 'credit_card' && !a.archived && a.statement?.dueDate && a.statement.totalDue > 0 && daysUntil(a.statement.dueDate) >= -3 && !a.statement.paid);
  const recent = [...D.transactions].sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '')).slice(0, 5);
  const backupOld = D.transactions.length && (!D.settings.lastBackupAt || (Date.now() - new Date(D.settings.lastBackupAt)) > 30 * 864e5);

  m.innerHTML = `
  <div class="card"><h2>Net worth</h2>
    <div class="big num">${inr(nw.net, 0)}</div>
    <div class="split" style="margin-top:10px">
      <div><div class="small muted">Assets</div><div class="num">${compact(nw.assets)}</div></div>
      <div><div class="small muted">Liabilities</div><div class="num">${compact(nw.liabilities)}</div></div>
    </div></div>
  ${dues.map((a) => { const d = daysUntil(a.statement.dueDate); return `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openAccount" data-id="${a.id}">
      <div class="grow"><div class="t">${esc(accShort(a))} due ${d === 0 ? 'today' : d < 0 ? `${-d} days ago` : `in ${d} days`}</div>
      <div class="s">${fmtDate(a.statement.dueDate, true)} · minimum ${inr(a.statement.minDue, 0)}</div></div>
      <div class="a num ${d <= 3 ? 'bad' : ''}">${inr(a.statement.totalDue, 0)}</div></button>`; }).join('')}
  ${D.settings.ai?.model ? `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="openAsk"><div class="ico">AI</div><div class="grow"><div class="t">Ask Ledger</div><div class="s">“How much on Swiggy since July?”</div></div><div class="muted">›</div></button>` : ''}
  ${D.inbox.length ? `<button class="card item" style="border-radius:var(--r);margin-bottom:14px;border:0" data-act="tab" data-tab="import"><div class="grow"><div class="t">${D.inbox.length} SMS need attention</div><div class="s">Assign an account or enter them by hand</div></div><div class="muted">›</div></button>` : ''}
  ${backupOld ? `<div class="card row"><div class="grow small">No backup in the last 30 days. If this app is deleted, its data goes with it.</div><button class="btn ghost" data-act="backup">Back up</button></div>` : ''}
  <div class="card"><h2>Spent in ${monthLabel(ym)}</h2>
    <div class="row"><div class="grow"><div class="mid num">${inr(s.spend, 0)}</div>
      <div class="small muted">${prev.spend ? `${s.spend > prev.spend ? '▲' : '▼'} ${inr(Math.abs(s.spend - prev.spend), 0)} vs last month` : ''}</div></div>
      ${s.income ? `<div style="text-align:right"><div class="small muted">Income</div><div class="in num">${inr(s.income, 0)}</div></div>` : ''}</div>
    <div class="cols">${months.map((x) => `<div class="${x.y === ym ? 'now' : ''}"><i style="height:${Math.max(3, (x.v / maxV) * 70)}px"></i><span>${MON[+x.y.slice(5) - 1]}</span></div>`).join('')}</div>
    ${s.uncategorised ? `<p class="small" style="margin:12px 0 0"><button class="link" data-act="showUncat">${s.uncategorised} transactions need a category ›</button></p>` : ''}
  </div>
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
    if (ui.cat === '_none' ? x.categoryId : ui.cat && x.categoryId !== ui.cat) return false;
    if (q && !`${x.payee} ${x.description} ${x.notes || ''} ${catName(x.categoryId)} ${(x.amount / 100).toFixed(2)}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
}
function renderTx(m) {
  setTop('Activity', { action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="transferSheet">⇄</button><button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="addTx">+ Add</button>` });
  ui.month ||= ymOf(todayIso());
  m.innerHTML = `
    <input class="search" id="q" type="search" placeholder="Search all transactions" value="${esc(ui.q)}" autocomplete="off">
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
  if (!list.length) { $('#txList').innerHTML = `<div class="empty">No transactions here.</div>`; return; }
  let out = 0, inn = 0;
  for (const x of list) { const k = catById(x.categoryId)?.kind; if (k === 'transfer') continue; if (x.amount < 0) out -= x.amount; else inn += x.amount; }
  let h = `<div class="small muted" style="margin:0 4px 4px">${list.length} transactions · out ${inr(out, 0)} · in ${inr(inn, 0)} <span class="tiny">(excl. transfers)</span></div>`;
  const byDay = {};
  for (const x of list) (byDay[x.date] ||= []).push(x);
  for (const [d, xs] of Object.entries(byDay)) {
    h += `<div class="day"><span>${fmtDate(d, ui.q)}</span><span class="num">${inr(xs.reduce((s, x) => s + x.amount, 0), 0)}</span></div><div class="list">${xs.map((x) => txItem(x, !ui.acc)).join('')}</div>`;
  }
  $('#txList').innerHTML = h;
}

function renderAccounts(m) {
  setTop('Accounts', { action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="addAccount">+ Add</button>` });
  if (!D.accounts.length) { m.innerHTML = `<div class="empty">No accounts yet.<br><br><button class="btn" data-act="addAccount">Add an account</button></div>`; return; }
  const nw = netWorth();
  const groups = {};
  for (const a of D.accounts.filter((a) => !a.archived)) (groups[typeOf(a.type).group] ||= []).push(a);
  const order = [...new Set(ACCOUNT_TYPES.map((t) => t.group))];
  m.innerHTML = `<div class="card"><h2>Net worth</h2><div class="big num">${inr(nw.net, 0)}</div></div>` +
    order.filter((g) => groups[g]).map((g) => {
      const total = groups[g].reduce((s, a) => s + balance(a) - unbilledEmi(a), 0);
      return `<div class="day"><span>${g}</span><span class="num">${inr(total, 0)}</span></div><div class="list">${groups[g].map((a) => {
        const b = balance(a), emi = unbilledEmi(a);
        return `<button class="item" data-act="openAccount" data-id="${a.id}"><div class="ico">${esc(initials(a.institution || a.name))}</div>
        <div class="grow"><div class="t">${esc(a.name)}</div><div class="s">${esc([a.institution, a.last4 ? '••' + a.last4 : '', typeOf(a.type).label].filter(Boolean).join(' · '))}</div></div>
        <div style="text-align:right"><div class="a num">${inr(b, 0)}</div>${emi ? `<div class="tiny muted num">+ ${inr(emi, 0)} EMI</div>` : ''}</div></button>`;
      }).join('')}</div>`;
    }).join('') +
    (D.accounts.some((a) => a.archived) ? `<p class="small muted center">Archived: ${D.accounts.filter((a) => a.archived).map((a) => `<button class="link" data-act="openAccount" data-id="${a.id}">${esc(a.name)}</button>`).join(', ')}</p>` : '');
}

function renderAccount(m, id) {
  const a = accById(id);
  if (!a) { ui.view = null; return render(); }
  const t = typeOf(a.type);
  setTop(a.name, { back: 'closeView', action: `<button class="link" data-act="editAccount" data-id="${a.id}">Edit</button>` });
  const b = balance(a);
  const txs = D.transactions.filter((x) => x.accountId === a.id).sort((p, q) => q.date.localeCompare(p.date) || (q.time || '').localeCompare(p.time || ''));
  let h = `<div class="card"><h2>${esc(t.label)}${a.last4 ? ' ••' + a.last4 : ''}</h2><div class="big num">${inr(b)}</div>`;
  if (t.mode === 'value') {
    const v = latestValuation(a.id);
    h += `<div class="small muted">${v ? `Value as on ${fmtDate(v.date, true)}` : 'No value entered yet'}</div><div style="margin-top:12px"><button class="btn" data-act="addValuation" data-id="${a.id}">Update value</button></div>`;
  }
  if (t.mode === 'ledger') h += `<div class="small muted">${a.balanceSetAt ? `You confirmed this balance on ${fmtDate(a.balanceSetAt, true)}` : a.statement?.periodTo ? `From statements up to ${fmtDate(a.statement.periodTo, true)}, plus later entries` : ''}</div>
    <div class="row" style="margin-top:12px"><button class="btn" style="flex:1" data-act="setBalance" data-id="${a.id}">Update balance</button><button class="btn ghost" style="flex:1" data-act="transferSheet" data-from="${a.id}">Transfer</button></div>`;
  h += `</div>`;
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
    <p class="small muted">Pick one or several PDFs or CSVs at once. Ledger recognises each one and sets up the accounts for you. Works now: HDFC credit cards, DNS Bank savings, any bank CSV. More banks and investment statements are coming. Password-protected files are fine.</p>
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
  if (P.detectHdfcCard(text)) {
    const parsed = P.parseHdfcCard(pages);
    const match = D.accounts.find((a) => a.type === 'credit_card' && !a.archived && a.last4 && a.last4 === parsed.statement.cardLast4);
    return { imp: { kind: 'card', fileName: file.name, parsed, accountId: match?.id || '_new', newName: `HDFC ${parsed.statement.product || 'Credit Card'}`, newType: 'credit_card', rows: [] }, pw: opened.pw };
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
  let src;
  if (imp.kind === 'card' || imp.kind === 'bankpdf') src = imp.parsed.transactions;
  else { const r = P.csvToTransactions(imp.csvRows, imp.map); src = r.transactions; imp.warnings = r.warnings; }
  const acc = imp.accountId;
  const existing = new Set(D.transactions.filter((x) => x.accountId === acc).map((x) => x.hash));
  const smsPool = D.transactions.filter((x) => x.accountId === acc && (x.source === 'sms' || x.source === 'transfer' || x.source === 'emi'));
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
function draftKey(imp) { return imp.kind === 'card' ? 'card:' + imp.parsed.statement.cardLast4 : imp.kind === 'bankpdf' ? 'bank:' + imp.parsed.statement.bank + ':' + imp.parsed.statement.last4 : 'csv:' + imp.fileName; }
// Imports one draft. Returns { acc, added, upgraded } (throws on a problem the user must fix).
function commitDraft(imp, createdInBatch = {}) {
  let acc = accById(imp.accountId);
  if (!acc && createdInBatch[draftKey(imp)]) acc = createdInBatch[draftKey(imp)];
  if (!acc) {
    const name = (imp.newName || '').trim();
    if (!name) throw new Error(`Give the new account for ${imp.fileName} a name.`);
    const now = new Date().toISOString();
    if (imp.kind === 'card') acc = { id: uid(), name, type: 'credit_card', institution: imp.parsed.institution, last4: imp.parsed.statement.cardLast4 || '', currency: 'INR', createdAt: now };
    else if (imp.kind === 'bankpdf') { const st = imp.parsed.statement; acc = { id: uid(), name, type: imp.newType || 'savings', institution: st.bank || '', last4: st.last4 || '', currency: 'INR', createdAt: now, opening: { amount: st.openingBalance || 0, date: st.periodFrom || imp.rows[0]?.date || todayIso(), source: 'statement' } }; }
    else acc = { id: uid(), name, type: imp.newType || 'savings', institution: '', last4: '', currency: 'INR', createdAt: now, opening: csvOpening(imp) };
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
function commitBatch() {
  const created = {}; let added = 0, upgraded = 0; const accs = new Set();
  // oldest statements first, so opening balances come from the earliest one
  const list = [...ui.batch].sort((a, b) => (a.parsed?.statement?.periodFrom || '').localeCompare(b.parsed?.statement?.periodFrom || ''));
  try {
    for (const imp of list) { const r = commitDraft(imp, created); added += r.added; upgraded += r.upgraded; accs.add(r.acc.id); }
  } catch (e) { save(); toast(e.message, 4000); return; }
  const tm = matchTransfers();
  save();
  ui.batch = null; ui.imp = null;
  toast(`${added} transactions added${upgraded ? `, ${upgraded} earlier entries confirmed` : ''}${tm ? `, ${tm} transfers matched` : ''}`, 3500);
  if (accs.size === 1) { ui.tab = 'accounts'; ui.view = { page: 'account', id: [...accs][0] }; } else { ui.tab = 'accounts'; ui.view = null; }
  render();
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
    const acc = accById(imp.accountId);
    const key = draftKey(imp); const willReuse = !acc && created.has(key); if (!acc) created.add(key);
    const inc = imp.rows.filter((r) => r.include).length, dups = imp.rows.filter((r) => r.dup).length, sms = imp.rows.filter((r) => r.smsMatch).length;
    const st = imp.parsed?.statement;
    const title = imp.kind === 'card' ? `Credit card ••${st.cardLast4}` : imp.kind === 'bankpdf' ? `${st.bank} ${st.accountType} ••${st.last4}` : imp.fileName;
    const what = imp.kind === 'card' ? `${inr(st.totalDue, 0)} due ${fmtDate(st.dueDate)}` : imp.kind === 'bankpdf' ? `Balance ${inr(st.closingBalance, 0)}` : `${imp.rows.length} rows`;
    const ok = imp.parsed?.recon?.ok;
    h += `<div class="card"><div class="row"><div class="grow"><div class="t" style="font-weight:600">${esc(title)}</div><div class="small muted">${esc(imp.fileName)}${st?.periodFrom ? ` · ${fmtDate(st.periodFrom)} to ${fmtDate(st.periodTo, true)}` : ''}</div></div><div class="num" style="font-weight:600">${what}</div></div>
      <p class="small" style="margin:10px 0 6px">${acc ? `Adds to <b>${esc(accShort(acc))}</b>` : willReuse ? `Adds to the new account above` : `<b>Creates a new account</b>${st?.last4 || st?.cardLast4 ? ' ••' + esc(st.last4 || st.cardLast4) : ''}:`}</p>
      ${!acc && !willReuse ? `<input class="i" data-newname="${i}" value="${esc(imp.newName)}" placeholder="Account name, e.g. HDFC Savings" style="margin-bottom:8px">${imp.kind === 'csv' ? `<select class="i" data-newtype="${i}" style="margin-bottom:8px">${ACCOUNT_TYPES.filter((t) => t.mode === 'ledger' && t.id !== 'credit_card').map((t) => `<option value="${t.id}" ${imp.newType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>` : ''}` : ''}
      <p class="small muted" style="margin:0 0 8px">${inc} new transactions${dups ? ` · ${dups} already imported` : ''}${sms ? ` · ${sms} confirm earlier entries` : ''} ${ok ? '· <span class="in">totals check out</span>' : ok === false ? '· <span class="warn">totals off</span>' : ''}</p>
      ${(imp.loans || []).map((l, j) => `<label class="row small" style="margin:6px 0"><input type="checkbox" class="chk" data-loan="${i}:${j}" ${l.create ? 'checked' : ''}><span>Payments go to loan account ••${esc(l.no.slice(-4))}. Add it as a home loan?</span></label>
        ${l.create ? `<input class="i num" data-loan-amt="${i}:${j}" inputmode="decimal" placeholder="Outstanding today (₹), optional" value="${esc(l.outstanding)}" style="margin-bottom:6px">` : ''}`).join('')}
      <div class="row"><button class="chip" data-act="batchOpen" data-i="${i}">Review rows / change account</button><button class="chip" data-act="batchDrop" data-i="${i}">Remove</button></div></div>`;
  });
  h += `<button class="btn wide" data-act="commitBatch">Confirm and import</button><div style="height:10px"></div><button class="btn wide ghost" data-act="pickFile" data-kind="any">Add more files</button><div style="height:10px"></div><button class="btn wide ghost" data-act="cancelImport">Cancel</button>`;
  m.innerHTML = h;
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
    <label class="f"><span>Notes</span><textarea class="i" name="notes">${esc(x.notes)}</textarea></label>
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
  <div class="day"><span>Security</span></div>
  <div class="list">
    <button class="item" data-act="toggleFaceId"><div class="grow">Face ID unlock</div><div class="muted">${vault.hasPasskey ? 'On' : 'Off'} ›</div></button>
    <button class="item" data-act="changePass"><div class="grow">Change recovery passphrase</div><div class="muted">›</div></button>
    <label class="item"><div class="grow">Auto-lock after</div><select id="autoLock" class="chip">${[1, 5, 15, 60].map((n) => `<option value="${n}" ${D.settings.autoLockMin === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></label>
    <button class="item" data-act="lockNow"><div class="grow">Lock now</div></button>
  </div>
  <div class="day"><span>Your data</span></div>
  <div class="list">
    <button class="item" data-act="backup"><div class="grow">Back up (encrypted file)<div class="s">${D.settings.lastBackupAt ? 'Last: ' + fmtDate(D.settings.lastBackupAt.slice(0, 10), true) : 'Never backed up'}</div></div><div class="muted">›</div></button>
    <button class="item" data-act="restorePick"><div class="grow">Restore from backup</div><div class="muted">›</div></button>
    <button class="item" data-act="pwSheet"><div class="grow">Saved statement passwords</div><div class="muted">${(D.settings.pdfPasswords || []).length} ›</div></button>
    <button class="item" data-act="exportCsv"><div class="grow">Export transactions (CSV)</div><div class="muted">›</div></button>
    <div class="item"><div class="grow">Storage<div class="s" id="storageInfo">Checking…</div></div></div>
  </div>
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
  <button class="btn wide danger" data-act="eraseAll">Erase everything on this phone</button>`;
  $('#autoLock').addEventListener('change', (e) => { D.settings.autoLockMin = +e.target.value; save(); });
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

async function doBackup() {
  const b = await vault.exportBackup();
  const name = `ledger-backup-${todayIso()}.json`;
  const file = new File([JSON.stringify(b)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Ledger backup' }); }
    else { const u = URL.createObjectURL(file); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); }
    D.settings.lastBackupAt = new Date().toISOString(); save(); toast('Backup created. Keep it in iCloud Drive or Files.'); render();
  } catch (e) { if (e.name !== 'AbortError') toast('Backup was not saved.'); }
}
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
  const c = categorize(t, D.rules);
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
async function handleInbox(text, source) {
  const items = splitInbox(text);
  if (!items.length) {
    const blank = (String(text).match(/===SMS===/g) || []).length;
    openSheet(`<h3>No messages yet</h3>${blank ? `<p>The file has ${blank} entr${blank > 1 ? 'ies' : 'y'} with a date but no message text. That's what a test run with ▶ writes, so it's expected until a real bank SMS arrives.</p><p class="small muted">If a real HDFC or DNS SMS has arrived since and it still says this, the Shortcut isn't passing the message: in the Text block, tap Shortcut Input and choose the message content.</p>` : '<p>The file is empty.</p>'}<button class="btn wide" data-act="closeSheet">OK</button>`);
    return;
  }
  const seen = new Set(D.smsSeen.map((s) => s.h));
  const res = { added: 0, known: 0, skipped: 0, attention: 0, old: 0, reasons: {} };
  for (const it of items) {
    const h = smsHash(it.text);
    if (seen.has(h)) { res.old++; continue; }
    seen.add(h); D.smsSeen.push({ h, at: Date.now() });
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
    <p><b>${res.added}</b> new transactions added${res.known ? `, ${res.known} already on a statement` : ''}${tm ? `, ${tm} transfers matched` : ''}.</p>
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
  let left = P, int = 0, k = 0; while (left > Math.max(100, L.emi * 0.005) && k++ < 600) { const i = Math.round(left * r); int += i; left -= Math.min(L.emi, left + i) - i; }
  const payoff = L.nextDue ? (() => { let d = L.nextDue; for (let j = 1; j < k; j++) d = nextDateOnDay(L.day, d); return d; })() : null;
  const from = L.paidFrom ? accById(L.paidFrom) : null;
  return `<div class="card"><h2>EMI</h2>
    <div class="split"><div><div class="small muted">Monthly EMI</div><div class="mid num">${inr(L.emi, 0)}</div></div><div><div class="small muted">EMIs left</div><div class="mid">${k}</div></div></div>
    <p class="small" style="margin:10px 0 0">${L.nextDue ? `Next on <b>${fmtDate(L.nextDue, true)}</b>` : 'Fully repaid'} · ${L.rate ? `${(+L.rate).toFixed(2)}% a year` : 'no-cost (0%)'} · paid from ${from ? esc(accShort(from)) : 'outside Ledger'}</p>
    ${payoff ? `<p class="small muted" style="margin:6px 0 0">Ends ${fmtDate(payoff, true)}${int ? ` · ${inr(int, 0)} interest still to pay` : ''}</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn ghost" style="flex:1" data-act="editAccount" data-id="${a.id}">Edit EMI</button><button class="btn ghost" style="flex:1" data-act="prepaySheet" data-id="${a.id}">Prepay</button></div></div>`;
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
  const model = D.settings.ai?.model;
  if (!model) { m.innerHTML = `<div class="card"><p>Ask Ledger needs the on-device model. It downloads once and then works offline.</p><button class="btn wide" data-act="aiSetup">Set up</button></div>`; return; }
  const ex = ['How much did I spend on Swiggy since July?', 'Top categories last month', 'Show my Amazon orders', 'Spending by month this FY', 'What is my net worth?'];
  m.innerHTML = `<form data-form="ask" class="row" style="margin-bottom:10px"><input class="i" name="q" placeholder="Ask about your money" autocomplete="off" enterkeyhint="send" required><button class="btn">Ask</button></form>
  <div class="chips">${ex.map((q) => `<button class="chip" data-act="askEx" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
  <div class="small muted" id="aiStatus" style="margin:0 4px 10px">${esc(ui.aiStatus)}</div>
  ${ui.ask.map((a) => `<div class="card"><div class="small muted" style="margin-bottom:6px">${esc(a.q)}</div>${a.html}</div>`).join('') ||
    '<p class="small muted" style="margin:0 4px">Answers are calculated from your data on this phone. The AI only works out what you are asking for, so the numbers are exact. The first question takes a few seconds while the model loads.</p>'}`;
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
    case 'unsupported': return `<p>I can only answer questions about your transactions, accounts and net worth.</p>`;
    case 'net_worth': { const nw = netWorth(); return `<div class="mid num">${inr(nw.net, 0)}</div><p class="small muted">Assets ${inr(nw.assets, 0)} · liabilities ${inr(nw.liabilities, 0)}</p>`; }
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
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  try {
    await ensureModel();
    setAiStatus('Thinking…');
    const cats = D.categories.map((c) => ({ id: c.id, name: c.name }));
    const plan = await AI.askJSON(AI.queryPrompt({ today: todayIso(), categories: cats, accounts: D.accounts.map((a) => accShort(a)) }), q, AI.querySchema(cats.map((c) => c.id)), 160);
    ui.ask.unshift({ q, html: runQuery(plan), plan });
  } catch (e) { console.error(e); ui.ask.unshift({ q, html: `<p class="bad">${esc(e?.message || String(e) || 'Something went wrong')}</p>${/memory|device lost|out of/i.test(String(e?.message)) ? '<p class="small">The phone ran out of memory for this model. Try the smaller Llama model in More → Ask Ledger.</p>' : ''}` }); }
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
  if (processEmis()) save();
  hideLock(); render();
  requestPersistence().then(() => storageInfo());
}
function lockApp() { if (!D) return; AI.unload(); vault.saveNow().finally(() => { vault.lock(); D = null; ui.imp = null; ui.ask = []; $('#main').innerHTML = ''; renderUnlock(); }); }

document.addEventListener('visibilitychange', () => {
  if (!D) return;
  if (document.hidden) { hiddenAt = Date.now(); vault.saveNow(); }
  else if (hiddenAt && Date.now() - hiddenAt > (D.settings.autoLockMin || 5) * 60000) lockApp();
});

// ---------- events ----------
const acts = {
  tab: (d) => { ui.tab = d.tab; ui.view = null; if (d.tab !== 'tx') { ui.acc = ''; ui.cat = ''; ui.src = ''; } render(); window.scrollTo(0, 0); },
  closeSheet, closeView: () => { ui.view = null; render(); },
  month: (d) => { ui.month = addMonths(ui.month, +d.d); render(); },
  showUncat: () => { ui.tab = 'tx'; ui.cat = '_none'; ui.month = ymOf(todayIso()); ui.view = null; render(); },
  showCat: (d) => { ui.tab = 'tx'; ui.cat = d.id; ui.month = ymOf(todayIso()); ui.view = null; render(); },
  editTx: (d) => txSheet(D.transactions.find((x) => x.id === d.id)),
  addTx: (d) => txSheet(null, d.acc || ui.view?.id),
  deleteTx: (d) => { if (!confirm('Delete this transaction?')) return; D.transactions = D.transactions.filter((x) => x.id !== d.id); save(); closeSheet(); render(); },
  openAccount: (d) => { ui.tab = 'accounts'; ui.view = { page: 'account', id: d.id }; render(); window.scrollTo(0, 0); },
  addAccount: () => accountSheet(null),
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
  pickFile: (d) => { const f = $('#file'); f.dataset.kind = d.kind; f.multiple = d.kind === 'any'; f.accept = d.kind === 'pdf' ? 'application/pdf,.pdf' : d.kind === 'inbox' ? 'text/plain,.txt' : d.kind === 'any' ? 'application/pdf,.pdf,text/csv,.csv' : 'text/csv,.csv,text/plain,.txt'; f.value = ''; f.click(); },
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
    const a = accById(i.accountId);
    if (a?.statement && i.statement && a.statement.statementDate === i.statement.statementDate) {
      const prev = D.imports.filter((x) => x.accountId === a.id && x.statement).sort((p, q) => q.statement.statementDate.localeCompare(p.statement.statementDate))[0];
      a.statement = prev ? { ...prev.statement } : null; a.statementBalanceCheck = null;
    }
    save(); render();
  },
  backup: doBackup, exportCsv,
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
  pasteSms: () => openSheet(`<h3>Paste an SMS</h3><form data-form="pasteSms"><textarea class="i" name="t" rows="7" placeholder="Txn Rs.198.00 On HDFC Bank Card 9550 …" required></textarea><div style="height:10px"></div><button class="btn wide">Add</button></form>`),
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
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = acts[el.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(el.dataset, el);
});

const forms = {
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
  addUpi: (f) => { markUpi(f.get('h').trim(), true); acts.myUpiSheet(); },
  ask: async (f, form) => { const q = f.get('q'); form.reset(); await ask(q); },
  tx: (f, form) => {
    const amt = parseRupees(f.get('amount')); if (amt == null || amt === 0) return toast('Enter an amount.');
    const signed = f.get('dir') === 'in' ? Math.abs(amt) : -Math.abs(amt);
    const id = form.dataset.id;
    const vals = { payee: f.get('payee').trim(), amount: signed, categoryId: f.get('categoryId') || null, date: f.get('date'), accountId: f.get('accountId'), notes: f.get('notes').trim() };
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
async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Update ready: close and reopen the app', 5000); });
      });
    }).catch(() => {});
  }
  try {
    if (await vault.exists()) renderUnlock(); else renderSetup();
  } catch (e) {
    showLock(`<h1>Storage unavailable</h1><p class="lead">This browser is blocking on-device storage (Private Browsing does this). Open the app normally or from the Home Screen.</p>`);
  }
}
boot();

// Exposed for automated tests only
window.__ledger = { get data() { return D; }, vault, ui, render, runQuery, handleInbox, matchTransfers, AI };
