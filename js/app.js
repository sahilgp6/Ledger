import { Vault, passkeySupport, requestPersistence } from './store.js';
import * as P from './parsers.js';
import { ACCOUNT_TYPES, typeOf, DEFAULT_CATEGORIES, categorize, payeeFrom, squash } from './rules.js';

const APP_VERSION = '0.1.0';
const DATA_VERSION = 1;
const vault = new Vault();
let D = null; // decrypted data, in memory only while unlocked
const ui = { tab: 'home', view: null, month: null, q: '', acc: '', cat: '', imp: null };
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
    transactions: [], valuations: [], imports: [],
  };
}
function migrate(d) {
  // Future schema upgrades go here. Add any default categories that are missing.
  const have = new Set(d.categories.map((c) => c.id));
  for (const c of DEFAULT_CATEGORIES) if (!have.has(c.id)) d.categories.push({ ...c });
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
    if (c?.kind === 'transfer') continue;
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
  ({ home: renderHome, tx: renderTx, accounts: renderAccounts, import: renderImport, more: renderMore }[ui.tab])(m);
}

function txItem(x, showAcc = true) {
  const c = catById(x.categoryId);
  const a = accById(x.accountId);
  const sub = [c ? c.name : '<span class="warn">Uncategorised</span>', showAcc && a ? esc(accShort(a)) : ''].filter(Boolean).join(' · ');
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
    if (!q && !x.date.startsWith(ui.month)) return false;
    if (ui.acc && x.accountId !== ui.acc) return false;
    if (ui.cat === '_none' ? x.categoryId : ui.cat && x.categoryId !== ui.cat) return false;
    if (q && !`${x.payee} ${x.description} ${x.notes || ''} ${catName(x.categoryId)} ${(x.amount / 100).toFixed(2)}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
}
function renderTx(m) {
  setTop('Activity', { action: `<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-act="addTx">+ Add</button>` });
  ui.month ||= ymOf(todayIso());
  m.innerHTML = `
    <input class="search" id="q" type="search" placeholder="Search all transactions" value="${esc(ui.q)}" autocomplete="off">
    <div class="month ${ui.q ? 'hidden' : ''}"><button data-act="month" data-d="-1">‹</button><b>${monthLabel(ui.month)}</b><button data-act="month" data-d="1">›</button></div>
    <div class="chips">
      <select class="chip ${ui.acc ? 'on' : ''}" id="fAcc"><option value="">All accounts</option>${accOptions(ui.acc)}</select>
      <select class="chip ${ui.cat ? 'on' : ''}" id="fCat"><option value="">All categories</option><option value="_none" ${ui.cat === '_none' ? 'selected' : ''}>Uncategorised</option>${catOptions(ui.cat, { allowNone: false })}</select>
    </div>
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
  h += `</div>`;
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
  const imps = [...D.imports].sort((a, b) => b.at.localeCompare(a.at));
  m.innerHTML = `
  <div class="card"><h2>Add a statement</h2>
    <button class="btn wide" data-act="pickFile" data-kind="pdf">Credit card statement (PDF)</button>
    <p class="small muted">HDFC Bank cards work now. Password-protected PDFs are fine: you'll be asked for the password, and it is never saved.</p>
    <button class="btn wide ghost" data-act="pickFile" data-kind="csv">Bank statement (CSV)</button>
    <p class="small muted">Export from net banking as CSV (in HDFC choose "Delimited"). You'll match the columns once.</p>
  </div>
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
async function handlePdf(file, password) {
  let pages;
  try { pages = await readPdf(file, password); }
  catch (e) {
    if (e?.name === 'PasswordException') {
      openSheet(`<h3>PDF password</h3><p class="small muted">${password ? 'That password did not work. ' : ''}HDFC card statements usually use the first 4 letters of your name in capitals plus the last 4 digits of the card, or your date of birth. It's used once and not saved.</p>
        <form data-form="pdfPass"><input class="i" name="pw" type="password" autocomplete="off" autofocus><div style="height:12px"></div><button class="btn wide">Open</button></form>`);
      pendingFile = file;
      return;
    }
    console.error(e); toast('Could not read that PDF.'); return;
  }
  const text = P.toLines(pages).map((l) => l.text).join('\n');
  if (!P.detectHdfcCard(text)) {
    openSheet(`<h3>Format not supported yet</h3><p>This doesn't look like an HDFC credit card statement. Send a sample of this format to Claude and a parser can be added.</p><button class="btn wide ghost" data-act="closeSheet">OK</button>`);
    return;
  }
  const parsed = P.parseHdfcCard(pages);
  const match = D.accounts.find((a) => a.type === 'credit_card' && !a.archived && a.last4 && a.last4 === parsed.statement.cardLast4);
  ui.imp = { kind: 'card', fileName: file.name, parsed, accountId: match?.id || '_new', newName: `HDFC ${parsed.statement.product || 'Credit Card'}`, rows: [] };
  buildRows();
  ui.tab = 'import'; ui.view = null; $('#toast').classList.remove('on'); render();
}
let pendingFile = null;

