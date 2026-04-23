import { useState, useEffect, useMemo, useCallback } from "react";

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  CONFIG — Paste your Typeform Personal Access Token below                 ║
// ╚════════════════════════════════════════════════════════════════════════════╝
const TYPEFORM_TOKEN = import.meta.env.VITE_TYPEFORM_TOKEN;

const QUESTS = [
  {
    id: "iIiQAwun",
    title: "Get Ready for SheFi Season",
    emoji: "🌟",
    category: "Onboarding",
    points: 20,
    description: "Kick off your SheFi journey — get set up and ready to learn.",
  },
  {
    id: "RWRJvUnW",
    title: "Download Base & Buy Your First Crypto",
    emoji: "💰",
    category: "DeFi",
    points: 30,
    description: "Get the Base app, fund your wallet, and make your first crypto purchase.",
  },
  {
    id: "b1ekAd1e",
    title: "Set Up Trezor Cold Wallet or Hot Wallet",
    emoji: "🔐",
    category: "Security",
    points: 35,
    description: "Secure your assets by setting up a hardware or software wallet.",
  },
  {
    id: "lFat2TQw",
    title: "Complete a Trade on the Base App",
    emoji: "📈",
    category: "DeFi",
    points: 30,
    description: "Execute your first swap or trade using the Base app.",
  },
  {
    id: "HUghpqnk",
    title: "Follow Our Sponsors",
    emoji: "🤝",
    category: "Community",
    points: 10,
    description: "Show some love — follow the sponsors making SheFi possible.",
  },
  {
    id: "OStCrx5O",
    title: "Stake in RootstockCollective DAO",
    emoji: "🗳️",
    category: "DAO",
    points: 40,
    description: "Participate in governance by staking in the RootstockCollective DAO.",
  },
  {
    id: "a3NhVSaE",
    title: "Download Decentraland",
    emoji: "🌐",
    category: "Metaverse",
    points: 25,
    description: "Step into Web3's virtual world — download and explore Decentraland.",
  },
  {
    id: "h24RwqF6",
    title: "Connect Your Wallet to Coinfello & Do an AI Crypto Action",
    emoji: "🤖",
    category: "Bonus",
    points: 25,
    description: "Connect your wallet to Coinfello and complete an AI-powered crypto action.",
  },
];

// ── Typeform API fetcher ─────────────────────────────────────────────────────
function buildUrl(formId, before) {
  const params = `page_size=1000${before ? `&before=${before}` : ""}`;
  if (import.meta.env.PROD) {
    return `/api/typeform?formId=${formId}&${params}`;
  }
  return `/api/typeform/forms/${formId}/responses?${params}`;
}

