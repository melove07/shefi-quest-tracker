// One-off importer for the "AI Will Survive" (Oct 29) campaign.
//
// Reads the Notion "AI Will Survive Oct 29 — Beehiiv Audience" database and, for
// each row, creates/upserts the subscriber in Beehiiv and applies the campaign
// tag(s). It NEVER sends an email: welcome email off, double opt-in overridden
// off, and it does NOT enroll anyone in any automation (so nobody gets the old
// diagnostic survey). Safe to run repeatedly — Beehiiv upserts by email and tags
// are additive.
//
// Tag mapping (derived from the Notion row):
//   Beehiiv Tag = "AI101_OCT29_INVITE"  -> ai101_oct29_invite        (waitlist-origin)
//                                           ai101_oct29_invite_fb     (Source has no "Waitlist" -> alt opening)
//   Beehiiv Tag = "AI201_ALUMNI_REFERRAL"-> ai201_alumni_referral
//   (blank Beehiiv Tag = the review rows -> skipped)
//   + ai201_future_interest when the "AI201 Future Interest" checkbox is set
//
// Required env vars (already in Vercel):
//   BEEHIIV_API_KEY, NOTION_TOKEN
// Optional:
//   BEEHIIV_PUBLICATION_ID (defaults to SheFi), AUDIENCE_DB_ID (defaults below),
//   CRON_SECRET / access pass (required as ?token= or Bearer)
//
// Usage (just open the link in a browser tab):
//   /api/import-ai-will-survive?token=PASS            -> self-driving progress page (runs the whole import in small batches)
//   /api/import-ai-will-survive?token=PASS&dry_run=1  -> preview counts only, no writes (JSON)
//
// Advanced (the progress page calls these for you):
//   &format=json&offset=N&limit=100   -> process one batch, return JSON {done,next_offset,summary}

export const maxDuration = 300;
const TIME_BUDGET_MS = 45000; // keep each batch well under any gateway timeout

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || "";
const ACCESS_PASS = "shefi-aiws-7h2k9x";
const PUB = process.env.BEEHIIV_PUBLICATION_ID || "pub_ec2337ac-661e-4df4-9ea6-7a9ba492912e";
const AUDIENCE_DB_ID = process.env.AUDIENCE_DB_ID || "b4adbb8dd74d4d1a80efd31734cbc17d";
const NOTION_VERSION = "2022-06-28";
const CONCURRENCY = Math.min(Math.max(parseInt(process.env.IMPORT_CONCURRENCY || "5", 10) || 5, 1), 10);
const BATCH = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authed(req) {
  const q = req.query || {};
  const token = q.token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token === ACCESS_PASS) return true;
  if (CRON_SECRET && token === CRON_SECRET) return true;
  return false;
}

async function fetchRetry(url, opts = {}) {
  const MAX = 5;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (attempt >= MAX) throw e;
      await sleep(Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250);
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= MAX) return res;
    const ra = parseFloat(res.headers.get("retry-after") || "");
    await sleep((Number.isFinite(ra) ? Math.min(ra * 1000, 15000) : Math.min(500 * 2 ** attempt, 8000)) + Math.random() * 250);
  }
}

async function beehiiv(path, opts = {}) {
  const res = await fetchRetry(`https://api.beehiiv.com/v2${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${BEEHIIV_API_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

async function notion(path, opts = {}) {
  const res = await fetchRetry(`https://api.notion.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`Notion ${path} ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

const txt = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text || "").join("") : "");

function tagsForRow(props) {
  const select = props["Beehiiv Tag"]?.select?.name || "";
  const source = txt(props["Source"]?.rich_text);
  const future = !!props["AI201 Future Interest"]?.checkbox;
  let primary = null;
  if (select === "AI101_OCT29_INVITE") primary = /waitlist/i.test(source) ? "ai101_oct29_invite" : "ai101_oct29_invite_fb";
  else if (select === "AI201_ALUMNI_REFERRAL") primary = "ai201_alumni_referral";
  if (!primary) return null; // review rows (no tag) -> skip
  const tags = [primary];
  if (future) tags.push("ai201_future_interest");
  return tags;
}

