// Daily cron: takes AI Cohort waitlist people from the Notion "Signups"
// database and syncs them into Beehiiv, then enrolls them in the
// "AI Waitlist -> Diagnostic Survey" automation (which sends the
// "Where Are You With AI?" survey email).
//
// For each Notion row with Beehiiv Sync Status = "Pending":
//   1. Upsert the subscriber in Beehiiv (by email — never duplicates, never
//      unsubscribes, never touches the newsletter list).
//   2. Set custom fields: AI Waitlist = true, First Name, Last Name.
//   3. Enroll them once in the diagnostic automation.
//   4. Mark the Notion row Synced (or Error, with the message).
//
// Safe to run repeatedly: Beehiiv upserts by email, the automation is
// enter-once, and only "Pending" rows are ever touched.
//
// Required env vars:
//   BEEHIIV_API_KEY          — Beehiiv API key (Settings -> API)
//   NOTION_TOKEN             — Notion integration secret (connected to the DB)
// Optional env vars:
//   BEEHIIV_PUBLICATION_ID   — defaults to SheFi Newsletter
//   BEEHIIV_AUTOMATION_ID    — defaults to the diagnostic automation
//   WAITLIST_DB_ID           — defaults to the AI Cohort Waitlist Signups DB
//   BEEHIIV_SYNC_ENABLED     — scheduled runs no-op unless this is "true".
//                              (manual ?debug_run/?test_email always run.)
//   CRON_SECRET              — if set, scheduled runs require the bearer token.
//
// Manual triggers (open in a browser tab on the deployed site):
//   ?test_email=you@example.com&first=Ada&last=Lovelace
//        — run the full Beehiiv flow for ONE address (no Notion). Test A/B/D.
//   ?debug_run=once&limit=5
//        — process up to 5 Pending Notion rows now. The staged backfill.
//   ?debug_run=once
//        — process all Pending rows.

export const maxDuration = 300; // 5 minutes
const TIME_BUDGET_MS = 270000; // stop before the platform timeout; rest stays Pending

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const SYNC_ENABLED = process.env.BEEHIIV_SYNC_ENABLED === "true";
const NOTION_VERSION = "2022-06-28";

const PUB = process.env.BEEHIIV_PUBLICATION_ID || "pub_ec2337ac-661e-4df4-9ea6-7a9ba492912e";
const AUTOMATION = process.env.BEEHIIV_AUTOMATION_ID || "aut_5d64ea60-f444-4553-bc15-fce134571c11";
const WAITLIST_DB_ID = process.env.WAITLIST_DB_ID || "1f349233dc6c4637bd89dad55bf775d2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Beehiiv ----------