async function fetchFormResponses(formId) {
  try {
    const allItems = [];
    let before = null;
    while (true) {
      const res = await fetch(buildUrl(formId, before), {
        headers: { Authorization: `Bearer ${TYPEFORM_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = data.items || [];
      allItems.push(...items);
      if (items.length < 1000) break;
      before = items[items.length - 1].token;
    }
    return allItems;
  } catch (err) {
    console.error(`Failed to fetch form ${formId}:`, err);
    return [];
  }
}

function extractPerson(response) {
  const answers = response.answers || [];

  // 1. Look for a typed email answer
  const emailAnswer = answers.find((a) => a.type === "email");
  let email = emailAnswer?.email || "";

  let name = "";

  if (email) {
    // 2. Derive display name from email prefix
    const prefix = email.split("@")[0];
    const readable = prefix.replace(/\./g, " ").trim();
    name = readable.charAt(0).toUpperCase() + readable.slice(1);
  } else {
    // 3. Fall back to text fields, skipping wallet addresses
    for (const answer of answers) {
      if (answer.type === "text" || answer.type === "short_text") {
        const text = answer.text || "";
        if (!text.startsWith("0x")) {
          name = text;
          break;
        }
      }
    }
  }

  if (!name) name = "Anonymous";

  return { name, email: email || `${name.toLowerCase().replace(/\s/g, "")}@unknown` };
}

// ── Color generator ──────────────────────────────────────────────────────────
const COLORS = [
  "#E8594F","#4E8FE8","#44B87F","#D4A03C","#9B6BD4",
  "#E07C4A","#49B6A8","#D45B8C","#7B8FE0","#5BAE5F",
  "#C97038","#6C8FC4","#D45D5D","#4EBFA5","#B07ACC",
];
function getColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}
function getInitials(name) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}
function formatName(name) {
  if (/^0x[0-9a-fA-F]{10,}$/.test(name)) {
    return `${name.slice(0, 6)}...${name.slice(-4)}`;
  }
  if (/^[a-z0-9.]+$/.test(name)) {
    const readable = name.replace(/[.0-9]+/g, " ").trim();
    return readable.charAt(0).toUpperCase() + readable.slice(1);
  }
  return name;
}
function truncate(str, max = 12) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Space+Mono:wght@400;700&display=swap');

  :root {
    --bg: #FFF5F7;
    --surface: #FFFFFF;
    --surface-hover: #FFF0F3;
    --border: #F2C4CE;
    --text: #2D1B24;
    --text-muted: #A07080;
    --coral: #F4614D;
    --coral-dim: rgba(244, 97, 77, 0.10);
    --green: #2E9E6B;
    --green-dim: rgba(46, 158, 107, 0.10);
    --pink: #E84393;
    --pink-dim: rgba(232, 67, 147, 0.10);
    --peach: #F97B5B;
    --peach-dim: rgba(249, 123, 91, 0.10);
    --gold: #C47B2B;
    --gold-dim: rgba(196, 123, 43, 0.10);
    --radius: 12px;
    --font: 'DM Sans', system-ui, sans-serif;
    --mono: 'Space Mono', monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body, #root {
    background: var(--bg);
    background-image: radial-gradient(ellipse at 10% 0%, rgba(249, 123, 91, 0.12) 0%, transparent 55%),
                      radial-gradient(ellipse at 90% 5%, rgba(232, 67, 147, 0.10) 0%, transparent 50%);
    background-attachment: fixed;
    color: var(--text); font-family: var(--font); min-height: 100vh;
  }

  .app { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }

  .header {
    display: flex; align-items: flex-end; justify-content: space-between;
    margin-bottom: 36px; flex-wrap: wrap; gap: 16px;
  }
  .header h1 {
    font-size: 28px; font-weight: 700; letter-spacing: -0.5px;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(120deg, var(--coral), var(--pink));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .header h1 span.icon {
    font-size: 26px; display: inline-flex; align-items: center; justify-content: center;
    width: 42px; height: 42px;
    background: linear-gradient(135deg, #FFCDD5, #FFB5C8);
    border-radius: 10px; -webkit-text-fill-color: initial;
  }
  .header p { color: var(--text-muted); font-size: 14px; margin-top: 4px; }

  .tabs {
    display: flex; gap: 4px; background: var(--surface); border-radius: 12px;
    padding: 4px; border: 1px solid var(--border);
    box-shadow: 0 1px 4px rgba(232, 67, 147, 0.08);
  }
  .tab {
    padding: 8px 18px; border-radius: 9px; font-size: 13px; font-weight: 500;
    cursor: pointer; color: var(--text-muted); transition: all 0.15s; border: none;
    background: transparent; font-family: var(--font);
  }
  .tab:hover { color: var(--coral); }
  .tab.active { background: linear-gradient(135deg, var(--coral-dim), var(--pink-dim)); color: var(--coral); }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 28px;
  }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 20px;
    box-shadow: 0 2px 8px rgba(232, 67, 147, 0.06);
  }
  .stat-card .label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-muted); font-family: var(--mono); margin-bottom: 6px;
  }
  .stat-card .value { font-size: 28px; font-weight: 700; letter-spacing: -1px; }
  .stat-card .value.accent { color: var(--coral); }
  .stat-card .value.green { color: var(--green); }
  .stat-card .value.pink { color: var(--pink); }

  .quest-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 14px; margin-bottom: 28px;
  }
  .quest-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 22px;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
    box-shadow: 0 2px 8px rgba(232, 67, 147, 0.06);
  }
  .quest-card:hover { border-color: var(--pink); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(232, 67, 147, 0.12); }
  .quest-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
  .quest-emoji {
    font-size: 28px; width: 46px; height: 46px; display: flex;
    align-items: center; justify-content: center;
    background: linear-gradient(135deg, #FFE4EC, #FFD0DC); border-radius: 10px;
  }
  .quest-points {
    font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--gold);
    background: var(--gold-dim); padding: 4px 10px; border-radius: 20px;
    border: 1px solid rgba(196, 123, 43, 0.2);
  }
  .quest-card h3 { font-size: 16px; font-weight: 600; margin-bottom: 6px; color: var(--text); }
  .quest-card .desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 14px; }
  .quest-category {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--peach); font-family: var(--mono); margin-bottom: 14px;
  }
  .quest-count {
    font-family: var(--mono); font-size: 12px; color: var(--green);
    margin-bottom: 10px;
  }
  .quest-people { display: flex; flex-wrap: wrap; gap: 6px; }
  .person-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px 4px 4px; border-radius: 20px; font-size: 12px;
    font-weight: 500; border: 1px solid var(--border); background: var(--bg);
    color: var(--text);
  }
  .person-chip .mini-avatar {
    width: 22px; height: 22px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 9px;
    font-weight: 700; color: #fff; flex-shrink: 0;
  }
  .no-signups { font-size: 12px; color: var(--text-muted); font-style: italic; }

  .leaderboard { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: 0 2px 8px rgba(232, 67, 147, 0.06); }
  .lb-header {
    display: grid; grid-template-columns: 50px 1fr 100px 100px;
    padding: 12px 20px; font-size: 11px; text-transform: uppercase;
    letter-spacing: 1px; color: var(--text-muted); font-family: var(--mono);
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(249,123,91,0.06), rgba(232,67,147,0.06));
  }
  .lb-row {
    display: grid; grid-template-columns: 50px 1fr 100px 100px;
    padding: 14px 20px; align-items: center; border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }
  .lb-row:last-child { border-bottom: none; }
  .lb-row:hover { background: var(--surface-hover); }
  .lb-rank { font-family: var(--mono); font-weight: 700; font-size: 15px; color: var(--text-muted); }
  .lb-rank.gold { color: var(--gold); }
  .lb-rank.silver { color: #8A9BAD; }
  .lb-rank.bronze { color: #B07040; }
  .lb-person { display: flex; align-items: center; gap: 12px; }
  .avatar {
    width: 34px; height: 34px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 12px;
    font-weight: 700; color: #fff; flex-shrink: 0;
  }
  .lb-person-name { font-weight: 600; font-size: 14px; color: var(--text); }
  .lb-quests { font-family: var(--mono); font-size: 14px; color: var(--green); text-align: center; }
  .lb-points { font-family: var(--mono); font-size: 16px; font-weight: 700; color: var(--coral); text-align: right; }
  .bar-track { width: 100%; height: 4px; background: var(--border); border-radius: 4px; margin-top: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--peach), var(--pink)); transition: width 0.6s cubic-bezier(0.22, 1, 0.36, 1); }

  .filter-row { display: flex; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
  .filter-pill {
    padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border); background: var(--surface);
    color: var(--text-muted); font-family: var(--font); transition: all 0.15s;
  }
  .filter-pill:hover { border-color: var(--coral); color: var(--coral); }
  .filter-pill.active { background: var(--coral-dim); border-color: var(--coral); color: var(--coral); }

  .search-bar {
    width: 100%; padding: 10px 16px; margin-bottom: 24px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text); font-family: var(--font); font-size: 14px; outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    box-shadow: 0 1px 4px rgba(232, 67, 147, 0.06);
  }
  .search-bar::placeholder { color: var(--text-muted); }
  .search-bar:focus { border-color: var(--coral); box-shadow: 0 0 0 3px rgba(244, 97, 77, 0.12); }

  .loading {
    text-align: center; padding: 60px 20px; color: var(--text-muted);
  }
  .loading .spinner {
    width: 32px; height: 32px; border: 3px solid var(--border);
    border-top-color: var(--coral); border-radius: 50%;
    animation: spin 0.8s linear infinite; margin: 0 auto 16px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-banner {
    background: rgba(244, 97, 77, 0.08); border: 1px solid rgba(244, 97, 77, 0.3);
    border-radius: var(--radius); padding: 16px 20px; margin-bottom: 20px;
    font-size: 13px; color: var(--coral); line-height: 1.5;
  }
  .error-banner code {
    font-family: var(--mono); font-size: 12px; background: rgba(244, 97, 77, 0.10);
    padding: 2px 6px; border-radius: 4px;
  }

  .refresh-btn {
    padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: 1px solid var(--border); background: var(--surface);
    color: var(--text-muted); font-family: var(--font); transition: all 0.15s;
  }
  .refresh-btn:hover { border-color: var(--coral); color: var(--coral); }

  @media (max-width: 700px) {
    .lb-header, .lb-row { grid-template-columns: 36px 1fr 60px 70px; padding: 10px 12px; }
    .quest-grid { grid-template-columns: 1fr; }
  }
`;

// ── Main Component ────────────────────────────────────────────────────────────
export default function QuestTracker() {
  const [view, setView] = useState("quests");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [questSignups, setQuestSignups] = useState({}); // { formId: [{ name, email }] }

  const fetchAll = useCallback(async () => {
    if (TYPEFORM_TOKEN === "YOUR_TOKEN_HERE") {
      setError("token_missing");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const results = {};
      await Promise.all(
        QUESTS.map(async (quest) => {
          const responses = await fetchFormResponses(quest.id);
          if (responses[0]) console.log("Form", quest.id, "sample:", JSON.stringify(responses[0], null, 2));
          const seen = new Map();
          for (const r of responses) {
            const person = extractPerson(r);
            const key = person.email;
            if (!seen.has(key) || new Date(r.submitted_at) > new Date(seen.get(key).submitted_at)) {
              seen.set(key, { person, submitted_at: r.submitted_at });
            }
          }
          results[quest.id] = [...seen.values()].map(({ person }) => person);
        })
      );
      setQuestSignups(results);
    } catch (err) {
      setError("fetch_failed");
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const categories = ["All", ...new Set(QUESTS.map((q) => q.category))];
  const filteredQuests = categoryFilter === "All" ? QUESTS : QUESTS.filter((q) => q.category === categoryFilter);

  // Build leaderboard from signups
  const leaderboard = useMemo(() => {
    const scores = {};
    Object.entries(questSignups).forEach(([questId, people]) => {
      const quest = QUESTS.find((q) => q.id === questId);
      if (!quest) return;
      people.forEach((person) => {
        const key = person.email || person.name;
        if (!scores[key]) scores[key] = { name: person.name, email: person.email, quests: 0, points: 0 };
        scores[key].quests += 1;
        scores[key].points += quest.points;
      });
    });
    return Object.values(scores).sort((a, b) => b.points - a.points);
  }, [questSignups]);

  const maxPoints = leaderboard[0]?.points || 1;
  const totalSignups = Object.values(questSignups).reduce((sum, arr) => sum + arr.length, 0);
  const uniquePeople = new Set(Object.values(questSignups).flatMap((arr) => arr.map((p) => p.email || p.name))).size;

  const matchesSearch = (person) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return person.name.toLowerCase().includes(q) || person.email.toLowerCase().includes(q);
  };
  const filteredLeaderboard = leaderboard.filter(matchesSearch);

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="header">
          <div>
            <h1>
              <span className="icon">✨</span>
              SheFi Quest Tracker
            </h1>
            <p>See who's tackling quests and where the leaderboard stands.</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!loading && (
              <button className="refresh-btn" onClick={fetchAll}>↻ Refresh</button>
            )}
            <div className="tabs">
              <button className={`tab ${view === "quests" ? "active" : ""}`} onClick={() => setView("quests")}>
                Quests
              </button>
              <button className={`tab ${view === "leaderboard" ? "active" : ""}`} onClick={() => setView("leaderboard")}>
                Leaderboard
              </button>
            </div>
          </div>
        </div>

        {error === "token_missing" && (
          <div className="error-banner">
            👋 Paste your Typeform token in the <code>TYPEFORM_TOKEN</code> variable at the top of this file.
            Get one from <strong>admin.typeform.com → Settings → Personal tokens</strong>.
          </div>
        )}
        {error === "fetch_failed" && (
          <div className="error-banner">
            Failed to fetch Typeform responses. Check your token and that the form IDs are correct.
          </div>
        )}

        {loading ? (
          <div className="loading">
            <div className="spinner" />
            <p>Fetching quest data from Typeform…</p>
          </div>
        ) : (
          <>
            <div className="stats">
              <div className="stat-card">
                <div className="label">Quests</div>
                <div className="value accent">{QUESTS.length}</div>
              </div>
              <div className="stat-card">
                <div className="label">Total Quest Completions</div>
                <div className="value green">{totalSignups}</div>
              </div>
              <div className="stat-card">
                <div className="label">Participants</div>
                <div className="value pink">{uniquePeople}</div>
              </div>
            </div>

            <input
              className="search-bar"
              type="text"
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            {view === "quests" && (
              <>
                <div className="filter-row">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      className={`filter-pill ${categoryFilter === cat ? "active" : ""}`}
                      onClick={() => setCategoryFilter(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div className="quest-grid">
                  {filteredQuests.map((quest) => {
                    const people = (questSignups[quest.id] || []).filter(matchesSearch);
                    return (
                      <div key={quest.id} className="quest-card">
                        <div className="quest-top">
                          <div className="quest-emoji">{quest.emoji}</div>
                          <div className="quest-points">{quest.points} pts</div>
                        </div>
                        <div className="quest-category">{quest.category}</div>
                        <h3>{quest.title}</h3>
                        <p className="desc">{quest.description}</p>
                        {people.length > 0 && (
                          <div className="quest-count">{people.length} signed up</div>
                        )}
                        <div className="quest-people">
                          {people.length === 0 && (
                            <span className="no-signups">No one yet — be the first!</span>
                          )}
                          {people.slice(0, 20).map((person, i) => (
                            <span key={i} className="person-chip">
                              <span className="mini-avatar" style={{ background: getColor(person.name) }}>
                                {getInitials(person.name)}
                              </span>
                              {truncate(formatName(person.name).split(" ")[0])}
                            </span>
                          ))}
                          {people.length > 20 && (
                            <span className="person-chip" style={{ color: "var(--text-muted)" }}>
                              +{people.length - 20} more
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {view === "leaderboard" && (
              <div className="leaderboard">
                <div className="lb-header">
                  <span>#</span>
                  <span>Person</span>
                  <span style={{ textAlign: "center" }}>Quests</span>
                  <span style={{ textAlign: "right" }}>Points</span>
                </div>
                {filteredLeaderboard.length === 0 && (
                  <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
                    {searchQuery ? "No results match your search." : "No quest completions yet — leaderboard will populate as people sign up."}
                  </div>
                )}
                {filteredLeaderboard.map((person, i) => (
                  <div key={person.email} className="lb-row">
                    <span className={`lb-rank ${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : ""}`}>
                      {i + 1}
                    </span>
                    <div className="lb-person">
                      <div className="avatar" style={{ background: getColor(person.name) }}>
                        {getInitials(person.name)}
                      </div>
                      <div>
                        <div className="lb-person-name">{formatName(person.name)}</div>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${(person.points / maxPoints) * 100}%` }} />
                        </div>
                      </div>
                    </div>
                    <div className="lb-quests">{person.quests}</div>
                    <div className="lb-points">{person.points}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
