// Cloudflare Worker: live backend for Maps Lead Finder.
// Env (Settings > Variables): SERPER_KEY (secret), ACCESS_TOKEN (secret), ALLOWED_ORIGIN (optional, e.g. https://yourname.github.io)
const UA = "LeadResearchBot/1.0 (business contact research; respects robots.txt)";
const PAGES = ["/", "/contact", "/contact-us", "/about", "/team"];
const ROLES = "Co-?Founder|Founder|Co-?Owner|Owner|CEO|Chief Executive Officer|President|Principal|Managing Director|Managing Partner|Broker of Record|Director";
const NAME = "[A-Z][a-z]+(?:\\s[A-Z]\\.?)?\\s[A-Z][a-zA-Z'’-]+";
const SALES = ["sales", "bizdev", "business", "partner", "quote", "order", "enquir", "inquir"];
const GENERIC = ["info", "contact", "hello", "office", "admin", "support", "help", "mail", "team", "service", "booking", "reception"];
const BAD = ["example.", "sentry", "wixpress", "domain.com", "email.com", "yourdomain", "schema.org"];
const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const normPhone = p => { let d = p.replace(/\D/g, ""); if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (d.length >= 8 && d.length <= 15 ? "+" + d : null); };
const cleanEmail = e => { e = e.toLowerCase().replace(/[.,;:)]+$/, ""); return /\.(png|jpe?g|gif|svg|webp)$/.test(e) || BAD.some(b => e.includes(b)) ? null : e; };

export function extract(html) {
  const o = { emails: new Set(), phones: new Set(), tel: new Set(), direct: new Set(), owners: [], social: {} };
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const h = m[1];
    if (h.startsWith("mailto:")) { const e = cleanEmail(decodeURIComponent(h.slice(7).split("?")[0])); if (e) o.emails.add(e); }
    else if (h.startsWith("tel:")) { const p = normPhone(decodeURIComponent(h.slice(4))); if (p) o.tel.add(p); }
    else for (const [k, d] of [["linkedin", "linkedin.com"], ["facebook", "facebook.com"], ["instagram", "instagram.com"]])
      if (h.includes(d) && !o.social[k] && !/share|sharer/.test(h)) o.social[k] = h;
  }
  for (const m of html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    for (const x of (Array.isArray(d) ? d : d["@graph"] || [d])) {
      if (!x || typeof x !== "object") continue;
      for (const f of [].concat(x.founder || x.owner || [])) { const n = typeof f === "string" ? f : f && f.name; if (n && new RegExp(`^${NAME}$`).test(n)) o.owners.push([n, "Founder/Owner", "high"]); }
      if (x["@type"] === "Person" && x.jobTitle && new RegExp(ROLES, "i").test(x.jobTitle) && new RegExp(`^${NAME}$`).test(x.name || "")) o.owners.push([x.name, x.jobTitle, "high"]);
    }
  }
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "").replace(/<\/(p|div|li|h\d|tr|td|section|address)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?64;/g, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".").replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@");
  for (const e of text.match(EMAIL) || []) { const c = cleanEmail(e); if (c) o.emails.add(c); }
  for (let line of text.split("\n")) {
    line = line.replace(/\s+/g, " ").trim(); if (!line || line.length > 300) continue;
    for (const m of line.matchAll(new RegExp(`(${NAME})\\s*[,\\-–|:()]\\s*(${ROLES})`, "g"))) o.owners.push([m[1], m[2], "medium"]);
    for (const m of line.matchAll(new RegExp(`(${ROLES})\\s*[:\\-–|]\\s*(${NAME})`, "g"))) o.owners.push([m[2], m[1], "medium"]);
    for (const m of line.matchAll(new RegExp(`(?:Owned|Founded|Run|Led)\\s+by\\s+(${NAME})`, "g"))) o.owners.push([m[1], "Owner/Founder", "medium"]);
    const ph = (line.match(PHONE) || []).map(normPhone).filter(Boolean);
    ph.forEach(p => o.phones.add(p));
    if (/direct|cell|mobile/i.test(line)) ph.forEach(p => o.direct.add(p));
  }
  return o;
}

