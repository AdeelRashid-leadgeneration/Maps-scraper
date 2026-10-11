#!/usr/bin/env python3
"""Lead enrichment: reads a CSV with a 'Website' column (e.g. exported from Maps Lead Finder)
and collects PUBLICLY LISTED business contact info from each company's own website:
owner/founder name + role, sales / general / personal emails, company + direct phone numbers,
social links. Respects robots.txt. Usage: python enrich.py leads.csv [out.csv]"""
import csv, re, sys, time, json, socket
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
from concurrent.futures import ThreadPoolExecutor
import requests
from bs4 import BeautifulSoup
try:
    import dns.resolver
except ImportError:
    dns = None

UA = "LeadResearchBot/1.0 (business contact research; respects robots.txt)"
PAGES = ["", "/contact", "/contact-us", "/about", "/about-us", "/team", "/our-team", "/leadership", "/meet-the-team"]
ROLES = r"(?:Co-?Founder|Founder|Owner|Co-?Owner|CEO|Chief Executive Officer|President|Principal|Managing Director|Managing Partner|Broker of Record|Broker|Director)"
NAME = r"[A-Z][a-z]+(?:\s[A-Z]\.?)?\s[A-Z][a-zA-Z'’-]+"
SALES = ("sales", "bizdev", "business", "partner", "quote", "order", "enquir", "inquir")
GENERIC = ("info", "contact", "hello", "office", "admin", "support", "help", "mail", "team", "service", "booking", "reception")
BAD_DOM = ("example.", "sentry", "wixpress", "domain.com", "email.com", "yourdomain", "schema.org")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
SOCIAL = {"linkedin": "linkedin.com", "facebook": "facebook.com", "instagram": "instagram.com", "twitter": "x.com"}
FIELDS = ["Owner Name", "Owner Role", "Owner Email", "Sales Email", "General Email", "Other Emails",
          "Company Phone", "Direct/Mobile Phone", "Other Phones", "LinkedIn", "Facebook", "Instagram",
          "Pages Checked", "Domain Can Receive Email", "Confidence"]

def clean_email(e):
    e = e.lower().strip(".,;:)")
    if e.endswith((".png", ".jpg", ".gif", ".svg", ".webp")) or any(b in e for b in BAD_DOM):
        return None
    return e

def deobfuscate(t):
    return re.sub(r"\s*[\[(]\s*at\s*[\])]\s*", "@", re.sub(r"\s*[\[(]\s*dot\s*[\])]\s*", ".", t, flags=re.I), flags=re.I)

def norm_phone(p):
    d = re.sub(r"\D", "", p)
    if len(d) == 11 and d[0] == "1": d = d[1:]
    return f"({d[:3]}) {d[3:6]}-{d[6:]}" if len(d) == 10 else ("+" + d if 8 <= len(d) <= 15 else None)

def extract(html, base_domain, known_phone=""):
    soup = BeautifulSoup(html, "html.parser")
    out = {"emails": set(), "phones": set(), "tel": set(), "owners": [], "direct": set(), "social": {}}
    for a in soup.find_all("a", href=True):
        h = a["href"]
        if h.startswith("mailto:"):
            e = clean_email(h[7:].split("?")[0])
            if e: out["emails"].add(e)
        elif h.startswith("tel:"):
            p = norm_phone(h[4:])
            if p: out["tel"].add(p)
        else:
            for k, d in SOCIAL.items():
                if d in h and k not in out["social"] and "share" not in h: out["social"][k] = h
    for s in soup.find_all("script", type="application/ld+json"):
        try: data = json.loads(s.string or "")
        except Exception: continue
        for o in (data if isinstance(data, list) else data.get("@graph", [data])):
            if not isinstance(o, dict): continue
            f = o.get("founder") or o.get("owner")
            for p in (f if isinstance(f, list) else [f]):
                n = p.get("name") if isinstance(p, dict) else p
                if isinstance(n, str) and re.fullmatch(NAME, n): out["owners"].append((n, "Founder/Owner", "high"))
            if o.get("@type") == "Person" and o.get("jobTitle") and re.fullmatch(NAME, o.get("name", "")):
                if re.search(ROLES, o["jobTitle"], re.I): out["owners"].append((o["name"], o["jobTitle"], "high"))
    text = deobfuscate(soup.get_text("\n"))
    for e in EMAIL_RE.findall(text):
        e = clean_email(e)
        if e: out["emails"].add(e)
    for line in [l.strip() for l in text.split("\n") if l.strip()]:
        for m in re.finditer(rf"(?P<n>{NAME})\s*[,\-–|:()]\s*(?P<r>{ROLES})", line):
            out["owners"].append((m["n"], m["r"], "medium"))
        for m in re.finditer(rf"(?P<r>{ROLES})\s*[:\-–|]\s*(?P<n>{NAME})", line):
            out["owners"].append((m["n"], m["r"], "medium"))
        for m in re.finditer(rf"(?:Owned|Founded|Run|Led)\s+by\s+(?P<n>{NAME})", line):
            out["owners"].append((m["n"], "Owner/Founder", "medium"))
        ph = [norm_phone(p) for p in PHONE_RE.findall(line)]
        ph = [p for p in ph if p]
        out["phones"].update(ph)
        if re.search(r"direct|cell|mobile", line, re.I): out["direct"].update(ph)
    return out

