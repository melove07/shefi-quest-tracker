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
//   CRON_SECRET (if set, required as ?token= or Bearer)
//
// Trigger in a browser tab on the deployed site:
//   /api/import-ai-will-survive?token=YOUR_CRON_SECRET&dry_run=1   (preview: counts only, no writes)
//   /api/import-ai-will-survive?token=YOUR_CRON_SECRET             (run it)
//   &limit=N   process only the first N rows (staged runs)

export const maxDuration = 300;
const TIME_BUDGET_MS = 270000;

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || "";
const PUB = process.env.BEEHIIV_PUBLICATION_ID || "pub_ec2337ac-661e-4df4-9ea6-7a9ba492912e";
const AUDIENCE_DB_ID = process.env.AUDIENCE_DB_ID || "b4adbb8dd74d4d1a80efd31734cbc17d";
const NOTION_VERSION = "2022-06-28";
const CONCURRENCY = Math.min(Math.max(parseInt(process.env.IMPORT_CONCURRENCY || "5", 10) || 5, 1), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // de-dup by email (keep first)
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
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

export default async function handler(req, res) {
  try {
    if (!BEEHIIV_API_KEY || !NOTION_TOKEN) return res.status(500).json({ error: "Missing BEEHIIV_API_KEY or NOTION_TOKEN" });
    const q = req.query || {};
    const token = q.token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (CRON_SECRET && token !== CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });

    let rows = await readAudience();
    const limit = parseInt(q.limit || "0", 10);
    if (limit > 0) rows = rows.slice(0, limit);

    if (q.dry_run) {
      const byTag = {};
      for (const r of rows) for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1;
      return res.status(200).json({ dry_run: true, total: rows.length, tag_counts: byTag, sample: rows.slice(0, 3) });
    }

    const start = Date.now();
    const results = [];
    let i = 0;
    async function worker() {
      while (i < rows.length) {
        if (Date.now() - start > TIME_BUDGET_MS) return;
        const idx = i++;
        try { results.push(await processOne(rows[idx])); }
        catch (e) { results.push({ email: rows[idx].email, action: "error", result: String(e).slice(0, 160) }); }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const summary = { total_rows: rows.length, processed: results.length };
    for (const r of results) {
      summary[r.action] = (summary[r.action] || 0) + 1;
      if (r.result && r.result !== "tagged_ok") summary.failures = (summary.failures || 0) + 1;
    }
    const failures = results.filter((r) => r.result && r.result !== "tagged_ok").slice(0, 25);
    const done = results.length === rows.length;
    return res.status(200).json({ ok: true, done, summary, failures });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