async function readAudience() {
  const rows = [];
  let cursor;
  do {
    const body = await notion(`/databases/${AUDIENCE_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const page of body.results || []) {
      const p = page.properties || {};
      const email = (p["Email"]?.email || "").trim().toLowerCase();
      const name = txt(p["Name"]?.title).trim();
      const tags = tagsForRow(p);
      if (!email || !tags) continue;
      if (email.endsWith("@shefi.org") || email.includes("shefigmailsample") || email === "test-import@example.com") continue;
      const [first, ...rest] = name.split(/\s+/);
      rows.push({ email, first: first || "", last: rest.join(" "), tags });
    }
    cursor = body.has_more ? body.next_cursor : null;
  } while (cursor);
  // de-dup by email (keep first); stable order so offset paging is deterministic
  const seen = new Set();
  const uniq = rows.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
  uniq.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return uniq;
}

async function findSubId(email) {
  const r = await beehiiv(`/publications/${PUB}/subscriptions?email=${encodeURIComponent(email)}`);
  if (r.ok && Array.isArray(r.body?.data)) {
    for (const d of r.body.data) if ((d.email || "").trim().toLowerCase() === email) return d.id;
  }
  return null;
}

async function processOne(row) {
  const rec = { email: row.email, action: "", tags: row.tags.join("|"), result: "" };
  let subId = await findSubId(row.email);
  if (subId) {
    rec.action = "existing";
  } else {
    const c = await beehiiv(`/publications/${PUB}/subscriptions`, {
      method: "POST",
      body: JSON.stringify({
        email: row.email,
        send_welcome_email: false,
        reactivate_existing: false,
        double_opt_override: "off",
        custom_fields: [
          { name: "First Name", value: row.first },
          { name: "Last Name", value: row.last },
        ],
      }),
    });
    subId = c.body?.data?.id || null;
    if (!subId) subId = await findSubId(row.email); // created-but-race or already existed
    if (!subId) { rec.action = "create_failed"; rec.result = `${c.status}:${JSON.stringify(c.body).slice(0, 160)}`; return rec; }
    rec.action = "created";
  }
  const t = await beehiiv(`/publications/${PUB}/subscriptions/${subId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: row.tags }),
  });
  rec.result = t.ok ? "tagged_ok" : `tag_fail ${t.status}:${JSON.stringify(t.body).slice(0, 160)}`;
  return rec;
}

