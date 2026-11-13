// India-specific defaults: account types, categories, merchant rules, and UPI/card narration cleanup.

export const ACCOUNT_TYPES = [
  // mode: 'ledger' = balance comes from opening balance + transactions; 'value' = balance is the latest value you enter
  { id: 'savings', label: 'Savings account', side: 'asset', mode: 'ledger', group: 'Bank' },
  { id: 'current', label: 'Current account', side: 'asset', mode: 'ledger', group: 'Bank' },
  { id: 'cash', label: 'Cash', side: 'asset', mode: 'ledger', group: 'Cash & wallets' },
  { id: 'wallet', label: 'Wallet (Amazon Pay, Paytm…)', side: 'asset', mode: 'ledger', group: 'Cash & wallets' },
  { id: 'fd', label: 'Fixed deposit', side: 'asset', mode: 'value', group: 'Deposits' },
  { id: 'rd', label: 'Recurring deposit', side: 'asset', mode: 'value', group: 'Deposits' },
  { id: 'ppf', label: 'PPF', side: 'asset', mode: 'value', group: 'Retirement' },
  { id: 'epf', label: 'EPF', side: 'asset', mode: 'value', group: 'Retirement' },
  { id: 'nps', label: 'NPS', side: 'asset', mode: 'value', group: 'Retirement' },
  { id: 'mutual_fund', label: 'Mutual funds', side: 'asset', mode: 'value', group: 'Investments' },
  { id: 'stocks', label: 'Stocks (Zerodha etc.)', side: 'asset', mode: 'value', group: 'Investments' },
  { id: 'gold', label: 'Gold / SGB', side: 'asset', mode: 'value', group: 'Investments' },
  { id: 'crypto', label: 'Crypto', side: 'asset', mode: 'value', group: 'Investments' },
  { id: 'property', label: 'Property', side: 'asset', mode: 'value', group: 'Property & vehicles' },
  { id: 'vehicle', label: 'Vehicle', side: 'asset', mode: 'value', group: 'Property & vehicles' },
  { id: 'other_asset', label: 'Other asset', side: 'asset', mode: 'value', group: 'Other' },
  { id: 'credit_card', label: 'Credit card', side: 'liability', mode: 'ledger', group: 'Credit cards' },
  { id: 'home_loan', label: 'Home loan', side: 'liability', mode: 'value', group: 'Loans' },
  { id: 'car_loan', label: 'Car loan', side: 'liability', mode: 'value', group: 'Loans' },
  { id: 'personal_loan', label: 'Personal loan', side: 'liability', mode: 'value', group: 'Loans' },
  { id: 'education_loan', label: 'Education loan', side: 'liability', mode: 'value', group: 'Loans' },
  { id: 'other_liability', label: 'Other liability', side: 'liability', mode: 'value', group: 'Loans' },
];
export const typeOf = (id) => ACCOUNT_TYPES.find((t) => t.id === id) || ACCOUNT_TYPES[0];

// kind: expense | income | transfer (transfers never count as spending or income)
const C = (id, name, group, kind = 'expense') => ({ id, name, group, kind });
export const DEFAULT_CATEGORIES = [
  C('salary', 'Salary', 'Income', 'income'), C('interest_in', 'Interest earned', 'Income', 'income'), C('dividends', 'Dividends', 'Income', 'income'),
  C('cashback', 'Cashback & rewards', 'Income', 'income'), C('other_income', 'Other income', 'Income', 'income'),
  C('groceries', 'Groceries', 'Food'), C('food_delivery', 'Food delivery', 'Food'), C('dining', 'Dining out', 'Food'), C('coffee', 'Coffee & snacks', 'Food'),
  C('clothing', 'Clothing & shoes', 'Shopping'), C('online', 'Online shopping', 'Shopping'), C('home', 'Home & garden', 'Shopping'), C('electronics', 'Electronics', 'Shopping'), C('giftcards', 'Gift cards & wallet loads', 'Shopping'),
  C('fuel', 'Fuel', 'Transport'), C('cabs', 'Cabs & autos', 'Transport'), C('car', 'Car service & parts', 'Transport'), C('parking', 'Parking & tolls', 'Transport'), C('travel', 'Travel & holidays', 'Transport'),
  C('mobile', 'Mobile & internet', 'Bills'), C('electricity', 'Electricity', 'Bills'), C('gas', 'Gas', 'Bills'), C('rent', 'Rent', 'Bills'), C('society', 'Society maintenance', 'Bills'), C('subscriptions', 'Subscriptions & OTT', 'Bills'), C('domestic_help', 'Domestic help', 'Bills'),
  C('medicines', 'Medicines', 'Health'), C('doctor', 'Doctor & hospital', 'Health'), C('fitness', 'Fitness', 'Health'),
  C('pet_supplies', 'Pet supplies', 'Pets'), C('vet', 'Vet', 'Pets'),
  C('personal_care', 'Personal care', 'Personal'), C('entertainment', 'Entertainment', 'Personal'), C('education', 'Education', 'Personal'), C('gifts', 'Gifts & donations', 'Personal'), C('family', 'Family support', 'Personal'),
  C('fees', 'Bank charges, fees & GST', 'Financial'), C('interest_paid', 'Interest paid', 'Financial'), C('insurance', 'Insurance', 'Financial'), C('taxes', 'Taxes', 'Financial'),
  C('investments', 'Investments', 'Transfers', 'transfer'), C('card_payment', 'Credit card payment', 'Transfers', 'transfer'), C('emi_conversion', 'EMI conversion & principal', 'Transfers', 'transfer'),
  C('loan_repayment', 'Loan repayment (principal)', 'Transfers', 'transfer'), C('cash_withdrawal', 'Cash withdrawal', 'Transfers', 'transfer'), C('self_transfer', 'Transfer between my accounts', 'Transfers', 'transfer'), C('adjustment', 'Balance adjustment', 'Transfers', 'transfer'),
];

