// Daily cron: mirrors AI Cohort diagnostic-survey responses from Beehiiv into
// the Notion "AI Cohort — Survey Responses" database, so the answers are
// queryable alongside everything else.
//
// For each Beehiiv survey response not already in Notion (deduped by
// Subscription ID):
//   1. Read the four answers off the response (outcome / tried / confident /
//      90-day goal).
//   2. Look up the subscriber for their name, email and location.
//   3. Create one Notion row.
//
// Read-only against Beehiiv and additive against Notion (it only ever creates
// rows it doesn't already have), so it is safe to run repeatedly.
//
// Required env vars:
//   BEEHIIV_API_KEY     — Beehiiv API key (Settings -> API)
//   NOTION_TOKEN        — Notion integration secret (connected to the survey DB)
// Optional env vars:
//   BEEHIIV_PUBLICATION_ID — defaults to the SheFi publication
//   BEEHIIV_SURVEY_ID      — defaults to the "A few more about you + AI" survey
//   NOTION_SURVEY_DB_ID    — defaults to the AI Cohort Survey Responses DB
//   CRON_SECRET            — if set, scheduled runs require the bearer token.
//
// Manual trigger (open in a browser tab on the deployed site):
//   ?debug_run=once            — run now, bypassing the cron auth gate.
//   ?debug_run=once&limit=5    — create at most 5 new rows (for a smoke test).

export const maxDuration = 300; // 5 minutes
const TIME_BUDGET_MS = 270000;  // stop before the platform timeout; the rest syncs next run

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

const PUB = process.env.BEEHIIV_PUBLICATION_ID || "pub_ec2337ac-661e-4df4-9ea6-7a9ba492912e";
const SURVEY_ID = process.env.BEEHIIV_SURVEY_ID || "339d88b0-9fd6-4253-b88e-a3a8930a2f10";
const SURVEY_DB_ID = process.env.NOTION_SURVEY_DB_ID || "68951a0f9a094dd281b4a0210c430a9e";

// Survey question -> Notion column. Matched by question id (stable); the prompt
// text is a fallback in case ids ever change. Keep these in sync with the survey.
const QUESTION_MAP = [
  { id: "27d55fa0-40ef-4bc3-aad9-a7b889509369", promptIncludes: "outcome would feel most valuable", column: "Most Valuable Outcome" },
  { id: "bbf8b270-bd90-46e3-8577-26531f0e25d5", promptIncludes: "already tried", column: "Already Tried" },
  { id: "f3d49dc7-406b-4286-82f0-0f22c24b7fb3", promptIncludes: "least confident about", column: "Least Confident About" },
  { id: "4e4479f1-7eb5-47eb-b296-27262e0ffb0f", promptIncludes: "next 90 days", column: "90-Day Goal" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with automatic retry on 429 (rate limit) and 5xx (transient),
// honoring Retry-After. Safe because every request here is read-only or an
// idempotent Notion create guarded by a dedupe check.
async function fetchRetry(url, opts = {}) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      await sleep(Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250);
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= MAX_RETRIES) return res;
    const retryAfter = parseFloat(res.headers.get("retry-after") || "");
    const backoff = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, 15000)
      : Math.min(500 * 2 ** attempt, 8000);
    await sleep(backoff + Math.random() * 250);
  }
}

// ---------- Beehiiv ----------