def mx_ok(domain):
    if not dns: return ""
    try:
        return "Yes" if dns.resolver.resolve(domain, "MX", lifetime=4) else "No"
    except Exception:
        return "No"

def robots_ok(base, path):
    try:
        rp = RobotFileParser(urljoin(base, "/robots.txt")); rp.read()
        return rp.can_fetch(UA, urljoin(base, path))
    except Exception:
        return True

def enrich(row, phone_col="Phone", site_col="Website"):
    site = (row.get(site_col) or "").strip()
    res = {k: "" for k in FIELDS}
    if not site.startswith("http"): res["Confidence"] = "No website"; return res
    base, dom = f"{urlparse(site).scheme}://{urlparse(site).netloc}", urlparse(site).netloc.replace("www.", "")
    agg = {"emails": set(), "phones": set(), "tel": set(), "owners": [], "direct": set(), "social": {}}; checked = []
    for p in PAGES:
        if not robots_ok(base, p or "/"): continue
        try:
            r = requests.get(urljoin(base, p), headers={"User-Agent": UA}, timeout=10)
            if r.status_code != 200 or "html" not in r.headers.get("content-type", ""): continue
        except Exception: continue
        x = extract(r.text, dom); checked.append(p or "/")
        for k in ("emails", "phones", "tel", "direct"): agg[k] |= x[k]
        agg["owners"] += x["owners"]; agg["social"].update({k: v for k, v in x["social"].items() if k not in agg["social"]})
        time.sleep(0.7)
    emails = sorted(agg["emails"], key=lambda e: (dom not in e, e))
    sales = [e for e in emails if e.split("@")[0].startswith(SALES) or any(s in e.split("@")[0] for s in SALES)]
    gen = [e for e in emails if e not in sales and any(e.split("@")[0].startswith(g) for g in GENERIC)]
    pers = [e for e in emails if e not in sales and e not in gen]
    owner = max(agg["owners"], key=lambda o: (o[2] == "high", agg["owners"].count(o)), default=None)
    if owner:
        fn, ln = owner[0].lower().split()[0], owner[0].lower().split()[-1]
        oe = [e for e in pers if fn in e.split("@")[0] or ln in e.split("@")[0] or e.split("@")[0] == fn[0] + ln]
        res.update({"Owner Name": owner[0], "Owner Role": owner[1], "Owner Email": oe[0] if oe else ""})
        pers = [e for e in pers if e not in oe[:1]]
    res.update({"Sales Email": "; ".join(sales[:3]), "General Email": "; ".join(gen[:2]), "Other Emails": "; ".join(pers[:4])})
    known = norm_phone(row.get(phone_col, "") or "") or ""
    company = known or (sorted(agg["tel"])[0] if agg["tel"] else "")
    direct = sorted(agg["direct"] - {company})
    others = sorted((agg["phones"] | agg["tel"]) - {company} - set(direct))
    res.update({"Company Phone": company, "Direct/Mobile Phone": "; ".join(direct[:2]), "Other Phones": "; ".join(others[:3]),
                "LinkedIn": agg["social"].get("linkedin", ""), "Facebook": agg["social"].get("facebook", ""),
                "Instagram": agg["social"].get("instagram", ""), "Pages Checked": " ".join(checked),
                "Domain Can Receive Email": mx_ok(dom) if emails else "",
                "Confidence": ("High" if owner and owner[2] == "high" else "Medium" if owner or emails else "Low") if checked else "Site unreachable"})
    return res

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    src, dst = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else sys.argv[1].replace(".csv", "") + "_enriched.csv")
    rows = list(csv.DictReader(open(src, encoding="utf-8-sig")))
    print(f"Enriching {len(rows)} companies…")
    with ThreadPoolExecutor(4) as ex:
        results = list(ex.map(enrich, rows))
    with open(dst, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) + FIELDS); w.writeheader()
        for r, e in zip(rows, results): w.writerow({**r, **e})
    print("Saved:", dst)

if __name__ == "__main__":
    main()
