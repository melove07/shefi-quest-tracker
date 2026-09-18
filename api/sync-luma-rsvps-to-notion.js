// Daily cron: cross-references the Luma guest list for the live AI class against
// the Notion "AI Cohort Waitlist — Signups" database, so every waitlist person
// is tagged with whether they RSVP'd — giving the Hermes agent a queryable,
// focused-targeting view in one place.
//
// For each waitlist row (deduped by email), it sets:
//   - "Class Segment"  = "Waitlist + RSVP'd"  or  "Waitlist — No RSVP"
//   - "Class RSVP"     = the Luma status (Going / Pending Approval / Waitlisted /
//                        Declined / Checked In) when matched, else cleared
//   - "Class RSVP At"  = when they registered on Luma (when matched)
//
// It NEVER touches "Beehiiv Sync Status", so enriching rows can never enroll
// anyone in the Beehiiv automation or send an email. Read-only against Luma.
//
// Net-new Luma guests (registered on Luma but not on the waitlist) are the
// "RSVP'd — Not on Waitlist" bucket. By default they are only counted and
// reported, NOT written — adding them to this DB can interfere with the
// waitlist→Beehiiv funnel for anyone who later joins the waitlist. Set
// LUMA_ADD_NEW_GUESTS="true" to also create rows for them (with Beehiiv Sync
// Status left blank, so they are never auto-enrolled).
//
// Required env vars:
//   LUMA_API_KEY        — Luma API key (Luma Plus: Settings -> API). Set in Vercel.
//   NOTION_TOKEN        — Notion integration secret (connected to the waitlist DB)
// Optional env vars:
//   LUMA_EVENT_API_ID   — the class event's Luma id (evt-...). If unset, use
//                         ?probe=events to find it, then set this in Vercel.
//   WAITLIST_DB_ID      — Notion database id (defaults to the AI cohort waitlist)
//   LUMA_ADD_NEW_GUESTS — "true" to also add net-new Luma guests as rows.
//   CRON_SECRET         — if set, scheduled runs require the bearer token.
//
// Manual triggers (open in a browser tab on the deployed site):
//   ?probe=events            — list the API key's events (api_id, name, url) so
//                              you can grab the class's event id. Read-only.
//   ?probe=guests            — pull the configured event's guests and return
//                              counts + a masked sample. No Notion writes.
//   ?debug_run=once          — run the cross-reference now (the one-time pull),
//                              bypassing the cron auth gate.
//   ?debug_run=once&limit=N  — cross-reference at most N waitlist rows (smoke test).

export const maxDuration = 300; // 5 minutes
const TIME_BUDGET_MS = 270000;  // stop before the platform timeout; the rest syncs next run

const LUMA_API_KEY = process.env.LUMA_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

const EVENT_API_ID = process.env.LUMA_EVENT_API_ID || "";
const WAITLIST_DB_ID = process.env.WAITLIST_DB_ID || "1f349233dc6c4637bd89dad55bf775d2";
const ADD_NEW_GUESTS = process.env.LUMA_ADD_NEW_GUESTS === "true";

// How many Notion page writes to run in parallel. fetchRetry absorbs 429s, so a
// small pool clears the backlog inside one run while staying under the rate limit.
const CONCURRENCY = Math.min(Math.max(parseInt(process.env.LUMA_SYNC_CONCURRENCY || "3", 10) || 3, 1), 8);

const SEG_MATCHED = "Waitlist + RSVP'd";
const SEG_NO_RSVP = "Waitlist — No RSVP";
const SEG_NEW = "RSVP'd — Not on Waitlist";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with automatic retry on 429 (rate limit) and 5xx (transient),
// honoring Retry-After. Safe: Luma reads are read-only and Notion writes here
// are idempotent last-write-wins property patches.
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

// ---------- Luma ----------

