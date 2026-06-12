// Daily cron: pulls S17 application responses (completed AND partial) from Typeform
// and upserts them into the Notion "S17 Application Pipeline" database. Runs at 09:15 UTC
// (15 min after the quest sync at 09:00 UTC) per vercel.json so we don't step on its
// Notion rate-limit budget. Electra reads the resulting DB to send application-stage
// nudges.
//
// Required env vars:
//   TYPEFORM_TOKEN        — Typeform personal access token (already set)
//   NOTION_TOKEN          — Notion internal integration secret (already set)
//   APPLICATIONS_DB_ID    — the S17 Application Pipeline DB id
//                           (fee33aaa17344a5da0cb30e53d21dfa4)
// Optional:
//   SCHOLARSHIP_FORM_ID   — Typeform ID for the scholarship form. When set,
//                           syncs scholarship completions as a second source.
//                           Leave unset until the form is live.
//   CRON_SECRET           — if set, requires `Authorization: Bearer <secret>`
//                           on the request. Vercel cron auto-attaches this.
//
// Cohort boundary: only application responses submitted on or after 2026-03-01
// count as S17. S16 started on March 17, so anything March 1+ is an applicant
// for the upcoming cohort. Earlier responses to rUUJ3931 belong to S15/S16 and
// are ignored.
//
// Probe mode: GET /api/sync-applications-to-notion?probe=fields
// returns the field schema of rUUJ3931 with which fields matched first-name /
// last-name / country / how-heard. Use this once after deploy to confirm the
// fuzzy title matching is hitting the right questions.

export const maxDuration = 300; // 5 minutes — enough for full daily sync

const TYPEFORM_TOKEN = process.env.TYPEFORM_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const APPLICATIONS_DB_ID = process.env.APPLICATIONS_DB_ID;
const SCHOLARSHIP_FORM_ID = process.env.SCHOLARSHIP_FORM_ID || null;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

// S16 started 2026-03-17, so any application submitted on or after 2026-03-01
// is considered an S17 applicant. (Maggie's call — wider net to make sure we
// catch everyone who was actually targeting the next cohort.)
const S17_CUTOFF_ISO = "2026-03-01T00:00:00Z";

const MAIN_FORM_ID = "rUUJ3931";

// Application-stage ordering (lowest -> highest). The sync never downgrades.
const STAGE_RANK = {
  "Started (partial)": 1,
  Applied: 2,
  "Scholarship started (partial)": 3,
  "Scholarship submitted": 4,
  Paid: 5,
};

// Terminal stages that the sync must NEVER overwrite. Maggie sets these manually.
const TERMINAL_STAGES = new Set(["Enrolled", "Withdrew", "Rejected"]);

// Fuzzy title matchers for the four fields we surface in Notion. Each entry is
// { col, type[], patterns[], anti? }. The first field whose title matches any
// `pattern` (and isn't ruled out by `anti`) wins. `type` filters by Typeform
// field type when set.
const FIELD_MATCHERS = [
  {
    col: "First name",
    type: ["short_text"],
    patterns: [
      /\bfirst\s*name\b/i,
      /\bgiven\s*name\b/i,
      /\bpreferred\s*(first\s*)?name\b/i,
      /^name$/i, // catch a bare "Name" field as a last resort
    ],
    anti: [/\blast\s*name\b/i, /\bsurname\b/i, /\bfamily\b/i, /\bfull\s*name\b/i],
  },
  {
    col: "Last name",
    type: ["short_text"],
    patterns: [
      /\blast\s*name\b/i,
      /\bsurname\b/i,
      /\bfamily\s*name\b/i,
    ],
  },
  {
    col: "Country",
    type: ["short_text", "dropdown", "multiple_choice"],
    patterns: [
      /\bcountry\b/i,
      /where\s+(are\s+you|do\s+you).*(based|live|from|located)/i,
      /\blocation\b/i,
    ],
  },
  {
    col: "How heard",
    type: ["short_text", "long_text", "dropdown", "multiple_choice"],
    patterns: [
      /how\s+did\s+you\s+hear/i,
      /how.*find\s+(out\s+about\s+)?(us|shefi)/i,
      /referr/i,
      /where\s+did\s+you\s+(hear|find)/i,
    ],
  },
  {
    // The main S17 application asks "Do you need a scholarship if accepted into
    // SheFi?". We pull the answer so Electra can route the Applied-stage nudge
    // (scholarship-focused vs. pay-focused vs. fallback).
    col: "Wants scholarship",
    type: ["multiple_choice", "yes_no", "dropdown"],
    patterns: [/scholarship/i],
  },
];