function progressPage(token) {
  const t = JSON.stringify(token);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Will Survive — Import</title>
<style>
  :root{--bg:#0f1020;--card:#1a1b36;--ink:#f4f4fb;--mut:#a9abce;--ok:#3ddc97;--bar:#6c7bff;--err:#ff6b6b;--track:#2a2c52}
  @media (prefers-color-scheme:light){:root{--bg:#f5f6fc;--card:#fff;--ink:#16173a;--mut:#5b5d82;--track:#e6e7f4}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
  .wrap{max-width:560px;margin:24px auto}
  .card{background:var(--card);border-radius:18px;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,.15)}
  h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);font-size:14px;margin:0 0 20px}
  .track{height:14px;border-radius:999px;background:var(--track);overflow:hidden;margin:18px 0 8px}
  .fill{height:100%;width:0;background:var(--bar);border-radius:999px;transition:width .4s ease}
  .pct{font-size:28px;font-weight:700;letter-spacing:-.5px}.count{color:var(--mut);font-size:14px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
  .stat{background:rgba(127,127,170,.08);border-radius:12px;padding:12px 14px}
  .stat b{display:block;font-size:22px}.stat span{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  .status{margin-top:18px;padding:12px 14px;border-radius:12px;background:rgba(108,123,255,.12);font-size:14px}
  .status.done{background:rgba(61,220,151,.14);color:var(--ok)}.status.err{background:rgba(255,107,107,.14);color:var(--err)}
  .btn{display:inline-block;margin-top:16px;padding:12px 18px;border:0;border-radius:12px;background:var(--bar);color:#fff;font-weight:600;font-size:15px;cursor:pointer}
  .btn[disabled]{opacity:.5;cursor:default}.spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:s 1s linear infinite;vertical-align:-2px;margin-right:8px}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap"><div class="card">
<h1>AI Will Survive — audience import</h1>
<p class="sub">Creates &amp; tags subscribers in beehiiv. No emails are sent. Safe to re-run.</p>
<div class="pct" id="pct">0%</div><div class="count" id="count">Ready to start.</div>
<div class="track"><div class="fill" id="fill"></div></div>
<div class="grid">
  <div class="stat"><b id="s-created">0</b><span>created</span></div>
  <div class="stat"><b id="s-existing">0</b><span>already there</span></div>
  <div class="stat"><b id="s-tagged">0</b><span>tagged OK</span></div>
  <div class="stat"><b id="s-fail">0</b><span>failures</span></div>
</div>
<div class="status" id="status">Click Start to begin. Keep this tab open until it says Done.</div>
<button class="btn" id="go">Start import</button>
</div></div>
<script>
const TOKEN=${t};
let off=0,total=0,running=false;
const sum={created:0,existing:0,create_failed:0,error:0,tagged_ok:0,failures:0};
const $=(id)=>document.getElementById(id);
function paint(){
  const pct=total?Math.round(off/total*100):0;
  $("pct").textContent=pct+"%";$("fill").style.width=pct+"%";
  $("count").textContent=total?(off+" / "+total+" processed"):"";
  $("s-created").textContent=sum.created;$("s-existing").textContent=sum.existing;
  $("s-tagged").textContent=sum.tagged_ok;$("s-fail").textContent=(sum.failures+sum.create_failed+sum.error);
}
async function step(){
  const u="?token="+encodeURIComponent(TOKEN)+"&format=json&offset="+off+"&limit=${BATCH}";
  const r=await fetch(u,{cache:"no-store"});
  const j=await r.json();
  if(j.error){throw new Error(j.error);}
  total=j.total;
  const s=j.summary||{};
  for(const k of ["created","existing","create_failed","error","tagged_ok","failures"]) sum[k]+=(s[k]||0);
  off=j.next_offset;
  paint();
  return j.done;
}
async function run(){
  if(running)return;running=true;
  $("go").disabled=true;$("status").className="status";
  $("status").innerHTML='<span class="spin"></span>Importing… keep this tab open.';
  try{
    let done=false;
    while(!done){done=await step();}
    $("status").className="status done";
    $("status").textContent="✓ Done — all "+total+" processed. You can close this tab. Tell Claude it finished.";
  }catch(e){
    $("status").className="status err";
    $("status").textContent="Hit an error: "+e.message+" — tap Start again to resume where it left off.";
    $("go").disabled=false;running=false;
  }
}
$("go").addEventListener("click",run);
</script></body></html>`;
}

export default async function handler(req, res) {
  try {
    if (!BEEHIIV_API_KEY || !NOTION_TOKEN) return res.status(500).json({ error: "Missing BEEHIIV_API_KEY or NOTION_TOKEN" });
    if (!authed(req)) return res.status(401).json({ error: "Unauthorized" });

    const q = req.query || {};

    // Default: serve the self-driving progress page (unless JSON output is requested).
    if (!q.dry_run && q.format !== "json") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(progressPage(q.token || ""));
    }

    const rows = await readAudience();
    const total = rows.length;

    if (q.dry_run) {
      const byTag = {};
      for (const r of rows) for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1;
      return res.status(200).json({ dry_run: true, total, tag_counts: byTag, sample: rows.slice(0, 3) });
    }

    // JSON batch mode: process rows[offset, offset+limit] within the time budget.
    const offset = Math.max(parseInt(q.offset || "0", 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(q.limit || String(BATCH), 10) || BATCH, 1), 200);
    const end = Math.min(offset + limit, total);
    const slice = rows.slice(offset, end);

    const start = Date.now();
    const results = [];
    let i = 0;
    async function worker() {
      while (i < slice.length) {
        if (Date.now() - start > TIME_BUDGET_MS) return;
        const idx = i++;
        try { results.push(await processOne(slice[idx])); }
        catch (e) { results.push({ email: slice[idx].email, action: "error", result: String(e).slice(0, 160) }); }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const summary = {};
    for (const r of results) {
      summary[r.action] = (summary[r.action] || 0) + 1;
      if (r.result === "tagged_ok") summary.tagged_ok = (summary.tagged_ok || 0) + 1;
      else if (r.result) summary.failures = (summary.failures || 0) + 1;
    }
    const nextOffset = offset + results.length;
    const done = nextOffset >= total;
    const failures = results.filter((r) => r.result && r.result !== "tagged_ok").slice(0, 25);
    return res.status(200).json({ ok: true, total, offset, processed: results.length, next_offset: nextOffset, done, summary, failures });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