export function summarize(agg, dom, knownPhone, checked) {
  const emails = [...agg.emails].sort((a, b) => (a.includes(dom) ? 0 : 1) - (b.includes(dom) ? 0 : 1));
  const loc = e => e.split("@")[0];
  const sales = emails.filter(e => SALES.some(s => loc(e).includes(s)));
  const gen = emails.filter(e => !sales.includes(e) && GENERIC.some(g => loc(e).startsWith(g)));
  let pers = emails.filter(e => !sales.includes(e) && !gen.includes(e));
  const cnt = {}; agg.owners.forEach(o => { const k = o.join("|"); cnt[k] = (cnt[k] || 0) + 1; });
  const owner = agg.owners.slice().sort((a, b) => (b[2] === "high") - (a[2] === "high") || cnt[b.join("|")] - cnt[a.join("|")])[0];
  let ownerEmail = "";
  if (owner) {
    const p = owner[0].toLowerCase().split(" "), fn = p[0], ln = p[p.length - 1];
    ownerEmail = pers.find(e => loc(e).includes(fn) || loc(e).includes(ln) || loc(e) === fn[0] + ln) || "";
    pers = pers.filter(e => e !== ownerEmail);
  }
  const company = normPhone(knownPhone || "") || [...agg.tel][0] || "";
  const direct = [...agg.direct].filter(p => p !== company);
  const others = [...agg.phones, ...agg.tel].filter((p, i, a) => a.indexOf(p) === i && p !== company && !direct.includes(p));
  return { ownerName: owner ? owner[0] : "", ownerRole: owner ? owner[1] : "", ownerEmail, salesEmail: sales.slice(0, 3).join("; "), generalEmail: gen.slice(0, 2).join("; "),
    otherEmails: pers.slice(0, 4).join("; "), companyPhone: company, directPhone: direct.slice(0, 2).join("; "), otherPhones: others.slice(0, 3).join("; "),
    linkedin: agg.social.linkedin || "", facebook: agg.social.facebook || "", instagram: agg.social.instagram || "", pages: checked.join(" "),
    confidence: !checked.length ? "Site unreachable" : owner && owner[2] === "high" ? "High" : owner || emails.length ? "Medium" : "Low" };
}

const okHost = h => !/^(localhost|.*\.local|.*\.internal)$/i.test(h) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !h.includes(":") && h.includes(".");
async function robotsAllows(base, path) {
  try {
    const t = await (await fetch(base + "/robots.txt", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) })).text();
    let star = false; const dis = [];
    for (const l of t.split("\n")) { const m = l.split("#")[0].trim().match(/^(user-agent|disallow)\s*:\s*(.*)$/i); if (!m) continue;
      if (/user-agent/i.test(m[1])) star = m[2].trim() === "*"; else if (star && m[2].trim()) dis.push(m[2].trim()); }
    return !dis.some(d => path.startsWith(d));
  } catch { return true; }
}

async function enrich(site, phone) {
  const u = new URL(site); const base = u.origin, dom = u.hostname.replace(/^www\./, "");
  const agg = { emails: new Set(), phones: new Set(), tel: new Set(), direct: new Set(), owners: [], social: {} }, checked = [];
  for (const p of PAGES) {
    if (!(await robotsAllows(base, p))) continue;
    try {
      const r = await fetch(base + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), redirect: "follow" });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) continue;
      const x = extract((await r.text()).slice(0, 400000)); checked.push(p);
      ["emails", "phones", "tel", "direct"].forEach(k => x[k].forEach(v => agg[k].add(v)));
      agg.owners.push(...x.owners); for (const k in x.social) agg.social[k] ||= x.social[k];
    } catch {}
  }
  return summarize(agg, dom, phone, checked);
}

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Headers": "x-token,content-type", "Access-Control-Allow-Methods": "GET,OPTIONS", "Content-Type": "application/json" };
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (env.ACCESS_TOKEN && req.headers.get("x-token") !== env.ACCESS_TOKEN) return out({ error: "Invalid access token" }, 401);
    const url = new URL(req.url);
    if (url.pathname === "/maps") {
      if (!env.SERPER_KEY) return out({ error: "SERPER_KEY not set on worker" }, 500);
      const r = await fetch("https://google.serper.dev/maps", { method: "POST", headers: { "X-API-KEY": env.SERPER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: url.searchParams.get("q") || "", page: +url.searchParams.get("page") || 1 }) });
      return new Response(await r.text(), { status: r.status, headers: cors });
    }
    if (url.pathname === "/enrich") {
      let t; try { t = new URL(url.searchParams.get("url")); } catch { return out({ error: "Bad url" }, 400); }
      if (!/^https?:$/.test(t.protocol) || !okHost(t.hostname)) return out({ error: "URL not allowed" }, 400);
      return out(await enrich(t.href, url.searchParams.get("phone")));
    }
    return out({ ok: true, routes: ["/maps?q=&page=", "/enrich?url=&phone="] });
  }
};
