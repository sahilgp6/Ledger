#!/usr/bin/env python3
"""Fetches NSE prices for the whole listed universe (equities + ETFs) and writes prices.json.
Runs in GitHub Actions. It never sees anyone's holdings: it prices every NSE symbol, and the
Ledger app on the phone picks out the ones it needs."""
import csv, io, json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Accept": "*/*", "Accept-Language": "en-IN,en;q=0.9"}
OUT = sys.argv[1] if len(sys.argv) > 1 else "prices.json"
PREV = sys.argv[2] if len(sys.argv) > 2 else None

def get(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def nse_symbols():
    syms, notes = set(), []
    for url, col in [("https://archives.nseindia.com/content/equities/EQUITY_L.csv", "SYMBOL"),
                     ("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv", "SYMBOL"),
                     ("https://archives.nseindia.com/content/equities/eq_etfseclist.csv", "Symbol"),
                     ("https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv", "Symbol")]:
        try:
            rows = csv.DictReader(io.StringIO(get(url).decode("utf-8", "ignore")))
            n = 0
            for r in rows:
                k = next((c for c in r if c and c.strip().lower() == col.lower()), None)
                if k and r[k].strip(): syms.add(r[k].strip().upper()); n += 1
            notes.append(f"{url.split('/')[-1]}: {n}")
        except Exception as e:
            notes.append(f"{url.split('/')[2]}/{url.split('/')[-1]}: {e}")
    return syms, notes

def yahoo_spark(batch):
    """Returns {SYMBOL: (price, prev_close, epoch)} for up to 20 symbols."""
    out = {}
    q = ",".join(s + ".NS" for s in batch)
    for host in ("query1", "query2"):
        try:
            data = json.loads(get(f"https://{host}.finance.yahoo.com/v7/finance/spark?symbols={urllib.parse.quote(q)}&range=1d&interval=5m"))
            for r in (data.get("spark") or {}).get("result") or []:
                sym = r.get("symbol", "").replace(".NS", "")
                resp = (r.get("response") or [{}])[0]
                meta = resp.get("meta") or {}
                p = meta.get("regularMarketPrice")
                if p: out[sym] = (round(p, 2), meta.get("chartPreviousClose") or meta.get("previousClose"), meta.get("regularMarketTime"))
            if out: return out
        except Exception:
            continue
    return out

def yahoo_chart(sym):
    for host in ("query1", "query2"):
        try:
            data = json.loads(get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}.NS?range=1d&interval=5m"))
            meta = data["chart"]["result"][0]["meta"]
            if meta.get("regularMarketPrice"):
                return (round(meta["regularMarketPrice"], 2), meta.get("chartPreviousClose"), meta.get("regularMarketTime"))
        except Exception:
            continue
    return None

def main():
    prev = {}
    if PREV and os.path.exists(PREV):
        try: prev = json.load(open(PREV))
        except Exception: prev = {}
    syms, notes = nse_symbols()
    if len(syms) < 500:  # NSE blocked us: reuse the last good list
        syms |= set(prev.get("symbols") or prev.get("prices", {}).keys())
        notes.append(f"reused previous symbol list: {len(syms)}")
    syms = sorted(syms)
    prices, failed = {}, []
    for i in range(0, len(syms), 20):
        batch = syms[i:i + 20]
        got = yahoo_spark(batch)
        prices.update(got)
        missing = [s for s in batch if s not in got]
        if missing and len(got) == 0 and i < 60:  # spark not working at all: try charts for the first batches
            for s in missing:
                r = yahoo_chart(s)
                if r: prices[s] = r
        time.sleep(0.25)
    # keep last known price for anything that failed this run
    for s, v in (prev.get("prices") or {}).items():
        if s not in prices: prices[s] = v; failed.append(s)
    out = {"updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "Yahoo Finance (NSE, ~15 min delayed)",
           "count": len(prices), "fresh": len(prices) - len(failed), "notes": notes, "symbols": syms,
           "prices": {k: list(v) for k, v in sorted(prices.items())}}
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(json.dumps({k: out[k] for k in ("updatedAt", "count", "fresh", "notes")}))

if __name__ == "__main__":
    main()