// Default merchant rules. Order matters: first match wins, so specific patterns come before broad ones.
// sign: 'out' = only money going out, 'in' = only money coming in, undefined = either (refunds net against the same category)
const R = (pattern, category, sign) => ({ pattern, category, sign });
export const DEFAULT_RULES = [
  // Card mechanics
  R('CC PAYMENT', 'card_payment', 'in'), R('PAYMENT RECEIVED', 'card_payment', 'in'), R('THANK YOU FOR PAYMENT', 'card_payment', 'in'), R('BBPS PAYMENT', 'card_payment', 'in'),
  R('AGGREGATOR EMI', 'emi_conversion'), R('AGGREGATOREMI', 'emi_conversion'), R('OFFUS EMI,PRIN', 'emi_conversion'), R('EMI PRINCIPAL', 'emi_conversion'),
  R('OFFUS EMI,INT', 'interest_paid'), R('EMI INTEREST', 'interest_paid'), R('FINANCE CHARGE', 'interest_paid'),
  R('PROCNG FEE', 'fees'), R('PROCESSING FEE', 'fees'), R('IGST-', 'fees'), R('CGST-', 'fees'), R('SGST-', 'fees'), R('LATE FEE', 'fees'), R('ANNUAL FEE', 'fees'), R('RENEWAL FEE', 'fees'), R('MARKUP FEE', 'fees'),
  R('PETRO SURCHARGE', 'fuel'), R('FUEL SURCHARGE', 'fuel'),
  // Groceries & quick commerce (before Swiggy/Jio so Instamart and JioMart win)
  R('INSTAMART', 'groceries'), R('JIOMART', 'groceries'), R('BLINKIT', 'groceries'), R('BLINK COMMERCE', 'groceries'), R('ZEPTO', 'groceries'), R('KIRANAKART', 'groceries'),
  R('BIGBASKET', 'groceries'), R('SUPERMARKET GROCERY', 'groceries'), R('DMART', 'groceries'), R('AVENUE SUPERMARTS', 'groceries'), R('NATURES BASKET', 'groceries'), R('NATURE S BASKET', 'groceries'),
  R('LICIOUS', 'groceries'), R('FRESHTOHOME', 'groceries'), R('FOODSTORIES', 'groceries'), R('STAR BAZAAR', 'groceries'), R('RELIANCE SMART', 'groceries'), R('RELIANCE FRESH', 'groceries'), R('COUNTRY DELIGHT', 'groceries'), R('MILKBASKET', 'groceries'),
  // Food
  R('SWIGGY', 'food_delivery'), R('ZOMATO', 'food_delivery'), R('EATCLUB', 'food_delivery'), R('BOX8', 'food_delivery'),
  R('STARBUCKS', 'coffee'), R('CHAAYOS', 'coffee'), R('THIRD WAVE', 'coffee'), R('BLUE TOKAI', 'coffee'), R('TIM HORTONS', 'coffee'), R('BARISTA', 'coffee'), R('CAFE COFFEE DAY', 'coffee'),
  R('MC DONALDS', 'dining'), R('MCDONALDS', 'dining'), R('DOMINOS', 'dining'), R('KFC', 'dining'), R('BURGER KING', 'dining'), R('PIZZA HUT', 'dining'), R('SUBWAY', 'dining'), R('HOSPITALITY', 'dining'), R('RESTAURANT', 'dining'), R('JOHNNYROCKETS', 'dining'), R('M S CANDIES', 'dining'),
  // Shopping
  R('ZARA', 'clothing'), R('HENNES', 'clothing'), R('H&M', 'clothing'), R('UNIQLO', 'clothing'), R('AJIO', 'clothing'), R('MYNTRA', 'clothing'), R('BIRKENSTOCK', 'clothing'), R('WESTSIDE', 'clothing'), R('MAX FASHION', 'clothing'),
  R('LIFESTYLE INTERNATIONAL', 'clothing'), R('SHOPPERS STOP', 'clothing'), R('DECATHLON', 'clothing'), R('NYKAA FASHION', 'clothing'), R('SUITING', 'clothing'), R('BATA', 'clothing'), R('NIKE', 'clothing'), R('ADIDAS', 'clothing'),
  R('IKEA', 'home'), R('PEPPERFRY', 'home'), R('URBAN LADDER', 'home'), R('HOME CENTRE', 'home'), R('UGAOO', 'home'), R('NURSERY', 'home'), R('MUJI', 'home'),
  R('CROMA', 'electronics'), R('RELIANCE DIGITAL', 'electronics'), R('VIJAY SALES', 'electronics'), R('APPLE INDIA', 'electronics'),
  R('AMAZONGIFTCARD', 'giftcards'), R('AMAZON PAY', 'giftcards'), R('GIFT CARD', 'giftcards'), R('GIFTCARD', 'giftcards'),
  R('AMAZON', 'online'), R('FLIPKART', 'online'), R('MEESHO', 'online'), R('TATA CLIQ', 'online'), R('NYKAA', 'personal_care'),
  // Transport & travel
  R('UBER', 'cabs'), R('OLACABS', 'cabs'), R('ANI TECHNOLOGIES', 'cabs'), R('RAPIDO', 'cabs'), R('ROPPEN', 'cabs'), R('BLU SMART', 'cabs'), R('NAMMA YATRI', 'cabs'),
  R('HPCL', 'fuel'), R('BPCL', 'fuel'), R('IOCL', 'fuel'), R('INDIAN OIL', 'fuel'), R('BHARAT PETROLEUM', 'fuel'), R('HINDUSTAN PETROLEUM', 'fuel'), R('SHELL', 'fuel'), R('NAYARA', 'fuel'), R('PETROL', 'fuel'), R('FILLING STATION', 'fuel'),
  R('FASTAG', 'parking'), R('NETC', 'parking'), R('PARKING', 'parking'), R('TOLL', 'parking'),
  R('INDIGO', 'travel'), R('INTERGLOBE', 'travel'), R('AKASA', 'travel'), R('VISTARA', 'travel'), R('MAKEMYTRIP', 'travel'), R('GOIBIBO', 'travel'), R('CLEARTRIP', 'travel'), R('IXIGO', 'travel'), R('IRCTC', 'travel'), R('AIRBNB', 'travel'), R('BOOKING.COM', 'travel'), R('AGODA', 'travel'), R('ORAVEL STAYS', 'travel'), R('TAJ HOTELS', 'travel'),
  // Bills
  R('JIOCINEMA', 'subscriptions'), R('JIOHOTSTAR', 'subscriptions'), R('JIO', 'mobile'), R('AIRTEL', 'mobile'), R('VODAFONE', 'mobile'), R('BSNL', 'mobile'), R('ACT FIBERNET', 'mobile'), R('HATHWAY', 'mobile'), R('TATA PLAY', 'subscriptions'),
  R('MSEDCL', 'electricity'), R('MAHAVITARAN', 'electricity'), R('ADANI ELECTRICITY', 'electricity'), R('TATA POWER', 'electricity'), R('TORRENT POWER', 'electricity'), R('BEST UNDERTAKING', 'electricity'),
  R('MAHANAGAR GAS', 'gas'), R('INDANE', 'gas'), R('HP GAS', 'gas'), R('BHARATGAS', 'gas'),
  R('NETFLIX', 'subscriptions'), R('SPOTIFY', 'subscriptions'), R('HOTSTAR', 'subscriptions'), R('YOUTUBE', 'subscriptions'), R('APPLE.COM', 'subscriptions'), R('APPLE SERVICES', 'subscriptions'), R('GOOGLE PLAY', 'subscriptions'), R('ANTHROPIC', 'subscriptions'), R('CLAUDE.AI', 'subscriptions'), R('OPENAI', 'subscriptions'), R('PRIME VIDEO', 'subscriptions'), R('SONYLIV', 'subscriptions'),
  R('NOBROKER', 'rent'), R('MYGATE', 'society'),
  // Health & pets (vet before hospital)
  R('VET', 'vet'), R('SUPERPETS', 'pet_supplies'), R('HEADS UP FOR TAILS', 'pet_supplies'), R('HUFT', 'pet_supplies'), R('SUPERTAILS', 'pet_supplies'), R('PETS', 'pet_supplies'),
  R('1MG', 'medicines'), R('PHARMEASY', 'medicines'), R('NETMEDS', 'medicines'), R('APOLLO PHARMACY', 'medicines'), R('CHEMIST', 'medicines'), R('PHARMA', 'medicines'), R('MEDICAL', 'medicines'), R('WELLNESS FOREVER', 'medicines'),
  R('HOSPITAL', 'doctor'), R('CLINIC', 'doctor'), R('DIAGNOSTIC', 'doctor'), R('PATHOLOGY', 'doctor'), R('PRACTO', 'doctor'), R('DENTAL', 'doctor'),
  R('CULTFIT', 'fitness'), R('CURE FIT', 'fitness'), R('GYM', 'fitness'),
  R('BOOKMYSHOW', 'entertainment'), R('PVR', 'entertainment'), R('INOX', 'entertainment'), R('DISTRICT', 'entertainment'),
  // Money movement (bank statements)
  R('ZERODHA', 'investments', 'out'), R('BSE STAR MF', 'investments', 'out'), R('INDIAN CLEARING', 'investments', 'out'), R('NSE CLEARING', 'investments', 'out'), R('GROWW', 'investments', 'out'), R('KUVERA', 'investments', 'out'), R('COIN BY ZERODHA', 'investments', 'out'), R('NPS TRUST', 'investments', 'out'), R('PPF', 'investments', 'out'),
  R('LIC OF INDIA', 'insurance', 'out'), R('LIFE INSURANCE CORP', 'insurance', 'out'), R('HDFC LIFE', 'insurance', 'out'), R('ICICI PRU', 'insurance', 'out'), R('STAR HEALTH', 'insurance', 'out'), R('NIVA BUPA', 'insurance', 'out'), R('ACKO', 'insurance', 'out'), R('POLICYBAZAAR', 'insurance', 'out'),
  R('AUTOPAY SI', 'card_payment', 'out'), R('CREDIT CARD', 'card_payment', 'out'), R('CRED CLUB', 'card_payment', 'out'), R('CC BILL', 'card_payment', 'out'), R('BILLDESK CC', 'card_payment', 'out'),
  R('ATM WDL', 'cash_withdrawal', 'out'), R('ATW-', 'cash_withdrawal', 'out'), R('NWD-', 'cash_withdrawal', 'out'), R('CASH WITHDRAWAL', 'cash_withdrawal', 'out'),
  R('ADVANCE TAX', 'taxes', 'out'), R('INCOME TAX', 'taxes', 'out'), R('TDS', 'taxes', 'out'), R('GST PAYMENT', 'taxes', 'out'),
  R('AIR INDIA EXPRESS', 'salary', 'in'), R('SALARY', 'salary', 'in'), R('SAL CREDIT', 'salary', 'in'),
  R('INT.PD', 'interest_in', 'in'), R('INT PD', 'interest_in', 'in'), R('INTEREST PAID', 'interest_in', 'in'), R('CREDIT INTEREST', 'interest_in', 'in'), R('SB INT', 'interest_in', 'in'),
  R('DIVIDEND', 'dividends', 'in'), R('ACH C-', 'dividends', 'in'), R('CASHBACK', 'cashback', 'in'), R('REWARD', 'cashback', 'in'),
];

