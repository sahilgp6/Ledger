// Statement parsers. Pure functions: they take positioned text items and return
// { kind, institution, account, statement, transactions, warnings }.
// Amounts are integer paise. Negative = money out of the account (spend), positive = money in.

export const toPaise = (s) => {
  const n = String(s).replace(/[₹,\s]/g, '').replace(/^C/, '');
  if (!/^-?\d+(\.\d+)?$/.test(n)) return null;
  return Math.round(parseFloat(n) * 100);
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
export const dmyToIso = (d) => {
  let m = d.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  m = d.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[a-z]*[,\s\-]+(\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const mo = MONTHS[m[2].toLowerCase()]; if (mo) return `${y}-${pad(mo)}-${pad(m[1])}`; }
  return null;
};

// Group positioned items into lines (same baseline, within tolerance), sorted left to right.
export function toLines(pages) {
  const out = [];
  pages.forEach((items, pi) => {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      let row = rows.find((r) => Math.abs(r.y - it.y) < 2.5);
      if (!row) { row = { y: it.y, page: pi + 1, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y);
    rows.forEach((r) => { r.items.sort((a, b) => a.x - b.x); r.text = r.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(); });
    out.push(...rows);
  });
  return out;
}

// ---------- HDFC Bank credit card (new-format statements, e.g. Tata Neu, Regalia, Millennia) ----------
export function detectHdfcCard(text) {
  return /HDFC Bank Credit Card/i.test(text) && /DATE & TIME/.test(text) && /TRANSACTION DESCRIPTION/.test(text);
}

export function parseHdfcCard(pages) {
  const lines = toLines(pages);
  const full = lines.map((l) => l.text).join('\n');
  const warnings = [];
  const money = (re) => { const m = full.match(re); return m ? toPaise(m[1]) : null; };

  // Header fields are laid out in boxes, so read them by position: the value sits under (or right of) its label.
  // The rupee sign is rendered as a "C" glyph in a symbol font, so it is dropped.
  const statement = {};
  const allItems = lines.flatMap((l) => l.items.map((it) => ({ ...it, page: l.page })));
  const findLabel = (label) => allItems.find((it) => it.str.trim() === label);
  const below = (label, re) => {
    const lab = findLabel(label); if (!lab) return null;
    const cands = allItems.filter((it) => it.page === lab.page && it.y < lab.y - 2 && it.y > lab.y - 45 && it.x >= lab.x - 12 && it.x <= lab.x + 45 && re.test(it.str.trim()));
    cands.sort((a, b) => b.y - a.y || a.x - b.x);
    return cands[0]?.str.trim() ?? null;
  };
  const rightOf = (label, re) => {
    const lab = findLabel(label); if (!lab) return null;
    const c = allItems.filter((it) => it.page === lab.page && Math.abs(it.y - lab.y) < 2.5 && it.x > lab.x && re.test(it.str.trim())).sort((a, b) => a.x - b.x);
    return c[0]?.str.trim() ?? null;
  };
  const MONEY = /^[\d,]+(\.\d{2})?$/, DATE = /^\d{1,2} [A-Z][a-z]{2}, \d{4}/;
  statement.totalDue = toPaise(below('TOTAL AMOUNT DUE', MONEY) || '');
  statement.minDue = toPaise(below('MINIMUM DUE', MONEY) || '');
  statement.dueDate = dmyToIso(below('DUE DATE', DATE) || '');
  statement.previousDues = toPaise(below('PREVIOUS STATEMENT DUES', MONEY) || '');
  statement.credits = toPaise(below('PAYMENTS/CREDITS', MONEY) || '');
  statement.debits = toPaise(below('PURCHASES/DEBIT', MONEY) || '');
  statement.financeCharges = toPaise(below('FINANCE CHARGES', MONEY) || '');
  statement.creditLimit = toPaise(below('TOTAL CREDIT LIMIT', MONEY) || '');
  statement.availableLimit = toPaise(below('AVAILABLE CREDIT LIMIT', MONEY) || '');
  statement.statementDate = dmyToIso(rightOf('Statement Date', DATE) || '');
  const bp = rightOf('Billing Period', DATE);
  if (bp) { const m = bp.split(' - '); statement.periodFrom = dmyToIso(m[0]); statement.periodTo = dmyToIso(m[1] || ''); }
  const card = full.match(/\b(\d{6}X{6}(\d{4}))\b/);
  if (card) statement.cardLast4 = card[2];
  const prod = full.match(/([A-Za-z ]+?) HDFC Bank Credit Card Statement/);
  if (prod) statement.product = prod[1].trim();

  // Smart EMI loans
  statement.emiLoans = [];
  for (const l of lines) {
    const m = l.text.match(/^(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+C\s*([\d,]+\.\d{2})\s+(\d+) Months\s+([\d.]+)%\s+C\s*([\d,]+\.\d{2})\s+C\s*([\d,]+\.\d{2})\s+(\d+) Months?/);
    if (m) statement.emiLoans.push({ loanNo: m[1], booked: dmyToIso(m[2]), amount: toPaise(m[3]), tenure: +m[4], rate: +m[5], principalLeft: toPaise(m[6]), interestLeft: toPaise(m[7]), monthsLeft: +m[8] });
  }

  // Transactions
  const transactions = [];
  let section = 'Domestic';
  for (const l of lines) {
    if (/^International Transactions/i.test(l.text)) section = 'International';
    if (/^Domestic Transactions/i.test(l.text)) section = 'Domestic';
    const first = l.items[0];
    const dm = first.str.match(/^(\d{2}\/\d{2}\/\d{4})\s*\|\s*(\d{2}:\d{2})/);
    if (!dm) continue;
    // Locate the rupee glyph "C" followed by the amount: the last money item on the line
    let amtIdx = -1;
    for (let i = l.items.length - 1; i > 0; i--) { if (/^[\d,]+\.\d{2}$/.test(l.items[i].str.trim())) { amtIdx = i; break; } }
    if (amtIdx < 0) { warnings.push(`Could not read amount: ${l.text}`); continue; }
    const amt = toPaise(l.items[amtIdx].str);
    const amtX = l.items[amtIdx].x;
    const descItems = [], mid = [];
    for (let i = 1; i < amtIdx; i++) {
      const it = l.items[i];
      if (it.str.trim() === 'C') continue;
      if (it.x < 400) descItems.push(it.str); else mid.push(it);
    }
    // A lone "+" sitting just left of the amount marks a credit. "+ 14" / "- 14" in the middle column are reward points.
    const isCredit = mid.some((it) => it.str.trim() === '+' && it.x > amtX - 30);
    const coinsItem = mid.find((it) => /^[+-]\s*\d+$/.test(it.str.trim()));
    let desc = descItems.join(' ').replace(/\s+/g, ' ').trim();
    // Older layouts sometimes glue the points into the description
    const ref = (desc.match(/\(Ref#\s*([^)]+)\)/) || [])[1];
    const clean = desc.replace(/\s*\(Ref#[^)]*\)/, '').replace(/\s+[+-]\s*\d+\s*$/, '').trim();
    transactions.push({
      date: dmyToIso(dm[1]), time: dm[2] === '00:00' ? null : dm[2],
      description: clean, raw: desc, ref: ref || null,
      amount: isCredit ? amt : -amt,
      points: coinsItem ? parseInt(coinsItem.str.replace(/\s/g, ''), 10) : null,
      section,
    });
  }

  // Reconcile against the statement summary
  const sumCredits = transactions.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const sumDebits = transactions.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0);
  const recon = { sumCredits, sumDebits, ok: null };
  if (statement.credits != null && statement.debits != null) {
    // Small differences come from GST or charges billed on the statement date that HDFC carries to the next statement
    recon.creditDiff = sumCredits - statement.credits;
    recon.debitDiff = sumDebits - statement.debits;
    recon.ok = Math.abs(recon.creditDiff) <= 100 && Math.abs(recon.debitDiff) <= 100;
    if (!recon.ok) warnings.push('Totals differ from the statement summary. Review the rows before importing.');
  }
  return { kind: 'credit_card', institution: 'HDFC Bank', statement, transactions, recon, warnings };
}

// ---------- Generic CSV ----------
export function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((s) => s.trim())).filter((r) => r.some((s) => s !== ''));
}

// Guess the header row and columns for Indian bank CSV exports
export function guessCsvMapping(rows) {
  let hi = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /(narration|description|particulars|details|remarks)/i.test(c)));
  if (hi < 0) hi = 0;
  const h = rows[hi].map((c) => c.toLowerCase());
  const find = (re) => h.findIndex((c) => re.test(c));
  return {
    headerRow: hi,
    date: find(/^(txn |transaction |value )?date|date$/),
    description: find(/narration|description|particulars|details|remarks/),
    debit: find(/withdrawal|debit|dr\b|paid out/),
    credit: find(/deposit|credit|cr\b|paid in/),
    amount: find(/^amount|amount \(inr\)|amount$/),
    drcr: find(/^(dr\/cr|cr\/dr|type)$/),
    ref: find(/ref|chq|cheque/),
    balance: find(/balance/),
  };
}

export function csvToTransactions(rows, map) {
  const out = [], warnings = [];
  for (let i = map.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = dmyToIso(r[map.date] || '') || (/^\d{4}-\d{2}-\d{2}$/.test(r[map.date]) ? r[map.date] : null);
    if (!date) continue;
    let amount = null;
    if (map.debit >= 0 || map.credit >= 0) {
      const d = toPaise(r[map.debit] || '') || 0, c = toPaise(r[map.credit] || '') || 0;
      if (!d && !c) continue;
      amount = c - d;
    } else if (map.amount >= 0) {
      amount = toPaise(r[map.amount]);
      if (amount == null) continue;
      if (map.drcr >= 0) { const t = (r[map.drcr] || '').toLowerCase(); amount = Math.abs(amount) * (/^d/.test(t) ? -1 : 1); }
    }
    if (amount == null) { warnings.push(`Row ${i + 1} skipped`); continue; }
    const desc = (r[map.description] || '').replace(/\s+/g, ' ').trim();
    const bal = map.balance >= 0 ? toPaise(r[map.balance] || '') : null;
    out.push({ date, description: desc, raw: desc, ref: map.ref >= 0 ? r[map.ref] || null : null, amount, balance: bal });
  }
  return { transactions: out, warnings };
}

// ---------- Bank account statements (PDF), generic table reader ----------
// Works off the column headers (Withdrawal / Deposit / Balance) and uses the running balance
// to decide whether each row is money in or out, so odd layouts still come out right.
const BANKS = [
  { id: 'dns', name: 'DNS Bank', re: /dns\.bank\.in|DNS Bank|Dombivli Nagari/i },
  { id: 'hdfc', name: 'HDFC Bank', re: /HDFC BANK/i },
  { id: 'icici', name: 'ICICI Bank', re: /ICICI Bank/i },
  { id: 'sbi', name: 'SBI', re: /State Bank of India/i },
  { id: 'axis', name: 'Axis Bank', re: /Axis Bank/i },
  { id: 'kotak', name: 'Kotak Bank', re: /Kotak Mahindra/i },
];
const DATE_START = /^(\d{1,2}[-\/ ](?:[A-Za-z]{3}|\d{1,2})[-\/ ]\d{2,4})\b/;
const NUM = /^-?[\d,]+\.\d{2}$|^-?\d[\d,]*$/;

export function detectBankStatement(text) {
  const hasCols = /withdraw/i.test(text) && /deposit/i.test(text) && /balance/i.test(text);
  if (!hasCols || detectHdfcCard(text)) return null;
  return BANKS.find((b) => b.re.test(text)) || { id: 'other', name: '' };
}

export function parseBankPdf(pages) {
  const lines = toLines(pages);
  const full = lines.map((l) => l.text).join('\n');
  const bank = detectBankStatement(full) || { id: 'other', name: '' };
  const warnings = [];
  const statement = { bank: bank.name };
  const acct = full.match(/Account\s*(?:No|Number)\.?\s*:?\s*([0-9X*]{8,20})/i);
  if (acct) { statement.accountNo = acct[1]; statement.last4 = acct[1].slice(-4); }
  const per = full.match(/(?:Statement\s+Period|Period|From)\s*:?\s*(\d{1,2}[-\/][A-Za-z0-9]{2,3}[-\/]\d{2,4})\s*(?:TO|-)\s*(\d{1,2}[-\/][A-Za-z0-9]{2,3}[-\/]\d{2,4})/i);
  if (per) { statement.periodFrom = dmyToIso(per[1]); statement.periodTo = dmyToIso(per[2]); }
  if (/sav(ing|ings)? account|SB A\/c|savings/i.test(full)) statement.accountType = 'savings';
  else if (/current account/i.test(full)) statement.accountType = 'current';
  else statement.accountType = 'savings';

  // Header row: find the x position of each money column
  let hdrIdx = lines.findIndex((l) => /withdraw/i.test(l.text) && /deposit/i.test(l.text) && /balance/i.test(l.text));
  if (hdrIdx < 0) return { kind: 'bank', bank, statement, transactions: [], warnings: ['Could not find the table header'] };
  const hdr = lines[hdrIdx];
  const colX = (re) => { const it = hdr.items.find((i) => re.test(i.str)); return it ? it.x : null; };
  const cols = { w: colX(/withdraw|debit/i), d: colX(/deposit|credit/i), b: colX(/balance/i) };
  const narrX = colX(/narration|particulars|description|details/i) ?? 60;
  const dateX = hdr.items[0].x;
  const refX = colX(/ref|chq|cheque/i);
  const moneyLeft = Math.min(...[cols.w, cols.d].filter((v) => v != null)) - 12;

  const rows = [];
  let cur = null, opening = null;
  for (let i = hdrIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/end of statement|statement summary|closing balance/i.test(l.text) && !DATE_START.test(l.text)) { if (cur) rows.push(cur); cur = null; if (/end of statement/i.test(l.text)) break; continue; }
    if (/opening balance/i.test(l.text)) { const n = l.items.filter((it) => NUM.test(it.str.trim()) && it.x >= moneyLeft); if (n.length) opening = toPaise(n[n.length - 1].str); continue; }
    const first = l.items[0]?.str.trim() || '';
    const dm = first.match(DATE_START);
    if (dm && l.items[0].x < narrX - 5) {
      if (cur) rows.push(cur);
      const nums = l.items.filter((it) => it.x >= moneyLeft && NUM.test(it.str.trim()));
      const text = l.items.filter((it) => it !== l.items[0] && it.x < moneyLeft && !(refX != null && it.x >= refX - 4 && /^\d{6,}$/.test(it.str.trim()) && false)).map((it) => it.str).join(' ');
      cur = { date: dmyToIso(dm[1]), desc: [text.trim()], nums: nums.map((n) => ({ x: n.x, v: toPaise(n.str) })) };
    } else if (cur && l.page === cur.page || cur) {
      // continuation of the narration on the next line(s)
      if (l.items.every((it) => it.x < moneyLeft) && l.items[0].x > dateX + 25) cur.desc.push(l.text);
      else if (!dm) { if (cur) rows.push(cur); cur = null; }
    }
  }
  if (cur) rows.push(cur);

  // Resolve amount and direction from the running balance
  const transactions = [];
  let prev = opening;
  for (const r of rows) {
    if (!r.nums.length) continue;
    const bal = r.nums[r.nums.length - 1].v;
    const amtItem = r.nums.length >= 2 ? r.nums[r.nums.length - 2] : null;
    let amount = null;
    if (prev != null && amtItem) {
      const diff = bal - prev;
      if (Math.abs(Math.abs(diff) - amtItem.v) <= 1) amount = diff;
    }
    if (amount == null && amtItem) {
      // Fall back to which column the number sits under
      const dw = cols.w != null ? Math.abs(amtItem.x - cols.w) : 1e9, dd = cols.d != null ? Math.abs(amtItem.x - cols.d) : 1e9;
      amount = dd < dw ? amtItem.v : -amtItem.v;
      if (prev != null) warnings.push(`Balance did not add up on ${r.date}`);
    }
    if (amount == null) continue;
    const description = r.desc.join(' ').replace(/\s+/g, ' ').replace(/\|\|--/g, ' ').trim();
    transactions.push({ date: r.date, description, raw: description, ref: null, amount, balance: bal });
    prev = bal;
  }
  // Account holder (to spot transfers to yourself)
  const nameHdr = lines.findIndex((l) => /account/i.test(l.text) && /name/i.test(l.text) && /pan|ifsc|micr/i.test(l.text));
  if (nameHdr >= 0 && lines[nameHdr + 1]) {
    const nx = lines[nameHdr].items.find((i) => /name/i.test(i.str))?.x ?? 0;
    const cand = lines[nameHdr + 1].items.filter((i) => /^[A-Za-z .]{5,}$/.test(i.str.trim())).sort((a, b) => Math.abs(a.x - nx) - Math.abs(b.x - nx))[0];
    if (cand) statement.holder = cand.str.trim();
  }
  for (const t of transactions) {
    // DNS / co-op style: "UPI DR 581439612236 SAHIL SANJ CENTRAL OFFI"
    let m = t.description.match(/^UPI\s+(DR|CR)\s+(\d{9,})\s+(.+?)(?:\s+CENTRAL OFFI.*)?$/i);
    if (m) { t.ref = m[2]; t.counterparty = m[3].trim(); }
    m = t.description.match(/^(\d{10,})\s*-\s*(.+?)\s+Drawdown\s+From\s+CASA/i);
    if (m) { t.counterparty = `Loan account ••${m[1].slice(-4)}`; t.loanAccount = m[1]; }
    m = t.description.match(/^NEFT\s*(?:CR|DR)?-+([^|]+?)(?:\|\||-|\s{2}|$)/i);
    if (m) t.counterparty = m[1].trim();
    if (statement.holder && t.counterparty) {
      const hn = statement.holder.toUpperCase().split(/\s+/), cp = t.counterparty.toUpperCase().split(/\s+/);
      if (cp.length >= 2 && hn[0] === cp[0] && hn[1]?.startsWith(cp[1]) || cp.join(' ') === hn.slice().reverse().join(' ')) t.self = true;
    }
  }
  const closing = transactions.length ? transactions[transactions.length - 1].balance : opening;
  statement.openingBalance = opening ?? (transactions.length ? transactions[0].balance - transactions[0].amount : null);
  statement.closingBalance = closing;
  const sum = transactions.reduce((s, t) => s + t.amount, 0);
  const recon = { ok: statement.openingBalance != null ? Math.abs(statement.openingBalance + sum - closing) <= 1 : null };
  const summaryBal = full.match(/\bBalance\s+([\d,]+\.\d{2})/);
  if (summaryBal) { statement.summaryBalance = toPaise(summaryBal[1]); if (Math.abs(statement.summaryBalance - closing) > 1) { recon.ok = false; warnings.push('Closing balance does not match the summary'); } }
  if (!statement.periodTo && transactions.length) { statement.periodFrom = transactions[0].date; statement.periodTo = transactions[transactions.length - 1].date; }
  return { kind: 'bank', institution: bank.name, bank, statement, transactions, recon, warnings };
}

// ---------- Zerodha Console holdings (.xlsx) ----------
export function detectZerodhaHoldings(sheets) {
  return sheets.some((s) => s.rows.slice(0, 20).some((r) => r.some((c) => typeof c === 'string' && /Holdings Statement as on/i.test(c))))
    && sheets.some((s) => s.rows.some((r) => r.includes('ISIN') && r.includes('Average Price')));
}
export function parseZerodhaHoldings(sheets) {
  const out = { kind: 'holdings', institution: 'Zerodha', statement: {}, holdings: [], warnings: [] };
  const flat = (s) => s.rows.flatMap((r) => r.filter((c) => c != null));
  for (const s of sheets) {
    if (/combined/i.test(s.name)) continue; // same rows as Equity + Mutual Funds
    const all = flat(s);
    const ci = all.indexOf('Client ID'); if (ci >= 0 && all[ci + 1]) out.statement.clientId = String(all[ci + 1]);
    const asOn = all.find((c) => typeof c === 'string' && /as on (\d{4}-\d{2}-\d{2})/.test(c));
    if (asOn) out.statement.asOn = asOn.match(/(\d{4}-\d{2}-\d{2})/)[1];
    const hi = s.rows.findIndex((r) => r.includes('ISIN') && r.includes('Average Price'));
    if (hi < 0) continue;
    const h = s.rows[hi], col = (name) => h.findIndex((c) => typeof c === 'string' && c.toLowerCase() === name.toLowerCase());
    const c = { sym: col('Symbol'), isin: col('ISIN'), sector: col('Sector'), itype: col('Instrument Type'), qty: col('Quantity Available'), disc: col('Quantity Discrepant'), lt: col('Quantity Long Term'), pm: col('Quantity Pledged (Margin)'), pl: col('Quantity Pledged (Loan)'), avg: col('Average Price'), px: col('Previous Closing Price') };
    const isMf = /mutual/i.test(s.name);
    for (let i = hi + 1; i < s.rows.length; i++) {
      const r = s.rows[i]; if (!r || !r[c.sym]) continue;
      const qty = [c.qty, c.disc, c.pm, c.pl].reduce((t, k) => t + (k >= 0 ? Number(r[k]) || 0 : 0), 0);
      if (!qty) continue;
      const isin = String(r[c.isin] || '');
      const sector = c.sector >= 0 ? String(r[c.sector] || '') : '';
      out.holdings.push({
        symbol: String(r[c.sym]), isin, sector,
        type: isMf ? 'mf' : /ETF/i.test(sector) || /^INF/.test(isin) ? 'etf' : 'stock',
        qty, ltQty: c.lt >= 0 ? Number(r[c.lt]) || 0 : 0,
        avg: Number(r[c.avg]) || 0, price: Number(r[c.px]) || 0,
      });
    }
  }
  const inv = out.holdings.reduce((t, x) => t + x.qty * x.avg, 0), val = out.holdings.reduce((t, x) => t + x.qty * x.price, 0);
  out.statement.invested = Math.round(inv * 100); out.statement.value = Math.round(val * 100);
  // Check against Zerodha's own summary
  const eq = sheets.find((s) => /equity/i.test(s.name)), mf = sheets.find((s) => /mutual/i.test(s.name));
  const pv = (s) => { if (!s) return 0; const a = flat(s); const i = a.indexOf('Present Value'); return i >= 0 ? Number(a[i + 1]) || 0 : 0; };
  const reported = Math.round((pv(eq) + pv(mf)) * 100);
  out.recon = { ok: Math.abs(reported - out.statement.value) <= 100, reported };
  return out;
}

// ---------- Mutual fund distributor "Portfolio Summary" (Investwell-style PDF) ----------
export function detectMfSummary(text) {
  return /Portfolio Summary/i.test(text) && /Scheme with Folio/i.test(text) && /Current\s*Value/i.test(text);
}
export function parseMfSummary(pages) {
  const lines = toLines(pages);
  const full = lines.map((l) => l.text).join('\n');
  const st = {};
  const pan = full.match(/\b([A-Z]{5}\d{4}[A-Z])\b/); if (pan) st.pan = pan[1];
  const dist = lines[0]?.items.find((i) => /services|financial|wealth|capital|advis|investment/i.test(i.str));
  st.distributor = dist ? dist.str.trim() : '';
  const asOn = full.match(/till\s+(\d{2}-\d{2}-\d{4})/i) || full.match(/to\s+(\d{2}-\d{2}-\d{4})/i);
  if (asOn) st.asOn = dmyToIso(asOn[1]);
  const xirr = full.match(/XIRR\s+([\d.]+)\s*%/); if (xirr) st.xirr = +xirr[1];
  const holdings = [];
  const start = lines.findIndex((l) => /Scheme with Folio/i.test(l.text));
  const sipAt = lines.findIndex((l) => /^SIP Summary/i.test(l.text));
  let prevText = '', category = '';
  const NUMRE = /^-?[\d,]+(\.\d+)?$/;
  for (let i = start + 1; i > 0 && i < (sipAt > 0 ? sipAt : lines.length); i++) {
    const l = lines[i];
    if (/Total\s*:/i.test(l.text)) { prevText = ''; continue; }
    const dateIt = l.items.find((it) => /^\d{2}-\d{2}-\d{4}$/.test(it.str.trim()));
    if (!dateIt) {
      if (/\(PAN\s*:/i.test(l.text) || /^\[?\d+[\d/]*\]?$/.test(l.text) || /^(Amount|Value|Payout|Gain)\b/.test(l.text)) continue;
      if (/^[A-Za-z &-]+:\s*[A-Za-z &-]+$/.test(l.text) && !/\(G\)|fund/i.test(l.text)) { category = l.text; prevText = ''; continue; }
      prevText = l.text; continue;
    }
    const nums = l.items.filter((it) => it.x > dateIt.x && NUMRE.test(it.str.trim())).map((it) => parseFloat(it.str.replace(/,/g, '')));
    let name = l.items.filter((it) => it.x < dateIt.x).map((it) => it.str).join(' ').trim() || prevText;
    let folio = (name.match(/\[([\d/]+)\]/) || [])[1];
    const nextL = lines[i + 1]; if (!folio && nextL && /^\[[\d/]+\]$/.test(nextL.text)) folio = nextL.text.slice(1, -1);
    name = name.replace(/\s*\[[\d/]+\]\s*/, '').trim();
    if (nums.length < 4) continue;
    holdings.push({ symbol: name, name, folio: folio || '', category, type: 'mf', start: dmyToIso(dateIt.str.trim()), invested: Math.round(nums[0] * 100), cost: Math.round(nums[2] * 100), value: Math.round(nums[3] * 100), gain: nums[6] != null ? Math.round(nums[6] * 100) : null, xirr: nums[8] ?? null });
    prevText = '';
  }
  // SIPs: amount in the latest month column
  const sips = [];
  if (sipAt > 0) for (let i = sipAt + 1; i < lines.length; i++) {
    const l = lines[i]; if (/Grand Total/i.test(l.text)) break;
    const folioIt = l.items.find((it) => /^\d{6,}(\/\d+)?$/.test(it.str.trim()));
    if (!folioIt) continue;
    const name = l.items.filter((it) => it.x < folioIt.x).map((it) => it.str).join(' ').trim();
    const amts = l.items.filter((it) => it.x > folioIt.x && NUMRE.test(it.str.trim())).map((it) => Math.round(parseFloat(it.str.replace(/,/g, '')) * 100));
    if (amts.length) sips.push({ scheme: name, folio: folioIt.str.trim(), amount: amts[amts.length - 1] });
  }
  st.cost = holdings.reduce((t, h) => t + h.cost, 0); st.value = holdings.reduce((t, h) => t + h.value, 0);
  const gt = lines.find((l) => /^Grand Total/i.test(l.text) && l.page === lines[start]?.page);
  let reported = null;
  if (gt) { const n = gt.items.filter((it) => NUMRE.test(it.str.trim())).map((it) => parseFloat(it.str.replace(/,/g, ''))); if (n.length >= 4) reported = Math.round(n[3] * 100); }
  return { kind: 'mfsummary', institution: st.distributor, statement: st, holdings, sips, recon: { ok: reported != null ? Math.abs(reported - st.value) <= 100 : null, reported } };
}
