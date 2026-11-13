// Built-in question reader for Ask Ledger: turns a plain-English question into the same search plan the AI
// produces ({ intent, payee, category, account, from, to }). Pure function, no model needed, runs instantly.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate(); // m is 0-based

const STOP = new Set(('how much many what whats what\'s is are was were did do does i me my mine we our you the a an of on in at to for from with by and or since till until upto up this last past previous next ' +
  'spend spent spending spends paid pay paying payment payments cost costs costed total sum show list give tell find all any every ' +
  'money rupees rs inr transaction transactions txn txns order orders purchase purchases bought buy expense expenses ' +
  'month months week weeks year years day days today yesterday fy financial ytd so far far ago far there here have has had get got ' +
  'jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november dec december ' +
  'can could should would will please much more less than about over under into out per each times time often top biggest most').split(' '));

function period(q, today) {
  const t = new Date(today + 'T00:00:00');
  const y = t.getFullYear(), m = t.getMonth();
  const fyStart = m >= 3 ? y : y - 1;
  const mon = (s) => MONTHS.indexOf(s.slice(0, 3));
  let r;
  if (/\btoday\b/.test(q)) return { from: today, to: today };
  if (/\byesterday\b/.test(q)) { const d = new Date(t); d.setDate(d.getDate() - 1); return { from: iso(d), to: iso(d) }; }
  if ((r = q.match(/\b(?:last|past|previous)\s+(\d+)\s+(day|week|month|year)s?\b/))) {
    const d = new Date(t); const n = +r[1];
    if (r[2] === 'day') d.setDate(d.getDate() - n + 1); else if (r[2] === 'week') d.setDate(d.getDate() - 7 * n + 1); else if (r[2] === 'month') d.setMonth(d.getMonth() - n); else d.setFullYear(d.getFullYear() - n);
    return { from: iso(d), to: today };
  }
  if (/\bthis week\b/.test(q)) { const d = new Date(t); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: iso(d), to: today }; }
  if (/\blast week\b/.test(q)) { const d = new Date(t); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7); const e = new Date(d); e.setDate(e.getDate() + 6); return { from: iso(d), to: iso(e) }; }
  if (/\bthis month\b/.test(q)) return { from: `${y}-${pad(m + 1)}-01`, to: today };
  if (/\blast month\b|\bprevious month\b/.test(q)) { const ly = m ? y : y - 1, lm = m ? m - 1 : 11; return { from: `${ly}-${pad(lm + 1)}-01`, to: `${ly}-${pad(lm + 1)}-${lastDay(ly, lm)}` }; }
  if (/\blast (fy|financial year)\b/.test(q)) return { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` };
  if (/\b(this )?(fy|financial year)\b|\bytd\b/.test(q)) return { from: `${fyStart}-04-01`, to: today };
  if (/\blast year\b/.test(q)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (/\bthis year\b/.test(q)) return { from: `${y}-01-01`, to: today };
  const M = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  // "since july", "from july"
  if ((r = q.match(new RegExp(`\\b(?:since|from|after)\\s+${M}\\b(?:\\s+(20\\d\\d))?`)))) {
    const mm = mon(r[1]); let yy = r[2] ? +r[2] : y; if (!r[2] && mm > m) yy--;
    let to = today;
    const r2 = q.match(new RegExp(`\\b(?:to|till|until|through)\\s+${M}\\b(?:\\s+(20\\d\\d))?`));
    if (r2) { const m2 = mon(r2[1]); let y2 = r2[2] ? +r2[2] : yy; if (m2 < mm && !r2[2]) y2++; to = `${y2}-${pad(m2 + 1)}-${lastDay(y2, m2)}`; }
    return { from: `${yy}-${pad(mm + 1)}-01`, to };
  }
  // "in october", "october 2026"
  if ((r = q.match(new RegExp(`\\b(?:in|during|for)?\\s*${M}\\b(?:\\s+(20\\d\\d))?`)))) {
    const mm = mon(r[1]); let yy = r[2] ? +r[2] : y; if (!r[2] && mm > m) yy--;
    return { from: `${yy}-${pad(mm + 1)}-01`, to: `${yy}-${pad(mm + 1)}-${lastDay(yy, mm)}` };
  }
  return { from: '', to: '' };
}

function intent(q) {
  if (/\bnet ?worth\b|\bworth\b|\bhow rich\b/.test(q)) return 'net_worth';
  if (/\b(optimi[sz]e|save more|saving tips|cut (down|back)|reduce|spend less|overspend|tips?|advice|advise|budget|improve|better with|where can i save|wasting)\b/.test(q)) return 'advice';
  if (/\bbalance\b|\bhow much (do i have|is (left|there)|money do i have)\b/.test(q)) return 'account_balance';
  if (/\b(categor(y|ies)|where (does|did|do) (my|the) money go|break ?down)\b/.test(q)) return 'top_categories';
  if (/\b(payees?|merchants?|who (do|did) i pay|shops?|stores?) (most|the most)?|\btop (payees|merchants|shops)\b|\bwho .*most\b/.test(q)) return 'top_payees';
  if (/\b(by month|per month|monthly|month by month|trend|each month|every month)\b/.test(q)) return 'monthly_trend';
  if (/\bhow many\b|\bnumber of\b|\bcount\b/.test(q)) return 'count';
  if (/\b(received|receive|income|earned|credited|salary|got paid|refunds?)\b/.test(q)) return 'total_received';
  if (/\b(show|list|see|view|display)\b/.test(q)) return 'list';
  return 'total_spent';
}

// q: question. categories: [{id,name}]. accounts: [{name, words}]. knownText: lowercase text of all payees/descriptions
export function planQuestion(question, { today, categories = [], accounts = [], knownText = '' }) {
  const q = ' ' + String(question || '').toLowerCase().replace(/[’']/g, "'").replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const plan = { intent: intent(q), payee: '', category: '', account: '', ...period(q, today) };
  // Category: the longest category name (or its first word) mentioned in the question
  let best = null;
  for (const c of categories) {
    const names = [c.name.toLowerCase(), ...c.name.toLowerCase().split(/\s*(?:&|,|and|\/)\s*/).filter((w) => w.length > 3), c.id.replace(/_/g, ' ')];
    for (const n of names) {
      const stem = n.replace(/s$/, '');
      if (stem.length > 3 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(q) && (!best || n.length > best.len)) best = { id: c.id, len: n.length, words: n.split(/\s+/) };
    }
  }
  if (best) plan.category = best.id;
  // Account: words from an account name or its last 4 digits
  const acc = accounts.find((a) => a.words.some((w) => w.length > 2 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)));
  const accWords = acc ? acc.words.filter((w) => q.includes(' ' + w + ' ')) : [];
  if (acc) plan.account = accWords.join(' ');
  // Payee: what's left, kept only if it appears somewhere in your transactions
  if (!['net_worth', 'advice', 'account_balance'].includes(plan.intent)) {
    const catWords = new Set(best ? best.words.flatMap((w) => [w, w.replace(/s$/, '')]) : []);
    const left = q.trim().split(' ').filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w) && !catWords.has(w) && !catWords.has(w.replace(/s$/, '')) && !accWords.includes(w) && !['card', 'account', 'bank', 'credit', 'debit', 'savings', 'upi'].includes(w));
    const found = left.filter((w) => knownText.includes(w) || knownText.includes(w.replace(/s$/, '')));
    plan.payee = found.map((w) => (knownText.includes(w) ? w : w.replace(/s$/, ''))).join(' ');
  }
  return plan;
}