// Collapse to letters and digits so "MC DONALDS", "McDonalds" and "MC-DONALDS" all match the same rule
export const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9@&.]/g, '');

const STRIP = /\b(PVT|PRIVATE|PRIVA|PRIV|PRI|PR|LTD|LIMITED|LIMI|LIM|LI|L|LLP|INDIA|INDIAN|IND|SYSTEMS|SYSTEM|SOLUTIONS|SOLUT|SOLU|SERVICES|SERV|COMMERCE|TECHNOLOGIES|TECH|RETAIL|CO|COM|THE|M S|MS)\b/g;
const CITIES = /(MUMBAI|THANE|BANGALORE|BENGALURU|DELHI|NEW DELHI|GURGAON|GURUGRAM|PUNE|HYDERABAD|CHENNAI|KOLKATA|NOIDA|NAVI MUMBAI)$/;
const title = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Upi|Emi|Atm|Neft|Imps|Rtgs|Hdfc|Icici|Sbi|Lic|Kfc|Ikea|Mcd|Jio|Ajio|Mtnl|Bses|Hpcl|Bpcl|Iocl|1mg)\b/g, (m) => m.toUpperCase());

// Well-known narrations that clean-up alone gets wrong
const PAYEE_ALIASES = [
  ['OFFUSEMI,PRIN', 'EMI principal'], ['OFFUSEMI,INT', 'EMI interest'], ['PROCNGFEE', 'EMI processing fee'], ['AGGREGATOREMI', 'EMI conversion credit'],
  ['IGST-', 'GST on charges'], ['CGST-', 'GST on charges'], ['SGST-', 'GST on charges'], ['CCPAYMENT', 'Card payment'], ['AUTOPAYSI', 'Card autopay'], ['CCBILLPAY', 'Card bill payment'], ['PETROSURCHARGE', 'Fuel surcharge waiver'],
  ['AIRINDIAEXPRESS', 'Air India Express'], ['CREDITINTERESTCAPITALIZED', 'Savings interest'], ['INTERESTCAPITALISED', 'Savings interest'], ['AMAZONGIFTCARD', 'Amazon gift card'], ['AMAZONSELLERSERVICES', 'Amazon'], ['AMAZONINDIA', 'Amazon'], ['AMAZONPAY', 'Amazon Pay'], ['HENNESNMAURITZ', 'H&M'],
  ['INSTAMART', 'Swiggy Instamart'], ['SWIGGY', 'Swiggy'], ['ZOMATO', 'Zomato'], ['BLINKIT', 'Blinkit'], ['BLINKCOMMERCE', 'Blinkit'], ['UBER', 'Uber'], ['ZARACOM', 'Zara'],
  ['MCDONALDS', "McDonald's"], ['TATASTARBUCKS', 'Starbucks'], ['STARBUCKS', 'Starbucks'], ['1MG', 'Tata 1mg'], ['JIOPOSTPAID', 'Jio Postpaid'], ['AJIO', 'AJIO'], ['IKEA', 'IKEA'],
];

