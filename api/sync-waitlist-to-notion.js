// Daily cron: pulls AI Cohort waitlist signups from Typeform and adds any new
// ones as rows in the Notion "AI Cohort Waitlist — Signups" database. Powers
// the "AI Cohort Waitlist" dashboard in Notion. Runs at 11:00 UTC (7am ET) per
// vercel.json so the team sees fresh signups on their morning check.
//
// This is the same Typeform->Notion pattern as sync-typeform-to-notion.js and
// sync-applications-to-notion.js, but for a single low-friction waitlist form:
// one Notion row per person, deduped by email, never overwritten.
//
// Required env vars:
//   TYPEFORM_TOKEN   — Typeform personal access token (already set in Vercel)
//   NOTION_TOKEN     — Notion internal integration secret (shared with the
//                      other syncs — the integration must be connected to the
//                      "AI Cohort Waitlist" page in Notion)
// Optional env vars:
//   WAITLIST_FORM_ID — Typeform form id (defaults to the AI cohort waitlist)
//   WAITLIST_DB_ID   — Notion database id (defaults to the one created for this)
//   CRON_SECRET      — if set, requires `Authorization: Bearer <secret>`.
//                      Vercel cron auto-attaches this on scheduled runs.
//
// Manual triggers (open in a browser tab on the deployed site):
//   /api/sync-waitlist-to-notion?probe=fields   — inspect the form's fields
//                                                  (read-only, no Notion writes)
//   /api/sync-waitlist-to-notion?debug_run=once  — run the sync now, bypassing
//                                                  the CRON_SECRET auth check

export const maxDuration = 300; // 5 minutes

const TYPEFORM_TOKEN = process.env.TYPEFORM_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

// AI Cohort waitlist form + the Notion DB created for this dashboard. Both can
// be overridden with env vars, but the defaults are wired so the only secret
// that must be configured is NOTION_TOKEN.
const WAITLIST_FORM_ID = process.env.WAITLIST_FORM_ID || "h9XCDqjk";
const WAITLIST_DB_ID = process.env.WAITLIST_DB_ID || "903513cbed6d43b2a9b2ca9bfbb852ad";

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

// Flatten a form definition's fields, unnesting any group questions.
function flattenFields(formDef) {
  return (formDef.fields || []).flatMap((f) =>
    f.type === "group" && f.properties?.fields ? f.properties.fields : [f]
  );
}