// Normalize freeform "do you need a scholarship?" answers to our three SELECT
// options. We accept anything that obviously means yes/no; anything ambiguous
// (e.g. "I'm not sure", "Maybe") becomes "Maybe" so Electra falls back to the
// generic both-paths template.
function normalizeScholarshipAnswer(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (/^no\b/.test(v) || v === "no") return "No";
  if (/^yes\b/.test(v) || v === "yes") return "Yes";
  // Catch "I need a scholarship", "I would benefit from a scholarship", etc.
  if (/\bneed\b/.test(v) || /\bwould benefit\b/.test(v)) return "Yes";
  return "Maybe";
}

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

// Fetch all responses (completed or partial) since the S17 cutoff. The Typeform
// API caps page_size at 1000.
//
// IMPORTANT: the `since` query param filters on submitted_at, and partial
// (incomplete) responses have no submitted_at — so sending `since` with
// completed=false silently returns ZERO partials. This bug hid every partial
// applicant until 2026-06-09. Completed fetches keep the server-side `since`.
// Partial fetches walk ALL pages in the API's default order (Typeform rejects
// `sort` combined with the `before` pagination token, so we can't early-stop
// on landed_at) and rely on aggregateByEmail's client-side cutoff filter.
// Page fetches are cheap (1000 rows/request); Notion writes dominate runtime.
async function fetchTypeformResponses(formId, { completed }) {
  const items = [];
  let before = null;
  while (true) {
    const params = new URLSearchParams({
      page_size: "1000",
      completed: completed ? "true" : "false",
    });
    if (completed) params.set("since", S17_CUTOFF_ISO);
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

function extractEmail(item) {
  for (const a of item.answers || []) {
    if (a.type === "email") return (a.email || "").trim().toLowerCase();
  }
  // Some Typeforms ask for email as a `short_text` field rather than the
  // dedicated email type. Fall back to the hidden-fields block or raw text
  // that looks like an email.
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

// Resolve which Typeform field IDs correspond to our target columns. Returned
// shape: { "First name": "<field_id>", ... }. Missing matches are simply absent.
function resolveFieldMap(formDef) {
  const fields = (formDef.fields || []).flatMap((f) =>
    // Groups nest their child questions under `properties.fields`
    f.type === "group" && f.properties?.fields ? f.properties.fields : [f]
  );
  const map = {};
  const debug = [];
  for (const matcher of FIELD_MATCHERS) {
    let pick = null;
    for (const f of fields) {
      const title = (f.title || "").trim();
      if (!title) continue;
      if (matcher.type && !matcher.type.includes(f.type)) continue;
      if (matcher.anti && matcher.anti.some((rx) => rx.test(title))) continue;
      if (matcher.patterns.some((rx) => rx.test(title))) {
        pick = { id: f.id, title, type: f.type, ref: f.ref };
        break;
      }
    }
    if (pick) map[matcher.col] = pick.id;
    debug.push({ col: matcher.col, picked: pick });
  }
  return { map, debug };
}

function extractAnswerByFieldId(item, fieldId) {
  if (!fieldId) return null;
  for (const a of item.answers || []) {
    if (a.field?.id !== fieldId) continue;
    switch (a.type) {
      case "text":
        return a.text || null;
      case "email":
        return a.email || null;
      case "choice":
        return a.choice?.label || a.choice?.other || null;
      case "choices":
        return (a.choices?.labels || []).join(", ") || null;
      case "number":
        return a.number != null ? String(a.number) : null;
      case "boolean":
        return a.boolean ? "Yes" : "No";
      case "date":
        return a.date || null;
      default:
        return null;
    }
  }
  return null;
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

async function fetchAllNotionRows() {
  const rows = [];
  let cursor;
  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionApi(`/databases/${APPLICATIONS_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return rows;
}

function getEmail(page) {
  const p = page.properties?.Email;
  if (p?.type === "email") return (p.email || "").trim().toLowerCase();
  return null;
}

function getSelectName(page, col) {
  const p = page.properties?.[col];
  if (p?.type === "select") return p.select?.name || null;
  return null;
}

function getDate(page, col) {
  const p = page.properties?.[col];
  if (p?.type === "date") return p.date?.start || null;
  return null;
}

function getRichText(page, col) {
  const p = page.properties?.[col];
  if (p?.type === "rich_text") return (p.rich_text || []).map((t) => t.plain_text).join("");
  return null;
}

function getMultiSelectNames(page, col) {
  const p = page.properties?.[col];
  if (p?.type === "multi_select") return (p.multi_select || []).map((o) => o.name);
  return [];
}

async function patchPage(pageId, properties) {
  return notionApi(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function createPage(properties) {
  return notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: APPLICATIONS_DB_ID },
      properties,
    }),
  });
}

// ---------- Aggregation ----------

// Build per-email signals from one form's responses. Returns Map<email, {
//   stage, dateISO, firstName, lastName, country, howHeard, source
// }>. `stage` is one of the STAGE_RANK keys.
function aggregateByEmail(items, fieldMap, stageWhenComplete) {
  const out = new Map();
  for (const item of items) {
    const email = extractEmail(item);
    if (!email) continue;
    // Partials have no real submitted_at (or a zero-value placeholder like
    // "0001-01-01..."); fall back to landed_at. The cutoff must be re-checked
    // client-side here because the API's `since` filter doesn't cover partials.
    const submittedAt =
      item.submitted_at && !item.submitted_at.startsWith("0001")
        ? item.submitted_at
        : null;
    const submitted = submittedAt || item.landed_at;
    if (!submitted) continue;
    if (submitted < S17_CUTOFF_ISO) continue;

    const stage = stageWhenComplete; // caller passes "Applied" or "Started (partial)"
    const dateISO = submitted.slice(0, 10); // YYYY-MM-DD

    const prev = out.get(email);
    // Within a single form's items, prefer the most recent submission
    if (prev && prev.dateISO >= dateISO) continue;

    out.set(email, {
      stage,
      dateISO,
      firstName: extractAnswerByFieldId(item, fieldMap["First name"]),
      lastName: extractAnswerByFieldId(item, fieldMap["Last name"]),
      country: extractAnswerByFieldId(item, fieldMap["Country"]),
      howHeard: extractAnswerByFieldId(item, fieldMap["How heard"]),
      wantsScholarship: normalizeScholarshipAnswer(
        extractAnswerByFieldId(item, fieldMap["Wants scholarship"])
      ),
    });
  }
  return out;
}

// Merge signals from multiple sources for one email. Higher-rank stage wins.
// Identity fields (first/last/country/howHeard) fall through to the highest-
// rank source that has them set, then to any source that has them set.
function mergeSignals(...maps) {
  const out = new Map();
  for (const map of maps) {
    for (const [email, sig] of map.entries()) {
      const prev = out.get(email);
      if (!prev) {
        out.set(email, { ...sig });
        continue;
      }
      const merged = { ...prev };
      // Stage: highest rank wins
      if ((STAGE_RANK[sig.stage] || 0) > (STAGE_RANK[prev.stage] || 0)) {
        merged.stage = sig.stage;
        merged.dateISO = sig.dateISO;
      }
      // Identity fields: fill in any that were missing
      for (const k of ["firstName", "lastName", "country", "howHeard", "wantsScholarship"]) {
        if (!merged[k] && sig[k]) merged[k] = sig[k];
      }
      out.set(email, merged);
    }
  }
  return out;
}

// Build the per-stage date field name from the stage label.
function stageDateField(stage) {
  if (stage === "Started (partial)") return "Started at";
  if (stage === "Applied") return "Applied at";
  if (stage === "Scholarship started (partial)") return "Scholarship started at";
  if (stage === "Scholarship submitted") return "Scholarship submitted at";
  if (stage === "Paid") return "Paid at";
  return null;
}

function richText(value) {
  if (!value) return { rich_text: [] };
  return { rich_text: [{ type: "text", text: { content: String(value).slice(0, 2000) } }] };
}

function title(value) {
  const v = value && String(value).trim() ? String(value) : "(unnamed)";
  return { title: [{ type: "text", text: { content: v.slice(0, 200) } }] };
}

// ---------- Handler ----------

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  const isProbe = url.searchParams.get("probe") === "fields";
  // One-time manual trigger that bypasses the CRON_SECRET auth check so the
  // sync can be kicked off from a browser when the secret is marked Sensitive
  // in Vercel and can't be revealed. The endpoint only reads from Typeform
  // and writes to Notion (no email sends, no destructive ops), so the
  // security cost of leaving this open is low. Remove this branch once the
  // cron has been verified in steady state.
  const isDebugRun = url.searchParams.get("debug_run") === "once";

  // Probe mode runs BEFORE the cron auth check so Maggie can hit it from a
  // browser tab without juggling CRON_SECRET. It only reads the form schema
  // from Typeform — the same data anyone who opens the form already sees —
  // and never touches Notion or sends email, so it's safe to leave unauth'd.
  // Required env var for probe: TYPEFORM_TOKEN only.
  if (isProbe) {
    if (!TYPEFORM_TOKEN) {
      return res.status(500).json({
        error: "Missing env var",
        missing: { TYPEFORM_TOKEN: true },
      });
    }
    try {
      const form = await typeformGet(`/forms/${MAIN_FORM_ID}`);
      const { map, debug } = resolveFieldMap(form);
      const allFields = (form.fields || []).flatMap((f) =>
        f.type === "group" && f.properties?.fields ? f.properties.fields : [f]
      ).map((f) => ({ id: f.id, ref: f.ref, type: f.type, title: f.title }));
      return res.status(200).json({
        formId: MAIN_FORM_ID,
        formTitle: form.title,
        fieldCount: allFields.length,
        matched: map,
        matcherDebug: debug,
        allFields,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e).slice(0, 500) });
    }
  }

  // Cron-mode auth check. Vercel cron auto-attaches Authorization: Bearer
  // <CRON_SECRET> on its scheduled invocations. Skipped for ?debug_run=once.
  if (CRON_SECRET && !isDebugRun) {
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const missing = {
    TYPEFORM_TOKEN: !TYPEFORM_TOKEN,
    NOTION_TOKEN: !NOTION_TOKEN,
    APPLICATIONS_DB_ID: !APPLICATIONS_DB_ID,
  };
  if (missing.TYPEFORM_TOKEN || missing.NOTION_TOKEN || missing.APPLICATIONS_DB_ID) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  const startedAt = new Date().toISOString();
  const summary = {
    startedAt,
    typeformCounts: {},
    rowsCreated: 0,
    rowsUpdated: 0,
    cellsUpdated: 0,
    errors: [],
  };

  try {
    // 1) Fetch + resolve fields for the main form
    const mainForm = await typeformGet(`/forms/${MAIN_FORM_ID}`);
    const { map: mainFieldMap } = resolveFieldMap(mainForm);
    const mainCompleted = await fetchTypeformResponses(MAIN_FORM_ID, { completed: true });
    const mainPartial = await fetchTypeformResponses(MAIN_FORM_ID, { completed: false });
    summary.typeformCounts.main_completed = mainCompleted.length;
    summary.typeformCounts.main_partial = mainPartial.length;

    const completedSignals = aggregateByEmail(mainCompleted, mainFieldMap, "Applied");
    const partialSignals = aggregateByEmail(mainPartial, mainFieldMap, "Started (partial)");

    // 2) Scholarship form (optional). Pull BOTH completed and partial so we can
    //    nudge applicants who started the scholarship form but didn't finish.
    let scholarshipCompletedSignals = new Map();
    let scholarshipPartialSignals = new Map();
    if (SCHOLARSHIP_FORM_ID) {
      const schForm = await typeformGet(`/forms/${SCHOLARSHIP_FORM_ID}`);
      const { map: schFieldMap } = resolveFieldMap(schForm);
      const schCompleted = await fetchTypeformResponses(SCHOLARSHIP_FORM_ID, { completed: true });
      const schPartial = await fetchTypeformResponses(SCHOLARSHIP_FORM_ID, { completed: false });
      summary.typeformCounts.scholarship_completed = schCompleted.length;
      summary.typeformCounts.scholarship_partial = schPartial.length;
      scholarshipCompletedSignals = aggregateByEmail(
        schCompleted,
        schFieldMap,
        "Scholarship submitted"
      );
      scholarshipPartialSignals = aggregateByEmail(
        schPartial,
        schFieldMap,
        "Scholarship started (partial)"
      );
    }

    // 3) Merge by email — highest stage wins, identity fills through.
    //    Order matters: pass lower-rank maps first so higher-rank ones override.
    const signalsByEmail = mergeSignals(
      partialSignals,                  // 1: Started (partial)
      completedSignals,                // 2: Applied
      scholarshipPartialSignals,       // 3: Scholarship started (partial)
      scholarshipCompletedSignals      // 4: Scholarship submitted (Paid comes from Stripe later)
    );

    // 4) Load existing Notion rows for upsert lookup
    const rows = await fetchAllNotionRows();
    const rowByEmail = new Map();
    for (const r of rows) {
      const e = getEmail(r);
      if (e) rowByEmail.set(e, r);
    }

    // 5) For each email signal, upsert
    for (const [email, sig] of signalsByEmail.entries()) {
      const existing = rowByEmail.get(email);
      try {
        if (!existing) {
          // CREATE
          // Compute Source from actual presence in each form's signals. An
          // applicant who only appears in the scholarship form (rare but
          // possible) gets Source: Scholarship only, not Main.
          const sources = [];
          if (completedSignals.has(email) || partialSignals.has(email)) {
            sources.push("Typeform: Main");
          }
          if (
            scholarshipCompletedSignals.has(email) ||
            scholarshipPartialSignals.has(email)
          ) {
            sources.push("Typeform: Scholarship");
          }

          const props = {
            Name: title(
              [sig.firstName, sig.lastName].filter(Boolean).join(" ").trim() || email
            ),
            Email: { email },
            "Application stage": { select: { name: sig.stage } },
            Source: {
              multi_select: sources.map((name) => ({ name })),
            },
          };
          // Set whichever per-stage date field corresponds to the highest stage.
          const dateField = stageDateField(sig.stage);
          if (dateField) props[dateField] = { date: { start: sig.dateISO } };
          // Also backfill earlier-stage date fields if we have signals for them.
          // This handles e.g. someone who's now Scholarship started (partial) —
          // we still want their Applied at and Started at dates populated.
          if (partialSignals.has(email)) {
            props["Started at"] = {
              date: { start: partialSignals.get(email).dateISO },
            };
          }
          if (completedSignals.has(email)) {
            props["Applied at"] = {
              date: { start: completedSignals.get(email).dateISO },
            };
          }
          if (scholarshipPartialSignals.has(email)) {
            props["Scholarship started at"] = {
              date: { start: scholarshipPartialSignals.get(email).dateISO },
            };
          }
          if (scholarshipCompletedSignals.has(email)) {
            props["Scholarship submitted at"] = {
              date: { start: scholarshipCompletedSignals.get(email).dateISO },
            };
          }
          if (sig.firstName) props["First name"] = richText(sig.firstName);
          if (sig.lastName) props["Last name"] = richText(sig.lastName);
          if (sig.country) props["Country"] = richText(sig.country);
          if (sig.howHeard) props["How heard"] = richText(sig.howHeard);
          if (sig.wantsScholarship) {
            props["Wants scholarship"] = { select: { name: sig.wantsScholarship } };
          }
          await createPage(props);
          summary.rowsCreated++;
        } else {
          // UPDATE — never downgrade, never overwrite terminal stages
          const currentStage = getSelectName(existing, "Application stage");
          const propsToUpdate = {};

          // Stage upgrade
          if (
            !TERMINAL_STAGES.has(currentStage) &&
            (STAGE_RANK[sig.stage] || 0) > (STAGE_RANK[currentStage] || 0)
          ) {
            propsToUpdate["Application stage"] = { select: { name: sig.stage } };
          }

          // Per-stage date fields: set if signal exists and current cell is blank
          const setDateIfBlank = (col, dateISO) => {
            if (!dateISO) return;
            if (!getDate(existing, col)) {
              propsToUpdate[col] = { date: { start: dateISO } };
            }
          };
          if (completedSignals.has(email)) {
            setDateIfBlank("Applied at", completedSignals.get(email).dateISO);
          }
          if (partialSignals.has(email)) {
            setDateIfBlank("Started at", partialSignals.get(email).dateISO);
          }
          if (scholarshipPartialSignals.has(email)) {
            setDateIfBlank(
              "Scholarship started at",
              scholarshipPartialSignals.get(email).dateISO
            );
          }
          if (scholarshipCompletedSignals.has(email)) {
            setDateIfBlank(
              "Scholarship submitted at",
              scholarshipCompletedSignals.get(email).dateISO
            );
          }

          // Identity fields: only fill if currently blank
          const fillIfBlank = (col, value) => {
            if (!value) return;
            const current = getRichText(existing, col);
            if (!current) propsToUpdate[col] = richText(value);
          };
          fillIfBlank("First name", sig.firstName);
          fillIfBlank("Last name", sig.lastName);
          fillIfBlank("Country", sig.country);
          fillIfBlank("How heard", sig.howHeard);
          // Wants scholarship is a SELECT, not rich text; check + set differently
          if (sig.wantsScholarship && !getSelectName(existing, "Wants scholarship")) {
            propsToUpdate["Wants scholarship"] = {
              select: { name: sig.wantsScholarship },
            };
          }

          // Source: union with existing
          const currentSources = new Set(getMultiSelectNames(existing, "Source"));
          const desired = new Set(currentSources);
          if (completedSignals.has(email) || partialSignals.has(email)) {
            desired.add("Typeform: Main");
          }
          if (
            scholarshipCompletedSignals.has(email) ||
            scholarshipPartialSignals.has(email)
          ) {
            desired.add("Typeform: Scholarship");
          }
          if (desired.size !== currentSources.size) {
            propsToUpdate.Source = {
              multi_select: [...desired].map((name) => ({ name })),
            };
          }

          const changedKeys = Object.keys(propsToUpdate);
          if (changedKeys.length === 0) continue;
          await patchPage(existing.id, propsToUpdate);
          summary.rowsUpdated++;
          summary.cellsUpdated += changedKeys.length;
        }
        // Notion rate limit: average 3 requests/second
        await sleep(350);
      } catch (e) {
        summary.errors.push({ email, error: String(e).slice(0, 200) });
      }
    }

    const endedAt = new Date().toISOString();
    return res.status(200).json({
      ...summary,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    });
  } catch (e) {
    summary.errors.push({ fatal: String(e).slice(0, 300) });
    return res.status(500).json(summary);
  }
}