// Turn a bank/card narration into a readable payee name
export function payeeFrom(desc) {
  let s = String(desc || '').trim();
  if (!s) return '';
  const sq = squash(s);
  for (const [k, v] of PAYEE_ALIASES) if (sq.includes(squash(k))) return v;
  let u = s.toUpperCase();
  // Bank UPI narrations: UPI/DR/412345/SWIGGY/YESB/swiggy@ybl/Pay  or  UPI-SWIGGY-swiggy@icici-ICIC0DC0099-412345-Payment
  if (/^UPI[\/-]/.test(u) && /[\/-].*[\/-]/.test(u.slice(4)) && /(@|\d{9,})/.test(u)) {
    const parts = s.split(/[\/-]/).map((p) => p.trim()).filter(Boolean).slice(1);
    const name = parts.find((p) => /^[A-Za-z][A-Za-z .&']{2,}$/.test(p) && !/^(DR|CR|P2A|P2M|UPI|PAYMENT|PAY|SENT|REQ|COLLECT|NA)$/i.test(p) && !/^[A-Z]{4}0?$/.test(p));
    const handle = parts.find((p) => p.includes('@'));
    s = name || (handle ? handle.split('@')[0] : parts[0] || s);
    u = s.toUpperCase();
  }
  u = u.replace(/^(UPI-|EMI |ATO |POS |ECOM |NFS |IMPS-|NEFT-|NEFT |RTGS-)+/, '').replace(/\(REF#.*?\)/, '').replace(/[*#]/g, ' ');
  u = u.replace(CITIES, '').replace(/\s+/g, ' ').trim();
  u = u.replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
  u = u.replace(/\s+(?:[A-Z]|[A-Z]*\d+)$/, '').trim(); // trailing fragments like "P" or "FOOD1"
  if (!u) u = s.toUpperCase();
  return title(u);
}

export function categorize(tx, userRules, systemRules = DEFAULT_RULES) {
  const hay = squash(tx.description) + '|' + squash(tx.payee);
  const dir = tx.amount < 0 ? 'out' : 'in';
  for (const r of userRules || []) {
    if (r.sign && r.sign !== dir) continue;
    if (r.accountId && r.accountId !== tx.accountId) continue;
    if (hay.includes(squash(r.pattern))) return { categoryId: r.categoryId, payee: r.payee || null, ruleId: r.id };
  }
  for (const r of systemRules) {
    if (r.sign && r.sign !== dir) continue;
    if (hay.includes(squash(r.pattern))) return { categoryId: r.category, payee: null, ruleId: 'sys' };
  }
  return { categoryId: null, payee: null, ruleId: null };
}