async function handleCsv(file) {
  const text = await file.text();
  const rows = P.parseCSV(text);
  if (rows.length < 2) return toast('That file has no rows.');
  const map = P.guessCsvMapping(rows);
  ui.imp = { kind: 'csv', fileName: file.name, csvRows: rows, map, accountId: D.accounts.find((a) => ['savings', 'current'].includes(a.type))?.id || '_new', newName: '', newType: 'savings', rows: [] };
  buildRows();
  ui.tab = 'import'; ui.view = null; render();
}

function txHash(accountId, t, n) { return [accountId, t.date, t.amount, squash(t.raw || t.description), t.ref || '', n].join('|'); }

function buildRows() {
  const imp = ui.imp;
  let src;
  if (imp.kind === 'card') src = imp.parsed.transactions;
  else { const r = P.csvToTransactions(imp.csvRows, imp.map); src = r.transactions; imp.warnings = r.warnings; }
  const acc = imp.accountId;
  const existing = new Set(D.transactions.filter((x) => x.accountId === acc).map((x) => x.hash));
  const seen = new Map();
  imp.rows = src.map((t) => {
    const k = [t.date, t.amount, squash(t.raw || t.description), t.ref || ''].join('|');
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    const hash = txHash(acc, t, n);
    const payee = payeeFrom(t.description);
    const c = categorize({ ...t, payee, accountId: acc }, D.rules);
    const dup = existing.has(hash);
    return { ...t, hash, payee: c.payee || payee, categoryId: c.categoryId, include: !dup, dup };
  });
}

