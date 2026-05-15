// Daily cron: pulls Typeform completions for all 8 SheFi quests and updates
// the matching rows in the Notion Quest Roster. Runs at 09:00 UTC (5am EDT)
// per vercel.json so Maia sees fresh data on her morning run.
//
// Required env vars:
//   TYPEFORM_TOKEN       — Typeform personal access token (already set)
//   NOTION_TOKEN         — Notion internal integration secret
//   NOTION_DATABASE_ID   — the Quest Roster DB id (9e18207c07fa41ba95f02d3e57f5616f)
// Optional:
//   CRON_SECRET          — if set, requires `Authorization: Bearer <secret>`
//                          on the request. Vercel cron auto-attaches this.

export const maxDuration = 300; // 5 minutes — enough for full daily sync

const TYPEFORM_TOKEN = process.env.TYPEFORM_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const NOTION_VERSION = "2022-06-28";

const FORMS = [
  { id: "iIiQAwun", col: "Q1: Get Ready for SheFi Season" },
  { id: "HUghpqnk", col: "Q2: Follow Our Sponsors" },
  { id: "RWRJvUnW", col: "Q3: Download and Fund Base App" },
  { id: "b1ekAd1e", col: "Q4: Set Up Trezor Wallet or Hot Wallet" },
  { id: "lFat2TQw", col: "Q5: Swap on Base App" },
  { id: "OStCrx5O", col: "Q6: Stake in RootstockCollective" },
  { id: "a3NhVSaE", col: "Q7: Decentraland Avatar" },
  { id: "h24RwqF6", col: "Q8: Bonus Coinfello AI Action" },
];

const QUEST_SHORT_NAMES = {
  "Q1: Get Ready for SheFi Season": "Q1: Get Ready",
  "Q2: Follow Our Sponsors": "Q2: Sponsors",
  "Q3: Download and Fund Base App": "Q3: Base App",
  "Q4: Set Up Trezor Wallet or Hot Wallet": "Q4: Wallet",
  "Q5: Swap on Base App": "Q5: Swap",
  "Q6: Stake in RootstockCollective": "Q6: Rootstock",
  "Q7: Decentraland Avatar": "Q7: Decentraland",
  "Q8: Bonus Coinfello AI Action": "Q8: Coinfello (Bonus)",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTypeformAll(formId) {
  const items = [];
  let before = null;
  while (true) {
    let url = `https://api.typeform.com/forms/${formId}/responses?page_size=1000`;
    if (before) url += `&before=${before}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TYPEFORM_TOKEN}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Typeform ${formId} ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
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
  return null;
}

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
    const data = await notionApi(`/databases/${NOTION_DATABASE_ID}/query`, {
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

async function patchPage(pageId, properties) {
  return notionApi(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export default async function handler(req, res) {
  // Optional auth check (Vercel cron auto-attaches Authorization: Bearer <CRON_SECRET>)
  if (CRON_SECRET) {
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const missing = {
    TYPEFORM_TOKEN: !TYPEFORM_TOKEN,
    NOTION_TOKEN: !NOTION_TOKEN,
    NOTION_DATABASE_ID: !NOTION_DATABASE_ID,
  };
  if (missing.TYPEFORM_TOKEN || missing.NOTION_TOKEN || missing.NOTION_DATABASE_ID) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  const startedAt = new Date().toISOString();
  const summary = {
    startedAt,
    typeformCounts: {},
    rowsScanned: 0,
    rowsUpdated: 0,
    cellsUpdated: 0,
    errors: [],
  };

  try {
    // 1) Pull Typeform completions: email -> Set of quest col names
    const emailToQuests = new Map();
    for (const { id, col } of FORMS) {
      const items = await fetchTypeformAll(id);
      summary.typeformCounts[col] = items.length;
      for (const item of items) {
        const email = extractEmail(item);
        if (!email) continue;
        if (!emailToQuests.has(email)) emailToQuests.set(email, new Set());
        emailToQuests.get(email).add(col);
      }
    }

    // 2) Pull all Notion rows
    const rows = await fetchAllNotionRows();
    summary.rowsScanned = rows.length;

    // 3) For each row, compute upgrades and patch if anything changed.
    //    Rules:
    //    - Only upgrade Not started / In progress / blank -> Submitted.
    //    - Never overwrite Verified (Maggie sets that manually).
    //    - Never downgrade.
    //    - Last completed quest = highest Q number among Submitted/Verified.
    for (const page of rows) {
      const email = getEmail(page);
      if (!email) continue;
      const completed = emailToQuests.get(email);

      const propsToUpdate = {};

      for (const { col } of FORMS) {
        const current = getSelectName(page, col);
        const hasCompletion = completed?.has(col);
        if (hasCompletion && current !== "Submitted" && current !== "Verified") {
          propsToUpdate[col] = { select: { name: "Submitted" } };
        }
      }

      // Compute Last completed quest (highest Q among already-set + about-to-be-set)
      const completedCols = [];
      for (const { col } of FORMS) {
        const current = getSelectName(page, col);
        const willBeSubmitted = propsToUpdate[col]?.select?.name === "Submitted";
        if (current === "Submitted" || current === "Verified" || willBeSubmitted) {
          completedCols.push(col);
        }
      }
      if (completedCols.length > 0) {
        const highest = completedCols
          .map((c) => ({ c, n: parseInt(c.match(/Q(\d)/)[1], 10) }))
          .sort((a, b) => b.n - a.n)[0].c;
        const shortName = QUEST_SHORT_NAMES[highest];
        const currentLast = page.properties?.["Last completed quest"]?.select?.name;
        if (currentLast !== shortName) {
          propsToUpdate["Last completed quest"] = { select: { name: shortName } };
        }
      }

      const changedKeys = Object.keys(propsToUpdate);
      if (changedKeys.length === 0) continue;

      try {
        await patchPage(page.id, propsToUpdate);
        summary.rowsUpdated++;
        summary.cellsUpdated += changedKeys.length;
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
