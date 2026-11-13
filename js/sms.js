// Bank SMS parsing (Indian banks; tuned on HDFC formats). Pure functions, no network.
// Returns { ok, amount (paise, signed: negative = money out), last4, isCard, merchant, ref, date, skip }

// Bump when parsing improves: messages skipped by an older version get another look
export const SMS_PV = 2;

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// Messages that look like money but are not a completed transaction
const SKIP = [
  [/\bOTP\b|one[- ]time password|verification code/i, 'OTP'],
  [/\b(declined|failed|unsuccessful|was not successful|reversed due to)\b/i, 'Declined or failed'],
  [/\bwill be (debited|charged)|\bmandate\b|\bauto[- ]?pay set|\bscheduled\b/i, 'Upcoming, not yet charged'],
  [/\b(total (amount )?due|min(imum)? (amount )?due|statement (is )?generated|payment due|is due on)\b/i, 'Statement or due reminder'],
  [/\b(requested money|collect request|has requested)\b/i, 'Payment request'],
];

function pickDate(text, receivedAt) {
  const ref = receivedAt ? new Date(receivedAt) : new Date();
  const refIso = `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}-${pad(ref.getDate())}`;
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(?:on|dt\.?|date)\s*:?\s*(\d{1,2})[-\/ .]([A-Za-z]{3}|\d{1,2})(?:[-\/ .,]+(\d{2,4}))?\b/i)
    || text.match(/\b(\d{1,2})[-\/]([A-Za-z]{3}|\d{1,2})[-\/](\d{2,4})\b/);
  if (m) {
    const d = +m[1];
    const mo = /^\d+$/.test(m[2]) ? +m[2] : MON[m[2].toLowerCase()];
    if (mo && mo <= 12 && d >= 1 && d <= 31) {
      let y = m[3] ? +m[3] : ref.getFullYear();
      if (y < 100) y += 2000;
      let iso = `${y}-${pad(mo)}-${pad(d)}`;
      // "On 12-11" has no year: if that lands in the future, it was last year
      if (!m[3] && iso > refIso) iso = `${y - 1}-${pad(mo)}-${pad(d)}`;
      return iso;
    }
  }
  return refIso;
}

function cleanMerchant(s) {
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
  s = s.replace(/^(VPA|vpa)\s+/, '');
  return s;
}

