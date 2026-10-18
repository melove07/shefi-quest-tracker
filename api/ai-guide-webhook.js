// Typeform webhook — "AI Will Survive" class survey (form qawX7iWT) autoresponder.
//
// When someone submits the survey AND ticks the "send me the guide" consent box,
// this emails them the AI Workflow Guide from maggie@shefi.org with a download
// link, then logs the send to the "AI Guide Sends" Notion DB (which also prevents
// a duplicate if the same person submits again).
//
// Instant: it fires on each submission, so there's no cron and no Vercel
// cron-frequency limit to worry about.
//
// One-time setup:
//   1. Deploy, then in Typeform open form qawX7iWT -> Connect -> Webhooks ->
//      add endpoint:
//        https://shefi-quest-tracker.vercel.app/api/ai-guide-webhook?key=YOUR_SECRET
//   2. Vercel env vars:
//        GMAIL_SENDER          maggie@shefi.org
//        GMAIL_APP_PASSWORD    <16-char Gmail app password for maggie@shefi.org>
//        GUIDE_URL             https://shefi-quest-tracker.vercel.app/ai-will-survive-workflows-guide.pdf
//        AI_GUIDE_WEBHOOK_KEY  <any random string; must equal ?key= in the webhook URL>
//        NOTION_TOKEN          (already set)
//        AI_GUIDE_DB_ID        b52d88ea69044793ab677eb89a5786b7
//      Optional:
//        INNER_CIRCLE_URL      https://pctxqsdzgk0.typeform.com/innercircle
//
// If maggie@'s Workspace blocks app passwords, only sendGuideEmail() needs to
// change (swap the nodemailer transport for a transactional service like Resend).

import nodemailer from "nodemailer";

export const maxDuration = 60;

const GMAIL_SENDER = process.env.GMAIL_SENDER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GUIDE_URL =
  process.env.GUIDE_URL ||
  "https://shefi-quest-tracker.vercel.app/ai-will-survive-workflows-guide.pdf";
const WEBHOOK_KEY = process.env.AI_GUIDE_WEBHOOK_KEY || null;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const AI_GUIDE_DB_ID = process.env.AI_GUIDE_DB_ID;
const NOTION_VERSION = "2022-06-28";

// Field ids on form qawX7iWT (verified 2026-10-01). The consent checkbox records
// as a `choice` answer that is only present when the box is ticked.
const F_CONSENT = "CHYMpnJvWqNA"; // "Would you like to receive the guide..."
const F_EMAIL = "DMVrSU13CJAR";
const F_FIRST = "eyaaWwQo3BHS";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notionApi(path, opts = {}, attempt = 0) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 429 && attempt < 5) {
    const hdr = parseFloat(res.headers.get("retry-after") || "1");
    await sleep((Number.isFinite(hdr) ? hdr : 1) * 1000 + 300);
    return notionApi(path, opts, attempt + 1);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion ${opts.method || "GET"} ${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Dedup: has this email already been sent the guide? Fail-open (if the check
// errors we still send — better a rare duplicate than a missed guide).
async function alreadySent(email) {
  if (!NOTION_TOKEN || !AI_GUIDE_DB_ID) return false;
  try {
    const data = await notionApi(`/databases/${AI_GUIDE_DB_ID}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      }),
    });
    return (data.results || []).length > 0;
  } catch {
    return false;
  }
}

async function logSend(email, first, token, status) {
  if (!NOTION_TOKEN || !AI_GUIDE_DB_ID) return;
  const properties = {
    Name: { title: [{ text: { content: first || email } }] },
    Email: { email },
    "Sent at": { date: { start: new Date().toISOString() } },
    Status: { select: { name: status } },
  };
  if (first) properties["First name"] = { rich_text: [{ text: { content: first } }] };
  if (token) properties["Response token"] = { rich_text: [{ text: { content: token } }] };
  try {
    await notionApi(`/pages`, {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: AI_GUIDE_DB_ID }, properties }),
    });
  } catch {
    /* best effort — never block the send on logging */
  }
}

function cleanFirst(name) {
  if (!name) return null;
  const n = String(name).trim().split(/\s+/)[0];
  if (!n) return null;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function parseSubmission(body) {
  const payload = typeof body === "string" ? safeJson(body) : body;
  const fr = payload?.form_response;
  if (!fr) return null;
  const byId = {};
  for (const a of fr.answers || []) {
    if (a?.field?.id) byId[a.field.id] = a;
  }
  return {
    token: fr.token || null,
    consent: !!byId[F_CONSENT], // present only when the box is ticked
    email: (byId[F_EMAIL]?.email || "").trim().toLowerCase() || null,
    first: cleanFirst(byId[F_FIRST]?.text),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function emailText(first) {
  const hi = first ? `Hi ${first},` : "Hi there,";
  return `${hi}

Here's your AI Workflow Guide. Download it here: ${GUIDE_URL}

Thank you again for sharing your feedback!

If you want even more resources, check out shefi.org/resources.

More content from the class is coming over the next few days.

Best,
Maggie`;
}

function emailHtml(first) {
  const hi = first ? `Hi ${first},` : "Hi there,";
  return `<p>${hi}</p>
<p>Here's your <strong>AI Workflow Guide</strong>: <a href="${GUIDE_URL}">download it here</a>. Thank you again for sharing your feedback!</p>
<p>If you want even more resources, check out <a href="https://shefi.org/resources">shefi.org/resources</a>.</p>
<p>More content from the class is coming over the next few days.</p>
<p>Best,<br>Maggie</p>`;
}

async function sendGuideEmail(to, first) {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_SENDER, pass: GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({
    from: `Maggie @ SheFi <${GMAIL_SENDER}>`,
    to,
    subject: "Your AI Workflow Guide 🎉",
    text: emailText(first),
    html: emailHtml(first),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, note: "AI guide webhook — POST only" });
  }
  // Light shared-secret check via ?key= on the webhook URL.
  if (WEBHOOK_KEY) {
    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    if (url.searchParams.get("key") !== WEBHOOK_KEY) {
      return res.status(401).json({ error: "bad key" });
    }
  }
  if (!GMAIL_SENDER || !GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: "Missing GMAIL_SENDER / GMAIL_APP_PASSWORD" });
  }

  const sub = parseSubmission(req.body);
  if (!sub) return res.status(200).json({ ok: true, skipped: "no form_response" });
  if (!sub.consent) return res.status(200).json({ ok: true, skipped: "no consent" });
  if (!sub.email) return res.status(200).json({ ok: true, skipped: "no email" });

  if (await alreadySent(sub.email)) {
    return res.status(200).json({ ok: true, skipped: "already sent", email: sub.email });
  }

  // Always answer 200 after this point so Typeform doesn't retry and double-send.
  try {
    await sendGuideEmail(sub.email, sub.first);
    await logSend(sub.email, sub.first, sub.token, "Sent");
    return res.status(200).json({ ok: true, sent: sub.email });
  } catch (e) {
    await logSend(sub.email, sub.first, sub.token, "Failed");
    return res.status(200).json({ ok: false, error: String(e).slice(0, 200), email: sub.email });
  }
}