async function beehiiv(path, opts = {}) {
  const res = await fetch(`https://api.beehiiv.com/v2${path}`, {
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

function waitlistCustomFields(firstName, lastName) {
  const fields = [{ name: "AI Waitlist", value: true }];
  if (firstName) fields.push({ name: "First Name", value: firstName });
  if (lastName) fields.push({ name: "Last Name", value: lastName });
  return fields;
}

// Create-or-return the subscriber by email. Beehiiv keys by email per
// publication, so this never duplicates; reactivate_existing:false leaves an
// unsubscribed person unsubscribed, and send_welcome_email:false keeps them off
// the newsletter welcome. Returns the subscription id.
async function upsertSubscriber(email, firstName, lastName) {
  const body = {
    email,
    reactivate_existing: false,
    send_welcome_email: false,
    custom_fields: waitlistCustomFields(firstName, lastName),
  };
  const res = await beehiiv(`/publications/${PUB}/subscriptions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.data?.id || res.id;
}

// Ensure the custom fields are set even when the subscriber already existed
// (the create call above may not overwrite fields on an existing record).
async function setWaitlistFields(subId, firstName, lastName) {
  await beehiiv(`/publications/${PUB}/subscriptions/${subId}`, {
    method: "PATCH",
    body: JSON.stringify({ custom_fields: waitlistCustomFields(firstName, lastName) }),
  });
}

// Enroll the subscriber in the diagnostic automation. Enter-once, so a repeat
// enroll is harmless — swallow "already enrolled"-style responses.
async function enroll(subId) {
  try {
    await beehiiv(`/publications/${PUB}/automations/${AUTOMATION}/journeys`, {
      method: "POST",
      body: JSON.stringify({ subscription_id: subId }),
    });
    return "enrolled";
  } catch (e) {
    if (/already|enrolled|exists|duplicate|journey/i.test(String(e.message))) return "already_enrolled";
    throw e;
  }
}

async function syncOne(email, firstName, lastName) {
  const subId = await upsertSubscriber(email, firstName, lastName);
  if (!subId) throw new Error("No subscription id returned from Beehiiv");
  await setWaitlistFields(subId, firstName, lastName);
  const enrollment = await enroll(subId);
  return { subId, enrollment };
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

async function fetchPendingRows() {
  const rows = [];
  let cursor;
  while (true) {
    const body = {
      page_size: 100,
      filter: { property: "Beehiiv Sync Status", select: { equals: "Pending" } },
    };
    if (cursor) body.start_cursor = cursor;
    const data = await notionApi(`/databases/${WAITLIST_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return rows;
}

function plainText(prop) {
  if (prop?.type === "rich_text") return (prop.rich_text || []).map((t) => t.plain_text).join("").trim();
  if (prop?.type === "title") return (prop.title || []).map((t) => t.plain_text).join("").trim();
  return "";
}

async function markRow(pageId, status, errorMsg) {
  const properties = {
    "Beehiiv Sync Status": { select: { name: status } },
  };
  if (status === "Synced") {
    properties["Beehiiv Synced At"] = { date: { start: new Date().toISOString() } };
    properties["Beehiiv Sync Error"] = { rich_text: [] };
  }
  if (status === "Error") {
    properties["Beehiiv Sync Error"] = {
      rich_text: [{ type: "text", text: { content: String(errorMsg || "").slice(0, 2000) } }],
    };
  }
  await notionApi(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
}

// ---------- Handler ----------

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
  const testEmail = url.searchParams.get("test_email");
  const isDebugRun = url.searchParams.get("debug_run") === "once";
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : null;

  if (!BEEHIIV_API_KEY) {
    return res.status(500).json({ error: "Missing env vars", missing: { BEEHIIV_API_KEY: true } });
  }

  // Single-address test (Test A / B / D). No Notion, no auth gate.
  if (testEmail) {
    try {
      const first = url.searchParams.get("first") || "";
      const last = url.searchParams.get("last") || "";
      const result = await syncOne(testEmail.trim().toLowerCase(), first, last);
      return res.status(200).json({ mode: "test_email", email: testEmail, ...result });
    } catch (e) {
      return res.status(500).json({ mode: "test_email", email: testEmail, error: String(e.message || e).slice(0, 500) });
    }
  }

  // Cron auth + enable gate. Manual ?debug_run bypasses both.
  if (!isDebugRun) {
    if (CRON_SECRET && (req.headers?.authorization || "") !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!SYNC_ENABLED) {
      return res.status(200).json({ skipped: "BEEHIIV_SYNC_ENABLED is not 'true'" });
    }
  }

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "Missing env vars", missing: { NOTION_TOKEN: true } });
  }

  const startedAt = Date.now();
  const summary = { startedAt: new Date(startedAt).toISOString(), pending: 0, synced: 0, errors: [], stoppedEarly: false };

  try {
    const rows = await fetchPendingRows();
    summary.pending = rows.length;

    for (const page of rows) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.stoppedEarly = true; break; }
      if (limit && summary.synced >= limit) break;

      const props = page.properties || {};
      const email = props.Email?.email ? props.Email.email.trim().toLowerCase() : "";
      const firstName = plainText(props["First name"]);
      const lastName = plainText(props["Last name"]);

      if (!email) {
        await markRow(page.id, "Error", "No email on this row").catch(() => {});
        summary.errors.push({ pageId: page.id, error: "No email" });
        continue;
      }

      try {
        await syncOne(email, firstName, lastName);
        await markRow(page.id, "Synced");
        summary.synced++;
      } catch (e) {
        const msg = String(e.message || e).slice(0, 300);
        await markRow(page.id, "Error", msg).catch(() => {});
        summary.errors.push({ email, error: msg });
      }
      await sleep(300); // stay under Beehiiv + Notion rate limits
    }

    const endedAt = Date.now();
    return res.status(200).json({ ...summary, endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt });
  } catch (e) {
    summary.errors.push({ fatal: String(e.message || e).slice(0, 300) });
    return res.status(500).json(summary);
  }
}