export function parseSms(text, receivedAt) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return { ok: false, skip: 'Empty' };
  for (const [re, why] of SKIP) if (re.test(t)) return { ok: false, skip: why, text: t };

  const am = t.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!am) return { ok: false, skip: 'No amount found', text: t };
  const amount = Math.round(parseFloat(am[1].replace(/,/g, '')) * 100);
  if (!amount) return { ok: false, skip: 'Zero amount', text: t };

  // Direction: whichever money verb appears first wins
  const debitRe = /\b(spent|debited|txn|transaction of|sent|paid|withdrawn|purchase|used for|charged)\b/i;
  const creditRe = /\b(credited|received|deposited|refund(ed)?|reversal|reversed|cashback|added to)\b/i;
  const di = t.search(debitRe), ci = t.search(creditRe);
  let dir = null;
  if (di >= 0 && (ci < 0 || di < ci)) dir = 'out';
  else if (ci >= 0) dir = 'in';
  // "payment of Rs X received towards your credit card" is money into the card
  if (/payment .*\b(received|credited)\b.*card|card.*payment .*\b(received|credited)\b/i.test(t)) dir = 'in';
  // "Money Transfer: Rs 300 from HDFC Bank A/c **8381 ... to RAHUL": money leaving your account
  if (!dir && /\bfrom\b[^.]*?\b(?:a\/c|acct|account|bank)\b[^.]*?\bto\b/i.test(t)) dir = 'out';
  if (!dir && /\bto\b[^.]*?\b(?:your|ur)\s+(?:a\/c|acct|account)\b/i.test(t)) dir = 'in';
  if (!dir) return { ok: false, skip: 'Could not tell debit from credit', text: t };

  const lm = t.match(/\b(?:card|a\/c|acct|account|ac)\b\s*(?:no\.?|number)?\s*(?:ending(?: with)?|ending in)?\s*[:#]?\s*[xX*.]*\s*(\d{4})\b/i);
  // Fallback: "HDFC Bank XX8381", "A/c **8381", "Card x9550"
  const lm2 = lm ? null : t.match(/(?:[xX*]{2,}|\b[xX*])\s?(\d{4})\b/);
  const last4 = lm ? lm[1] : lm2 ? lm2[1] : null;
  const isCard = lm ? /card/i.test(lm[0]) : /card/i.test(t);

  let merchant = '';
  const at = t.match(/\bat\s+(.+?)(?=\s+(?:on|by|via|ref|txn|for)\b|\n|\(|$)/i);
  const to = t.match(/\bto\s+(?:VPA\s+)?(?!(?:your|a\/c|ac|account|card)\b)(.+?)(?=\s+(?:on|via|ref|upi)\b|\n|\(|$)/i);
  const from = t.match(/\bfrom\s+(?:VPA\s+)?(?!(?:your|hdfc bank a\/c|a\/c|ac|account)\b)(.+?)(?=\s+(?:on|via|ref|upi)\b|\n|\(|$)/i);
  const info = t.match(/\bInfo:?\s*(.+?)(?=\.|\n|$)/i) || t.match(/\bfor\s+((?:NEFT|IMPS|RTGS)\s*(?:Cr|Dr)?-?.+?)(?=\.\s|\n|\s+Avl|$)/i);
  if (dir === 'out') merchant = cleanMerchant(at?.[1] || to?.[1] || info?.[1]);
  else merchant = cleanMerchant(from?.[1] || info?.[1] || at?.[1]);
  if (/payment .*(received|credited)/i.test(t) && isCard) merchant = 'Card payment';

  const rm = t.match(/\b(?:UPI(?:\s*Ref(?:\s*No)?)?|Ref(?:erence)?(?:\s*No)?|RRN|Txn\s*ID)\.?\s*[:#]?\s*(\d{6,})/i);
  const channel = /\bUPI\b|@[a-z]+/i.test(t) ? 'UPI' : isCard ? 'Card' : (/NEFT|IMPS|RTGS/i.exec(t)?.[0] || '');

  return {
    ok: true, amount: dir === 'out' ? -amount : amount, last4, isCard, merchant, ref: rm ? rm[1] : null,
    date: pickDate(t, receivedAt), channel, text: t,
  };
}

// A merchant like "*8191@ybl" is a masked UPI handle: not a useful payee name
export function smsPayee(p) {
  const m = p.merchant || '';
  if (!m || /^[*xX\d]*@[a-z]+$/i.test(m) || /^\*+\d*$/.test(m)) return p.channel === 'UPI' ? 'UPI payment' : (p.amount > 0 ? 'Money received' : 'Card payment');
  if (/@/.test(m)) return m.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+$/, '').trim() || 'UPI payment';
  return m;
}

// The Shortcut appends blocks like:
// ===SMS=== 2026-11-12T20:15:11+05:30
// Txn Rs.198.00 ...
// Pasted text without markers is treated as one message.
export function splitInbox(text) {
  const s = String(text || '').replace(/\r/g, '');
  if (!s.includes('===SMS===')) return s.trim() ? [{ text: s.trim(), receivedAt: null }] : [];
  return s.split('===SMS===').slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const head = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim();
    const body = (nl >= 0 ? chunk.slice(nl + 1) : '').trim();
    const h2 = head.replace(/\s+at\s+/i, ' ');
    const d = head && /\d/.test(head) && !isNaN(Date.parse(h2)) ? new Date(h2).toISOString() : null;
    return { text: d ? body : (head + '\n' + body).trim(), receivedAt: d };
  }).filter((x) => x.text);
}
