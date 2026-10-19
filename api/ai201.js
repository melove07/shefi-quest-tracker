// AI 201 interest — thank-you / confirmation page.
// Linked from the "AI Will Survive" campaign secondary CTA. Tapping the CTA
// lands the reader here; beehiiv records the click so interested subscribers
// can be tagged `ai201_future_interest`. No data is collected on this page.

export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>You're on the list — AI 201</title>
<meta name="robots" content="noindex">
<style>
  :root{--bg:#fff6f9;--card:#ffffff;--ink:#2a1420;--mut:#7a5566;--brand:#de3163;--ring:#f7d4e1}
  @media (prefers-color-scheme:dark){:root{--bg:#1b0f15;--card:#261620;--ink:#f6eef2;--mut:#c6a6b5;--brand:#ff5f88;--ring:#3a2430}}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);max-width:520px;width:100%;border-radius:22px;padding:40px 32px;text-align:center;box-shadow:0 18px 50px rgba(222,49,99,.12);border:1px solid var(--ring)}
  .badge{font-size:46px;line-height:1;margin-bottom:12px}
  h1{font-size:27px;margin:0 0 14px;letter-spacing:-.4px}
  p{color:var(--mut);margin:0 0 16px}
  .sig{color:var(--ink);font-weight:600;margin-top:4px}
  .btn{display:inline-block;margin-top:22px;padding:13px 22px;border-radius:999px;background:var(--brand);color:#fff;text-decoration:none;font-weight:600;font-size:15px}
  .fine{margin-top:20px;font-size:13px;color:var(--mut)}
</style></head><body>
<div class="card">
  <div class="badge">🎉</div>
  <h1>You're on the list!</h1>
  <p>Thanks for raising your hand for <strong>AI 201</strong> — the next-level workshop, for when you're ready to go beyond the basics.</p>
  <p>I'm still building it. I'll email you the details the moment it's ready — you don't need to do anything else.</p>
  <p class="sig">— Maggie</p>
  <a class="btn" href="https://luma.com/9jo7q59f">See the Oct 29 class while you wait →</a>
  <p class="fine">You can close this tab — your spot on the 201 list is saved.</p>
</div>
</body></html>`);
}
