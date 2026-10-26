// One-off tagger: apply `ai101_oct29_catchup` to waitlist members who signed up
// AFTER the Oct 20 invite send, so they can get a Monday catch-up invite to the
// Oct 29 AI 101 class. Looks each email up in Beehiiv and adds the tag. No email
// is ever sent here. Safe to re-run (tags are additive). Add later signups to
// SIGNUPS and re-open the link to catch them.
//
//   /api/tag-ai101-catchup?token=shefi-aiws-7h2k9x            run it
//   /api/tag-ai101-catchup?token=shefi-aiws-7h2k9x&dry_run=1  preview (no writes)

export const maxDuration = 120;

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";
const ACCESS_PASS = "shefi-aiws-7h2k9x";
const PUB = process.env.BEEHIIV_PUBLICATION_ID || "pub_ec2337ac-661e-4df4-9ea6-7a9ba492912e";
const TAG = "ai101_oct29_catchup";

// Waitlist signups Oct 20-23 (after the Oct 20 6am PDT invite send), all synced
// to Beehiiv. Append later signups and re-run before the catch-up send.
const SIGNUPS = [
  "k.ae.dzn22@gmail.com",
  "marlene.monsalvo2@gmail.com",
  "elviammiralda@gmail.com",
  "tbanik.eee2030.learner@gmail.com",
  "manisha.das.0100@gmail.com",
  "aberlett@gmail.com",
  "christinecortezflores@gmail.com",
  "denizidilaygun@gmail.com",
  "vrai.ayushi08@gmail.com",
  "brendanmaciel17@gmail.com",
  "jumana@thehappybox.ae",
  "taarini.vohra@gmail.com",
  "paulavanessa08@gmail.com",
  "kaninikagain99@gmail.com",
  "dinara@askalem.com",
  "evgeniazakharetri@gmail.com",
  "soulutionsbyklatt@gmail.com",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function beehiiv(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.beehiiv.com/v2${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${BEEHIIV_API_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
      });
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status !== 429 && res.status < 500) {
      const t = await res.text();
      let body; try { body = t ? JSON.parse(t) : {}; } catch { body = { raw: t }; }
      return { ok: res.ok, status: res.status, body };
    }
    if (attempt >= 4) {
      const t = await res.text();
      let body; try { body = t ? JSON.parse(t) : {}; } catch { body = { raw: t }; }
      return { ok: res.ok, status: res.status, body };
    }
    await sleep(500 * 2 ** attempt);
  }
}

async function findSubId(email) {
  const r = await beehiiv(`/publications/${PUB}/subscriptions?email=${encodeURIComponent(email)}`);
  if (r.ok && Array.isArray(r.body?.data)) {
    for (const d of r.body.data) if ((d.email || "").trim().toLowerCase() === email) return d.id;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (!BEEHIIV_API_KEY) return res.status(500).json({ error: "Missing BEEHIIV_API_KEY" });
    const q = req.query || {};
    const token = q.token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== ACCESS_PASS && !(CRON_SECRET && token === CRON_SECRET)) return res.status(401).json({ error: "Unauthorized" });

    const emails = [...new Set(SIGNUPS.map((e) => e.trim().toLowerCase()))];
    if (q.dry_run) return res.status(200).json({ dry_run: true, tag: TAG, count: emails.length, emails });

    const results = [];
    for (const email of emails) {
      try {
        const subId = await findSubId(email);
        if (!subId) { results.push({ email, result: "not_found" }); continue; }
        const t = await beehiiv(`/publications/${PUB}/subscriptions/${subId}/tags`, {
          method: "POST",
          body: JSON.stringify({ tags: [TAG] }),
        });
        results.push({ email, result: t.ok ? "tagged" : `fail ${t.status}` });
      } catch (e) {
        results.push({ email, result: "error:" + String(e).slice(0, 80) });
      }
    }
    const summary = {};
    for (const r of results) { const k = r.result.startsWith("tagged") ? "tagged" : r.result.startsWith("not_found") ? "not_found" : "failed"; summary[k] = (summary[k] || 0) + 1; }
    return res.status(200).json({ ok: true, tag: TAG, total: emails.length, summary, results });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
