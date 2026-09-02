// Daily cron: pulls AI Cohort waitlist signups from Typeform and adds any new
// ones as rows in the Notion "AI Cohort Waitlist — Signups" database. Powers
// the "AI Cohort Waitlist" dashboard in Notion. Runs at 11:00 UTC (7am ET) per
// vercel.json so the team sees fresh signups on their morning check.
//
// Form "SheFi AI Cohort Waitlist" (h9XCDqjk) has 3 questions:
//   - a contact_info block (first name, last name, email, phone)
//   - "What is the nearest major city to you?"  (long text)  -> City
//   - "What country do you reside in?"          (dropdown)   -> Country
// One Notion row per person, deduped by email, never overwritten.
//
// Required env vars:
//   TYPEFORM_TOKEN   — Typeform personal access token (already set in Vercel)
//   NOTION_TOKEN     — Notion internal integration secret (the integration must
//                      be connected to the "AI Cohort Waitlist" page in Notion)
// Optional env vars:
//   WAITLIST_FORM_ID — Typeform form id (defaults to the AI cohort waitlist)
//   WAITLIST_DB_ID   — Notion database id (defaults to the one created for this)
//   CRON_SECRET      — if set, requires `Authorization: Bearer <secret>`.
//                      Vercel cron auto-attaches this on scheduled runs.
//
// Manual triggers (open in a browser tab on the deployed site):
//   ?probe=fields    — inspect the form's fields + a masked sample response
//                      (read-only, no Notion writes)
//   ?debug_run=once  — run the sync now, bypassing the CRON_SECRET auth check
//   &limit=N         — (with debug_run) only create up to N new rows — use for
//                      a small test batch before importing everyone

export const maxDuration = 300; // 5 minutes

const TYPEFORM_TOKEN = process.env.TYPEFORM_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

const WAITLIST_FORM_ID = process.env.WAITLIST_FORM_ID || "h9XCDqjk";
const WAITLIST_DB_ID = process.env.WAITLIST_DB_ID || "903513cbed6d43b2a9b2ca9bfbb852ad";

// Field ids from the form definition (see ?probe=fields).
const CITY_FIELD_ID = "YkXpDZ0RezNA"; // "What is the nearest major city to you?"
const COUNTRY_FIELD_ID = "hZ5NsBpI5Btj"; // "What country do you reside in?"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Typeform ----------

async function typeformGet(path) {
  const res = await fetch(`https://api.typeform.com${path}`, {
    headers: { Authorization: `Bearer ${TYPEFORM_TOKEN}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Typeform ${path} ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// Walk every page of completed responses (1000/request). No `since` cutoff —
// we want the full waitlist, not just recent signups.
async function fetchAllCompleted(formId) {
  const items = [];
  let before = null;
  while (true) {
    const params = new URLSearchParams({ page_size: "1000", completed: "true" });
    if (before) params.set("before", before);
    const data = await typeformGet(`/forms/${formId}/responses?${params}`);
    const page = data.items || [];
    if (page.length === 0) break;
    items.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1]?.token;
    if (!before) break;
  }
  return items;
}

function answerValue(a) {
  switch (a.type) {
    case "text": return a.text || null;
    case "email": return a.email || null;
    case "choice": return a.choice?.label || a.choice?.other || null;
    case "choices": return (a.choices?.labels || []).join(", ") || null;
    case "number": return a.number != null ? String(a.number) : null;
    case "boolean": return a.boolean ? "Yes" : "No";
    case "date": return a.date || null;
    case "phone_number": return a.phone_number || null;
    case "url": return a.url || null;
    default: return null;
  }
}

// Prettify an email local-part into a display name when no name was collected.
function nameFromEmail(email) {
  const local = (email || "").split("@")[0] || "";
  const words = local.replace(/[._\-0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "(unnamed)";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Pull the fields we care about out of one Typeform response. Handles the
// contact_info block whether Typeform returns it as a single object or as
// separate sub-answers (email / text name parts / phone).
function extractPerson(item) {
  const answers = item.answers || [];
  let email = null, firstName = null, lastName = null, company = null, city = null, country = null;
  const looseText = [];
  const details = [];

  for (const a of answers) {
    const fid = a.field?.id;

    // Composite contact_info object form (first name, last name, email, company).
    if (a.type === "contact_info" && a.contact_info) {
      const ci = a.contact_info;
      firstName = firstName || ci.first_name || null;
      lastName = lastName || ci.last_name || null;
      email = email || ((ci.email || "").trim().toLowerCase() || null);
      company = company || ci.company || null;
      continue;
    }

    // The two standalone location questions, matched by field id.
    if (fid === CITY_FIELD_ID) { city = answerValue(a); continue; }
    if (fid === COUNTRY_FIELD_ID) { country = answerValue(a); continue; }

    // contact_info returned as separate sub-answers.
    if (a.type === "email") { email = email || (a.email || "").trim().toLowerCase(); continue; }
    if (a.type === "text" || a.type === "short_text") { if (a.text) looseText.push(a.text.trim()); continue; }

    // Anything else we didn't expect — keep it so nothing is silently lost.
    const val = answerValue(a);
    if (val) details.push(val);
  }

  // Loose text answers (not city/country) are the contact_info sub-answers,
  // in form order: first name, last name, then "where you work".
  if (!firstName && looseText[0]) firstName = looseText[0];
  if (!lastName && looseText[1]) lastName = looseText[1];
  if (!company && looseText[2]) company = looseText[2];

  // Email fallback: hidden fields, or any text that looks like an email.
  if (!email) {
    const hidden = item.hidden || {};
    for (const k of Object.keys(hidden)) {
      const v = String(hidden[k] || "").trim().toLowerCase();
      if (v.includes("@") && v.includes(".")) { email = v; break; }
    }
  }

  const name = [firstName, lastName].filter(Boolean).join(" ").trim() ||
    (email ? nameFromEmail(email) : "(unnamed)");

  return {
    email,
    name,
    firstName,
    lastName,
    company,
    city,
    country,
    details: details.join(" · ").slice(0, 2000),
    signedUp: (item.submitted_at || "").slice(0, 10) || null,
    responseId: item.response_id || item.token || "",
  };
}

// Build one record per email (earliest submission is the canonical entry).
function aggregateSignups(items) {
  const out = new Map();
  for (const item of items) {
    const p = extractPerson(item);
    if (!p.email) continue;
    const existing = out.get(p.email);
    if (!existing || (p.signedUp && p.signedUp < existing.signedUp)) {
      out.set(p.email, p);
    }
  }
  return out;
}

// ---------- Notion ----------

async function notionApi(path, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
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

async function fetchExistingEmails() {
  const emails = new Set();
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionApi(`/databases/${WAITLIST_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const page of data.results || []) {
      const p = page.properties?.Email;
      if (p?.type === "email" && p.email) emails.add(p.email.trim().toLowerCase());
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return emails;
}

function richText(value) {
  if (!value) return { rich_text: [] };
  return { rich_text: [{ type: "text", text: { content: String(value).slice(0, 2000) } }] };
}

function title(value) {
  const v = value && String(value).trim() ? String(value) : "(unnamed)";
  return { title: [{ type: "text", text: { content: v.slice(0, 200) } }] };
}

async function createSignup(sig) {
  const properties = {
    Name: title(sig.name),
    Email: { email: sig.email },
    "First name": richText(sig.firstName),
    "Last name": richText(sig.lastName),
    "Where you work": richText(sig.company),
    City: richText(sig.city),
    "Response ID": richText(sig.responseId),
    Details: richText(sig.details),
  };
  if (sig.country) properties.Country = { select: { name: String(sig.country).slice(0, 100) } };
  if (sig.signedUp) properties["Signed Up"] = { date: { start: sig.signedUp } };
  return notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: WAITLIST_DB_ID }, properties }),
  });
}