function extractEmail(item) {
  for (const a of item.answers || []) {
    if (a.type === "email") return (a.email || "").trim().toLowerCase();
  }
  // Fall back to hidden fields or any text answer that looks like an email.
  const hidden = item.hidden || {};
  for (const k of Object.keys(hidden)) {
    const v = String(hidden[k] || "").trim().toLowerCase();
    if (v.includes("@") && v.includes(".")) return v;
  }
  for (const a of item.answers || []) {
    if (a.type === "text" && a.text && a.text.includes("@")) {
      return a.text.trim().toLowerCase();
    }
  }
  return null;
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

// Prettify an email local-part into a display name when the form has no name
// field: "jane.doe88@x.com" -> "Jane Doe".
function nameFromEmail(email) {
  const local = (email || "").split("@")[0] || "";
  const words = local.replace(/[._\-0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "(unnamed)";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Figure out which field ids hold the person's name, so we can build a clean
// "Name" and keep those questions out of the free-text "Details" column.
function resolveNameFields(fields) {
  const byPattern = (rx, types) =>
    fields.find(
      (f) => (!types || types.includes(f.type)) && rx.test((f.title || "").trim())
    )?.id || null;
  return {
    firstId: byPattern(/first name/i, ["short_text", "text"]),
    lastId: byPattern(/last name/i, ["short_text", "text"]),
    fullId:
      byPattern(/full name|your name|^name$/i, ["short_text", "text"]) ||
      byPattern(/name/i, ["short_text", "text"]),
  };
}

// Build one signup record per email (earliest submission wins), collecting a
// display name and a "Details" string of any other answers.
function aggregateSignups(items, formDef) {
  const fields = flattenFields(formDef);
  const titleById = Object.fromEntries(fields.map((f) => [f.id, (f.title || "").trim()]));
  const { firstId, lastId, fullId } = resolveNameFields(fields);
  const nameIds = new Set([firstId, lastId, fullId].filter(Boolean));

  const out = new Map();
  for (const item of items) {
    const email = extractEmail(item);
    if (!email) continue;

    const answers = item.answers || [];
    const byId = {};
    for (const a of answers) if (a.field?.id) byId[a.field.id] = a;

    // Name: "First Last" if present, else a full-name field, else from email.
    const first = firstId && byId[firstId] ? answerValue(byId[firstId]) : null;
    const last = lastId && byId[lastId] ? answerValue(byId[lastId]) : null;
    let name = [first, last].filter(Boolean).join(" ").trim();
    if (!name && fullId && byId[fullId]) name = answerValue(byId[fullId]) || "";
    if (!name) name = nameFromEmail(email);

    // Details: every other answer, labeled with its question title.
    const details = [];
    for (const a of answers) {
      const id = a.field?.id;
      if (!id || nameIds.has(id) || a.type === "email") continue;
      const val = answerValue(a);
      if (!val) continue;
      const label = titleById[id] || "Answer";
      details.push(`${label}: ${val}`);
    }

    const signedUp = (item.submitted_at || "").slice(0, 10) || null;
    const record = {
      email,
      name,
      signedUp,
      details: details.join(" · ").slice(0, 2000),
      responseId: item.response_id || item.token || "",
    };

    const existing = out.get(email);
    // Keep the earliest signup as the canonical waitlist entry.
    if (!existing || (record.signedUp && record.signedUp < existing.signedUp)) {
      out.set(email, existing ? { ...record, details: existing.details || record.details } : record);
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
    "Response ID": richText(sig.responseId),
    Details: richText(sig.details),
  };
  if (sig.signedUp) properties["Signed Up"] = { date: { start: sig.signedUp } };
  return notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: WAITLIST_DB_ID }, properties }),
  });
}

// ---------- Handler ----------

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  const isProbe = url.searchParams.get("probe") === "fields";
  const isDebugRun = url.searchParams.get("debug_run") === "once";

  // Probe mode reads only the form schema (public info) — no auth, no writes.
  if (isProbe) {
    if (!TYPEFORM_TOKEN) {
      return res.status(500).json({ error: "Missing env var", missing: { TYPEFORM_TOKEN: true } });
    }
    try {
      const form = await typeformGet(`/forms/${WAITLIST_FORM_ID}`);
      const fields = flattenFields(form).map((f) => ({
        id: f.id, ref: f.ref, type: f.type, title: f.title,
      }));
      return res.status(200).json({
        formId: WAITLIST_FORM_ID,
        formTitle: form.title,
        fieldCount: fields.length,
        nameFields: resolveNameFields(flattenFields(form)),
        fields,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e).slice(0, 500) });
    }
  }

  // Cron auth. Vercel cron attaches Authorization: Bearer <CRON_SECRET>.
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
  const summary = { startedAt, typeformResponses: 0, uniqueSignups: 0, alreadyInNotion: 0, rowsCreated: 0, errors: [] };

  try {
    const form = await typeformGet(`/forms/${WAITLIST_FORM_ID}`);
    const items = await fetchAllCompleted(WAITLIST_FORM_ID);
    summary.typeformResponses = items.length;

    const signups = aggregateSignups(items, form);
    summary.uniqueSignups = signups.size;

    const existing = await fetchExistingEmails();

    for (const sig of signups.values()) {
      if (existing.has(sig.email)) {
        summary.alreadyInNotion++;
        continue;
      }
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