async function beehiiv(path, opts = {}) {
  const res = await fetchRetry(`https://api.beehiiv.com/v2${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${BEEHIIV_API_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Beehiiv ${opts.method || "GET"} ${path} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Page through every survey response. Beehiiv list endpoints are page-based
// (?limit&page) and wrap rows in `data` (older) or `responses` (as the survey
// endpoint returns) — read whichever is present so we tolerate either shape.
async function fetchAllResponses() {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const body = await beehiiv(`/publications/${PUB}/surveys/${SURVEY_ID}/responses?limit=100&page=${page}`);
    const rows = body.data || body.responses || [];
    out.push(...rows);
    const totalPages = body.total_pages || body.pagination?.total_pages;
    if (rows.length === 0) break;
    if (totalPages && page >= totalPages) break;
  }
  return out;
}

function customField(sub, name) {
  const cf = (sub.custom_fields || []).find((f) => f.name === name);
  if (!cf) return "";
  const v = cf.value;
  return Array.isArray(v) ? String(v[0] || "") : String(v ?? "");
}

// Build a display name from custom fields, falling back to the email's local
// part so a nameless subscriber still gets a readable row title.
function respondentName(sub) {
  const first = customField(sub, "First Name").trim();
  const last = customField(sub, "Last Name").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  if (full && full !== ".") return full;
  const email = sub.email || "";
  return email.includes("@") ? email.split("@")[0] : email;
}

// Location is best-effort: use the flat `location` string if present, else
// assemble city/region/country. Never throws — a missing location just yields "".
function subscriberLocation(sub) {
  if (typeof sub.location === "string" && sub.location.trim()) return sub.location.trim();
  const parts = [sub.city, sub.region || sub.state, sub.country].filter((p) => typeof p === "string" && p.trim());
  return parts.join(", ");
}

async function getSubscriber(subId) {
  const body = await beehiiv(`/publications/${PUB}/subscriptions/${subId}?expand[]=custom_fields`);
  return body.data || body;
}

function answerFor(response, q) {
  const answers = response.answers || [];
  let a = answers.find((x) => x.question_id === q.id);
  if (!a) a = answers.find((x) => String(x.question_prompt || "").toLowerCase().includes(q.promptIncludes));
  return a ? String(a.answer || "").trim() : "";
}

// ---------- Notion ----------

async function notionApi(path, opts = {}) {
  const res = await fetchRetry(`https://api.notion.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${opts.method || "GET"} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Every Subscription ID already in the Notion survey DB, so we only ever add
// responses we don't already have (the dedupe key).
async function fetchExistingSubIds() {
  const ids = new Set();
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionApi(`/databases/${SURVEY_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const page of data.results || []) {
      const rt = page.properties?.["Subscription ID"]?.rich_text || [];
      const sid = rt.map((t) => t.plain_text).join("").trim();
      if (sid) ids.add(sid);
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return ids;
}

function richText(value) {
  const content = String(value || "").slice(0, 2000);
  return content ? [{ type: "text", text: { content } }] : [];
}

async function createRow(response, sub) {
  const properties = {
    "Respondent": { title: richText(respondentName(sub)) },
    "Subscription ID": { rich_text: richText(response.subscription_id) },
  };
  if (sub.email) properties["Email"] = { email: sub.email };
  const location = subscriberLocation(sub);
  if (location) properties["Location"] = { rich_text: richText(location) };
  if (response.created_at) properties["Submitted"] = { date: { start: response.created_at } };
  for (const q of QUESTION_MAP) {
    const answer = answerFor(response, q);
    if (answer) properties[q.column] = { rich_text: richText(answer) };
  }
  await notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: SURVEY_DB_ID }, properties }),
  });
}

// ---------- Handler ----------

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  const isDebugRun = url.searchParams.get("debug_run") === "once";
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : null;

  // Cron auth gate. Manual ?debug_run bypasses it.
  if (!isDebugRun && CRON_SECRET && (req.headers?.authorization || "") !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const missing = {};
  if (!BEEHIIV_API_KEY) missing.BEEHIIV_API_KEY = true;
  if (!NOTION_TOKEN) missing.NOTION_TOKEN = true;
  if (Object.keys(missing).length) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  const startedAt = Date.now();
  const summary = { startedAt: new Date(startedAt).toISOString(), responses: 0, existing: 0, created: 0, errors: [], stoppedEarly: false };

  try {
    const [responses, existing] = await Promise.all([fetchAllResponses(), fetchExistingSubIds()]);
    summary.responses = responses.length;
    summary.existing = existing.size;

    // Only responses whose subscriber isn't already a row, newest last so an
    // interrupted run makes steady forward progress.
    const pending = [];
    const seen = new Set();
    for (const r of responses) {
      const sid = r.subscription_id;
      if (!sid || existing.has(sid) || seen.has(sid)) continue;
      seen.add(sid);
      pending.push(r);
    }
    pending.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));

    for (const response of pending) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.stoppedEarly = true; break; }
      if (limit && summary.created >= limit) break;
      try {
        const sub = await getSubscriber(response.subscription_id);
        await createRow(response, sub);
        summary.created++;
      } catch (e) {
        summary.errors.push({ subscription_id: response.subscription_id, error: String(e.message || e).slice(0, 300) });
      }
    }

    const endedAt = Date.now();
    return res.status(200).json({ ...summary, endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt });
  } catch (e) {
    summary.errors.push({ fatal: String(e.message || e).slice(0, 300) });
    return res.status(500).json(summary);
  }
}