// ---------- Handler ----------

// Mask a value so a probe sample can be shared without exposing full PII.
function mask(v) {
  const s = String(v ?? "");
  if (!s) return "";
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${u.slice(0, 2)}***@${d || ""}`;
  }
  return s.length <= 2 ? "**" : `${s.slice(0, 2)}***`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  const isProbe = url.searchParams.get("probe") === "fields";
  const isDebugRun = url.searchParams.get("debug_run") === "once";
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : null;

  // Probe: read-only. Returns the form schema plus a masked sample of the most
  // recent response so the answer shape can be confirmed. No Notion writes.
  if (isProbe) {
    if (!TYPEFORM_TOKEN) {
      return res.status(500).json({ error: "Missing env var", missing: { TYPEFORM_TOKEN: true } });
    }
    try {
      const form = await typeformGet(`/forms/${WAITLIST_FORM_ID}`);
      const fields = (form.fields || []).flatMap((f) =>
        f.type === "group" && f.properties?.fields ? f.properties.fields : [f]
      ).map((f) => ({ id: f.id, ref: f.ref, type: f.type, title: f.title }));

      let sampleAnswers = null;
      let sampleExtract = null;
      const latest = await typeformGet(`/forms/${WAITLIST_FORM_ID}/responses?page_size=1&completed=true`);
      const item = (latest.items || [])[0];
      if (item) {
        sampleAnswers = (item.answers || []).map((a) => ({
          field_id: a.field?.id,
          field_type: a.field?.type,
          answer_type: a.type,
          value_keys: a.contact_info ? Object.keys(a.contact_info) : undefined,
          preview: a.contact_info
            ? Object.fromEntries(Object.entries(a.contact_info).map(([k, v]) => [k, mask(v)]))
            : mask(answerValue(a)),
        }));
        const p = extractPerson(item);
        sampleExtract = {
          name: p.name, firstName: mask(p.firstName), lastName: mask(p.lastName),
          email: mask(p.email), workplace: p.company, city: p.city, country: p.country,
        };
      }

      return res.status(200).json({
        formId: WAITLIST_FORM_ID, formTitle: form.title, fieldCount: fields.length,
        fields, sampleAnswers, sampleExtract,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e).slice(0, 500) });
    }
  }

  if (CRON_SECRET && !isDebugRun) {
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const missing = { TYPEFORM_TOKEN: !TYPEFORM_TOKEN, NOTION_TOKEN: !NOTION_TOKEN };
  if (missing.TYPEFORM_TOKEN || missing.NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  const startedAt = new Date().toISOString();
  const summary = {
    startedAt, typeformResponses: 0, uniqueSignups: 0,
    alreadyInNotion: 0, rowsCreated: 0, limit, errors: [],
  };

  try {
    const items = await fetchAllCompleted(WAITLIST_FORM_ID);
    summary.typeformResponses = items.length;

    const signups = aggregateSignups(items);
    summary.uniqueSignups = signups.size;

    const existing = await fetchExistingEmails();

    for (const sig of signups.values()) {
      if (existing.has(sig.email)) { summary.alreadyInNotion++; continue; }
      if (limit && summary.rowsCreated >= limit) break;
      try {
        await createSignup(sig);
        summary.rowsCreated++;
        await sleep(350); // Notion rate limit ~3 req/s
      } catch (e) {
        summary.errors.push({ email: sig.email, error: String(e).slice(0, 200) });
      }
    }

    const endedAt = new Date().toISOString();
    return res.status(200).json({ ...summary, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) });
  } catch (e) {
    summary.errors.push({ fatal: String(e).slice(0, 300) });
    return res.status(500).json(summary);
  }
}