async function luma(path) {
  const res = await fetchRetry(`https://public-api.lu.ma${path}`, {
    headers: { "x-luma-api-key": LUMA_API_KEY, accept: "application/json" },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Luma GET ${path} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Luma wraps a guest either directly or under `.guest`; field names have varied
// across API versions, so read defensively from every plausible key.
function guestObj(entry) {
  return entry?.guest || entry || {};
}
function guestEmail(entry) {
  const g = guestObj(entry);
  const e = g.email || g.user_email || g.registered_email || entry?.email || "";
  return String(e).trim().toLowerCase();
}
function guestName(entry) {
  const g = guestObj(entry);
  return (g.name || g.user_name || g.user_full_name || g.full_name || "").trim();
}
// Normalise Luma's status into a small, stable set of Notion select options.
function guestStatus(entry) {
  const g = guestObj(entry);
  if (g.checked_in_at || g.checked_in === true) return "Checked In";
  const s = String(g.approval_status || g.rsvp_status || g.status || "").toLowerCase();
  if (s.includes("approv")) return "Going";
  if (s.includes("pending")) return "Pending Approval";
  if (s.includes("declin") || s.includes("reject")) return "Declined";
  if (s.includes("waitlist")) return "Waitlisted";
  if (s === "going" || s === "yes" || s === "accepted") return "Going";
  if (!s) return "Registered";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function guestRegisteredAt(entry) {
  const g = guestObj(entry);
  return g.registered_at || g.created_at || g.rsvp_at || g.approved_at || null;
}

// Page through every guest for the event. get-guests is cursor-paginated:
// ?pagination_limit&pagination_cursor, with `entries`, `has_more`, `next_cursor`.
async function fetchAllGuests(eventApiId) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 1000; i++) {
    const params = new URLSearchParams({ event_api_id: eventApiId, pagination_limit: "100" });
    if (cursor) params.set("pagination_cursor", cursor);
    const body = await luma(`/public/v1/event/get-guests?${params}`);
    const entries = body.entries || body.data || [];
    out.push(...entries);
    if (!body.has_more) break;
    cursor = body.next_cursor || body.pagination_cursor;
    if (!cursor) break;
  }
  return out;
}

// Build email -> guest info, keeping the "most committed" record per email if a
// person appears more than once (Checked In > Going > everything else).
function guestsByEmail(entries) {
  const rank = { "Checked In": 3, "Going": 2, "Waitlisted": 1, "Pending Approval": 1, "Registered": 1, "Declined": 0 };
  const map = new Map();
  for (const entry of entries) {
    const email = guestEmail(entry);
    if (!email) continue;
    const info = { email, name: guestName(entry), status: guestStatus(entry), registeredAt: guestRegisteredAt(entry) };
    const existing = map.get(email);
    if (!existing || (rank[info.status] ?? 1) > (rank[existing.status] ?? 1)) map.set(email, info);
  }
  return map;
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

// Add the class-targeting properties to the DB if they aren't there yet, so the
// cron is self-contained (no manual column setup). Idempotent: only missing
// properties are added, and existing option lists are never modified.
async function ensureSchema() {
  const db = await notionApi(`/databases/${WAITLIST_DB_ID}`);
  const props = db.properties || {};
  const toAdd = {};
  if (!props["Class RSVP"]) {
    toAdd["Class RSVP"] = { select: { options: [
      { name: "Going" }, { name: "Pending Approval" }, { name: "Waitlisted" },
      { name: "Declined" }, { name: "Checked In" }, { name: "Registered" },
    ] } };
  }
  if (!props["Class RSVP At"]) toAdd["Class RSVP At"] = { date: {} };
  if (!props["Class Segment"]) {
    toAdd["Class Segment"] = { select: { options: [
      { name: SEG_MATCHED }, { name: SEG_NO_RSVP }, { name: SEG_NEW },
    ] } };
  }
  if (Object.keys(toAdd).length) {
    await notionApi(`/databases/${WAITLIST_DB_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: toAdd }),
    });
  }
  return Object.keys(toAdd);
}

// email -> { id, rsvp, segment } for every waitlist row, so we can skip writes
// that wouldn't change anything and avoid creating duplicate net-new rows.
async function fetchWaitlistPages() {
  const byEmail = new Map();
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
      const email = p?.type === "email" && p.email ? p.email.trim().toLowerCase() : null;
      if (!email) continue;
      if (byEmail.has(email)) continue; // waitlist sync already dedupes; keep first
      byEmail.set(email, {
        id: page.id,
        rsvp: page.properties?.["Class RSVP"]?.select?.name || null,
        segment: page.properties?.["Class Segment"]?.select?.name || null,
        rsvpAt: page.properties?.["Class RSVP At"]?.date?.start || null,
      });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return byEmail;
}

function title(value) {
  const v = value && String(value).trim() ? String(value) : "(unnamed)";
  return { title: [{ type: "text", text: { content: v.slice(0, 200) } }] };
}

// Patch an existing waitlist row's class-targeting fields. Never touches
// "Beehiiv Sync Status", so this can never enroll anyone or send an email.
async function updateTargeting(pageId, { segment, rsvp, rsvpAt }) {
  const properties = { "Class Segment": { select: { name: segment } } };
  properties["Class RSVP"] = rsvp ? { select: { name: rsvp } } : { select: null };
  properties["Class RSVP At"] = rsvpAt ? { date: { start: rsvpAt } } : { date: null };
  await notionApi(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
}

// Create a row for a net-new Luma guest. Beehiiv Sync Status is deliberately
// left unset so the Notion→Beehiiv cron (which only acts on Pending/Error) never
// picks them up and emails them.
async function createNewGuestRow(info) {
  const properties = {
    Name: title(info.name || info.email),
    Email: { email: info.email },
    "Class Segment": { select: { name: SEG_NEW } },
    "Class RSVP": { select: { name: info.status } },
  };
  if (info.registeredAt) properties["Class RSVP At"] = { date: { start: info.registeredAt } };
  await notionApi(`/pages`, {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: WAITLIST_DB_ID }, properties }),
  });
}

// ---------- Handler ----------

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
  const probe = url.searchParams.get("probe");
  const isDebugRun = url.searchParams.get("debug_run") === "once";
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : null;

  if (!LUMA_API_KEY) {
    return res.status(500).json({ error: "Missing env var", missing: { LUMA_API_KEY: true } });
  }

  // Probe: list the API key's events so the event id can be found. Read-only.
  if (probe === "events") {
    try {
      const body = await luma(`/public/v1/calendar/list-events?pagination_limit=100`);
      const entries = body.entries || body.data || [];
      const events = entries.map((e) => {
        const ev = e.event || e;
        return { event_api_id: ev.api_id || e.api_id, name: ev.name, url: ev.url, start_at: ev.start_at };
      });
      return res.status(200).json({ count: events.length, events });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 500) });
    }
  }

  if (!EVENT_API_ID) {
    return res.status(500).json({ error: "Missing env var", missing: { LUMA_EVENT_API_ID: true }, hint: "Run ?probe=events to find the class event id, then set LUMA_EVENT_API_ID in Vercel." });
  }

  // Probe: pull guests for the configured event, return counts + masked sample.
  if (probe === "guests") {
    try {
      const entries = await fetchAllGuests(EVENT_API_ID);
      const byEmail = guestsByEmail(entries);
      const sample = [...byEmail.values()].slice(0, 5).map((g) => ({
        email: mask(g.email), name: g.name ? mask(g.name) : "", status: g.status, registeredAt: g.registeredAt,
      }));
      const byStatus = {};
      for (const g of byEmail.values()) byStatus[g.status] = (byStatus[g.status] || 0) + 1;
      return res.status(200).json({ eventApiId: EVENT_API_ID, rawEntries: entries.length, uniqueGuests: byEmail.size, byStatus, sample });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 500) });
    }
  }

  // Cron auth gate. Manual ?debug_run bypasses it.
  if (!isDebugRun && CRON_SECRET && (req.headers?.authorization || "") !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing env var", missing: { NOTION_TOKEN: true } });
  }

  const startedAt = Date.now();
  const summary = {
    startedAt: new Date(startedAt).toISOString(), eventApiId: EVENT_API_ID,
    guests: 0, waitlistRows: 0, matched: 0, noRsvp: 0,
    newGuests: 0, newGuestsAdded: 0, addNewGuests: ADD_NEW_GUESTS,
    updated: 0, unchanged: 0, schemaAdded: [], stoppedEarly: false,
    newGuestSample: [], errors: [],
  };

  try {
    summary.schemaAdded = await ensureSchema();

    const [entries, pages] = await Promise.all([fetchAllGuests(EVENT_API_ID), fetchWaitlistPages()]);
    const guests = guestsByEmail(entries);
    summary.guests = guests.size;
    summary.waitlistRows = pages.size;

    // 1) Enrich every waitlist row with its segment + RSVP status.
    const updates = [];
    for (const [email, page] of pages) {
      const matched = guests.get(email) || null;
      if (matched) summary.matched++; else summary.noRsvp++;
      const desired = matched
        ? { segment: SEG_MATCHED, rsvp: matched.status, rsvpAt: matched.registeredAt || null }
        : { segment: SEG_NO_RSVP, rsvp: null, rsvpAt: null };
      // Skip rows already in the desired state to avoid needless writes.
      if (page.segment === desired.segment && (page.rsvp || null) === (desired.rsvp || null)
        && (page.rsvpAt || null) === (desired.rsvpAt || null)) {
        summary.unchanged++;
        continue;
      }
      updates.push({ id: page.id, email, desired });
    }
    if (limit) updates.length = Math.min(updates.length, limit);

    // 2) Net-new Luma guests (registered but not on the waitlist).
    const newGuests = [];
    for (const [email, info] of guests) {
      if (pages.has(email)) continue;
      newGuests.push(info);
    }
    summary.newGuests = newGuests.length;
    summary.newGuestSample = newGuests.slice(0, 8).map((g) => ({ email: mask(g.email), status: g.status }));

    // Apply the row updates through a small worker pool.
    let next = 0;
    const work = async () => {
      while (true) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.stoppedEarly = true; return; }
        const i = next++;
        if (i >= updates.length) return;
        const u = updates[i];
        try {
          await updateTargeting(u.id, u.desired);
          summary.updated++;
        } catch (e) {
          summary.errors.push({ email: u.email, error: String(e.message || e).slice(0, 200) });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, work));

    // Optionally fold net-new guests into the DB (off by default; never enrolled).
    if (ADD_NEW_GUESTS && !summary.stoppedEarly) {
      for (const info of newGuests) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.stoppedEarly = true; break; }
        if (limit && summary.newGuestsAdded >= limit) break;
        try {
          await createNewGuestRow(info);
          summary.newGuestsAdded++;
          await sleep(250);
        } catch (e) {
          summary.errors.push({ email: info.email, error: String(e.message || e).slice(0, 200) });
        }
      }
    }

    const endedAt = Date.now();
    return res.status(200).json({ ...summary, endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt });
  } catch (e) {
    summary.errors.push({ fatal: String(e.message || e).slice(0, 300) });
    return res.status(500).json(summary);
  }
}