function renderImportPreview(m) {
  const imp = ui.imp;
  setTop('Review import', { back: 'cancelImport' });
  const isCard = imp.kind === 'card';
  const accFilter = isCard ? (a) => a.type === 'credit_card' : (a) => typeOf(a.type).mode === 'ledger' && a.type !== 'credit_card';
  const st = imp.parsed?.statement;
  const rec = imp.parsed?.recon;
  const inc = imp.rows.filter((r) => r.include);
  const dups = imp.rows.filter((r) => r.dup).length;
  let h = `<div class="card"><h2>${esc(imp.fileName)}</h2>`;
  if (isCard) {
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
      ${!isCard ? `<div style="height:10px"></div><select class="i" id="impNewType">${ACCOUNT_TYPES.filter((t) => t.mode === 'ledger' && t.id !== 'credit_card').map((t) => `<option value="${t.id}" ${imp.newType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>` : ''}` : ''}
  </div>
  <div class="row" style="margin:0 4px 8px"><div class="grow small muted">${inc.length} of ${imp.rows.length} selected${dups ? ` · ${dups} already imported` : ''}</div><button class="link" data-act="impAll">${inc.length === imp.rows.length ? 'Select none' : 'Select all'}</button></div>
  <div class="list">${imp.rows.map((r, i) => `<label class="item ${r.include ? '' : 'dup'}"><input type="checkbox" class="chk" data-imp="${i}" ${r.include ? 'checked' : ''}>
    <div class="grow"><div class="t">${esc(r.payee || r.description)}</div><div class="s">${fmtDate(r.date)} · ${r.categoryId ? esc(catName(r.categoryId)) : '<span class="warn">Uncategorised</span>'}${r.dup ? ' · already imported' : ''}</div></div>
    <div class="a num ${r.amount > 0 ? 'in' : ''}">${r.amount > 0 ? '+' : ''}${inr(r.amount)}</div></label>`).join('')}</div>
  ${imp.warnings?.length ? `<p class="small warn">${imp.warnings.slice(0, 5).map(esc).join('<br>')}</p>` : ''}
  <button class="btn wide" data-act="commitImport" ${inc.length || isCard ? '' : 'disabled'}>Import ${inc.length} transactions</button>
  <div style="height:10px"></div><button class="btn wide ghost" data-act="cancelImport">Cancel</button>`;
  m.innerHTML = h;
  $('#impAcc').addEventListener('change', (e) => { imp.accountId = e.target.value; buildRows(); render(); });
  $('#impNewName')?.addEventListener('input', (e) => { imp.newName = e.target.value; });
  $('#impNewType')?.addEventListener('change', (e) => { imp.newType = e.target.value; });
  m.querySelectorAll('[data-imp]').forEach((el) => el.addEventListener('change', () => { imp.rows[+el.dataset.imp].include = el.checked; render(); }));
  m.querySelectorAll('[data-map]').forEach((el) => el.addEventListener('change', () => { imp.map[el.dataset.map] = +el.value; buildRows(); render(); }));
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

function commitImport() {
  const imp = ui.imp;
  let acc = accById(imp.accountId);
  if (!acc) {
    const name = (imp.newName || '').trim();
    if (!name) return toast('Give the new account a name.');
    acc = imp.kind === 'card'
      ? { id: uid(), name, type: 'credit_card', institution: imp.parsed.institution, last4: imp.parsed.statement.cardLast4 || '', currency: 'INR', createdAt: new Date().toISOString() }
      : { id: uid(), name, type: imp.newType || 'savings', institution: '', last4: '', currency: 'INR', createdAt: new Date().toISOString(), opening: csvOpening(imp) };
    D.accounts.push(acc);
    // hashes were built against "_new"; rebuild against the real id
    imp.accountId = acc.id; const keep = imp.rows.map((r) => r.include); buildRows(); imp.rows.forEach((r, i) => { r.include = keep[i] && !r.dup; });
  }
  const importId = uid();
  const rows = imp.rows.filter((r) => r.include);
  for (const r of rows) {
    D.transactions.push({ id: uid(), accountId: acc.id, date: r.date, time: r.time || null, amount: r.amount, description: r.description, raw: r.raw || r.description, payee: r.payee, categoryId: r.categoryId, notes: '', ref: r.ref || null, importId, hash: r.hash, points: r.points ?? null });
  }
  const rec = { id: importId, accountId: acc.id, fileName: imp.fileName, kind: imp.kind, at: new Date().toISOString(), count: rows.length };
  if (imp.kind === 'card') {
    const st = imp.parsed.statement;
    rec.period = { from: st.periodFrom, to: st.periodTo };
    rec.statement = st;
    // Opening balance = what was owed before the earliest statement we have
    const otherTx = D.transactions.some((x) => x.accountId === acc.id && x.importId !== importId);
    const manualPlaceholder = acc.opening?.source === 'manual' && !otherTx && !acc.opening.amount;
    if (!acc.opening || manualPlaceholder || (acc.opening.source !== 'manual' && (!otherTx || st.periodFrom < acc.opening.date))) {
      acc.opening = { amount: -(st.previousDues || 0), date: st.periodFrom, source: 'statement' };
    }
    if (!acc.statement || st.statementDate >= acc.statement.statementDate) {
      acc.statement = { ...st, paid: false };
      // Check: our running balance up to the statement date vs what the bank says is due
      const bal = (acc.opening?.amount || 0) + D.transactions.filter((x) => x.accountId === acc.id && x.date <= st.periodTo).reduce((s, x) => s + x.amount, 0);
      const diff = -bal - st.totalDue;
      acc.statementBalanceCheck = { ok: Math.abs(diff) < 100, diff };
    }
  }
  D.imports.push(rec);
  save();
  ui.imp = null;
  toast(`Imported ${rows.length} transactions`);
  ui.tab = 'accounts'; ui.view = { page: 'account', id: acc.id }; render();
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
    ${x.raw ? `<p class="tiny muted">Bank text: ${esc(x.raw)}${x.points ? ` · ${x.points} reward points` : ''}</p>` : ''}
    <button class="btn wide">Save</button>
  </form>
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
      <label class="f"><span id="valLbl">${t.side === 'liability' ? 'Outstanding amount' : 'Current value'} (₹)</span><input class="i num" name="value" inputmode="decimal"></label>
    </div>
    <button class="btn wide">Save</button>
  </form>
  ${isNew ? '' : `<div style="height:10px"></div><button class="btn wide ghost" data-act="archiveAccount" data-id="${a.id}">${a.archived ? 'Unarchive' : 'Archive (hide)'}</button>
  <div style="height:10px"></div><button class="btn wide danger" data-act="deleteAccount" data-id="${a.id}">Delete account and its transactions</button>`}`);
  $('#accType').addEventListener('change', (e) => {
    const nt = typeOf(e.target.value);
    $('#accLedger').classList.toggle('hidden', nt.mode !== 'ledger');
    $('#accValue').classList.toggle('hidden', nt.mode !== 'value');
    $('#openLbl').textContent = (nt.id === 'credit_card' ? 'Amount owed on start date' : 'Balance on start date') + ' (₹)';
    $('#valLbl').textContent = (nt.side === 'liability' ? 'Outstanding amount' : 'Current value') + ' (₹)';
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
    <button class="item" data-act="exportCsv"><div class="grow">Export transactions (CSV)</div><div class="muted">›</div></button>
    <div class="item"><div class="grow">Storage<div class="s" id="storageInfo">Checking…</div></div></div>
  </div>
  <div class="day"><span>Categorising</span></div>
  <div class="list">
    <button class="item" data-act="manageCats"><div class="grow">Categories</div><div class="muted">${D.categories.length} ›</div></button>
    <button class="item" data-act="manageRules"><div class="grow">My rules</div><div class="muted">${userRules.length} ›</div></button>
  </div>
  <div class="day"><span>About</span></div>
  <div class="card small"><p style="margin-top:0"><b>Ledger ${APP_VERSION}</b>. Your data never leaves this phone. It is encrypted with a key unlocked by Face ID or your recovery passphrase. The only network requests are for loading the app itself.</p>
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
  hideLock(); render();
  requestPersistence().then(() => storageInfo());
}
function lockApp() { if (!D) return; vault.saveNow().finally(() => { vault.lock(); D = null; ui.imp = null; $('#main').innerHTML = ''; renderUnlock(); }); }

document.addEventListener('visibilitychange', () => {
  if (!D) return;
  if (document.hidden) { hiddenAt = Date.now(); vault.saveNow(); }
  else if (hiddenAt && Date.now() - hiddenAt > (D.settings.autoLockMin || 5) * 60000) lockApp();
});

// ---------- events ----------
const acts = {
  tab: (d) => { ui.tab = d.tab; ui.view = null; if (d.tab !== 'tx') { ui.acc = ''; ui.cat = ''; } render(); window.scrollTo(0, 0); },
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
  pickFile: (d) => { const f = $('#file'); f.accept = d.kind === 'pdf' ? 'application/pdf,.pdf' : 'text/csv,.csv,text/plain,.txt'; f.value = ''; f.click(); },
  cancelImport: () => { ui.imp = null; render(); },
  commitImport,
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
  pdfPass: (f) => { closeSheet(); handlePdf(pendingFile, f.get('pw')); },
  tx: (f, form) => {
    const amt = parseRupees(f.get('amount')); if (amt == null || amt === 0) return toast('Enter an amount.');
    const signed = f.get('dir') === 'in' ? Math.abs(amt) : -Math.abs(amt);
    const id = form.dataset.id;
    const vals = { payee: f.get('payee').trim(), amount: signed, categoryId: f.get('categoryId') || null, date: f.get('date'), accountId: f.get('accountId'), notes: f.get('notes').trim() };
    let x;
    if (id) { x = D.transactions.find((t) => t.id === id); Object.assign(x, vals); }
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
      if (v != null) D.valuations.push({ id: uid(), accountId: a.id, date: todayIso(), value: Math.abs(v), note: '', at: Date.now() });
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

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  toast('Reading ' + file.name + '…');
  try { if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') await handlePdf(file); else await handleCsv(file); }
  catch (err) { console.error(err); toast('Could not read that file.'); }
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
window.__ledger = { get data() { return D; }, vault, ui, render };
