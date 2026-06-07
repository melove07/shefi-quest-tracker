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
// Cohort boundary: only application responses submitted on or after 2026-03-14
// count as S17. Earlier responses to rUUJ3931 belong to S15/S16 and are ignored.
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

// S17 cohort starts 2026-03-17; the application window opens a few days early.
// Anything submitted at or after this datetime is S17.
const S17_CUTOFF_ISO = "2026-03-14T00:00:00Z";

const MAIN_FORM_ID = "rUUJ3931";

// Application-stage ordering (lowest -> highest). The sync never downgrades.
const STAGE_RANK = {
  "Started (partial)": 1,
  Applied: 2,
  "Scholarship submitted": 3,
  Paid: 4,
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
];

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
// API caps page_size at 1000 and supports a `since` filter — we use both so we
// don't have to walk years of past-cohort data.
async function fetchTypeformResponses(formId, { completed }) {
  const items = [];
  let before = null;
  while (true) {
    const params = new URLSearchParams({
      page_size: "1000",
      since: S17_CUTOFF_ISO,
      completed: completed ? "true" : "false",
    });
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
    const submitted = item.submitted_at || item.landed_at;
    if (!submitted) continue;
    // Belt and suspenders: API filter handles this, but re-check client-side
    // in case the cutoff ever changes mid-flight.
    if (submitted < S17_CUTOFF_ISO) continue;

    // Completed responses always have submitted_at; partials have it set when
    // Typeform auto-saves the abandoned attempt. We treat "answered at all but
    // didn't complete" as the partial state.
    const isPartial = !item.calculated?.score && !item.metadata?.user_agent
      ? false // can't reliably detect from these alone
      : false;
    void isPartial;

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
      for (const k of ["firstName", "lastName", "country", "howHeard"]) {
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
  if (CRON_SECRET) {
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

  // Probe mode: dump the main form's field schema with our field-title matches
  // so Maggie can sanity-check the fuzzy matchers after deploy. Hit:
  //   /api/sync-applications-to-notion?probe=fields
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  if (url.searchParams.get("probe") === "fields") {
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

    // 2) Scholarship form (optional)
    let scholarshipSignals = new Map();
    if (SCHOLARSHIP_FORM_ID) {
      const schForm = await typeformGet(`/forms/${SCHOLARSHIP_FORM_ID}`);
      const { map: schFieldMap } = resolveFieldMap(schForm);
      const schItems = await fetchTypeformResponses(SCHOLARSHIP_FORM_ID, { completed: true });
      summary.typeformCounts.scholarship_completed = schItems.length;
      scholarshipSignals = aggregateByEmail(schItems, schFieldMap, "Scholarship submitted");
    }

    // 3) Merge by email — highest stage wins, identity fills through
    const signalsByEmail = mergeSignals(
      partialSignals,        // lowest stage
      completedSignals,
      scholarshipSignals     // highest auto-set stage (Paid comes from Stripe later)
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
          const props = {
            Name: title(
              [sig.firstName, sig.lastName].filter(Boolean).join(" ").trim() || email
            ),
            Email: { email },
            "Application stage": { select: { name: sig.stage } },
            Source: { multi_select: [{ name: "Typeform: Main" }] },
          };
          const dateField = stageDateField(sig.stage);
          if (dateField) props[dateField] = { date: { start: sig.dateISO } };
          if (sig.firstName) props["First name"] = richText(sig.firstName);
          if (sig.lastName) props["Last name"] = richText(sig.lastName);
          if (sig.country) props["Country"] = richText(sig.country);
          if (sig.howHeard) props["How heard"] = richText(sig.howHeard);
          // If they appeared in the scholarship signals, flag that source too
          if (scholarshipSignals.has(email)) {
            props.Source = {
              multi_select: [
                { name: "Typeform: Main" },
                { name: "Typeform: Scholarship" },
              ],
            };
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
          if (scholarshipSignals.has(email)) {
            setDateIfBlank(
              "Scholarship submitted at",
              scholarshipSignals.get(email).dateISO
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

          // Source: union with existing
          const currentSources = new Set(getMultiSelectNames(existing, "Source"));
          const desired = new Set(currentSources);
          if (completedSignals.has(email) || partialSignals.has(email)) {
            desired.add("Typeform: Main");
          }
          if (scholarshipSignals.has(email)) desired.add("Typeform: Scholarship");
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
