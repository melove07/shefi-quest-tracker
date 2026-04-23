# SheFi Quest Tracker — Project Context

## Owner
- **Name:** Maggie
- **GitHub username:** melove07
- **GitHub email:** maggielove890@gmail.com

## Repo
- **GitHub:** https://github.com/melove07/shefi-quest-tracker
- **Vercel:** https://shefi-quest-tracker.vercel.app

## Deployment
- Repo is linked to Vercel — pushing to `main` triggers an automatic deploy
- Environment variables are set in Vercel dashboard (`TYPEFORM_TOKEN`, `VITE_TYPEFORM_TOKEN`)
- Do NOT commit `.env` to GitHub

## Git Setup
- Remote is already configured: `origin https://github.com/melove07/shefi-quest-tracker.git`
- Auth is via personal access token in the remote URL
- Global git config: `user.email = maggielove890@gmail.com`, `user.name = melove07`

## Stack
- Vite + React (JSX)
- Typeform API for quest response data
- Vercel serverless function at `api/typeform.js` proxies Typeform requests

## Typeform Form IDs
- `iIiQAwun` — Get Ready for SheFi Season
- `RWRJvUnW` — Download Base & Buy Your First Crypto
- `b1ekAd1e` — Set Up Trezor Cold Wallet or Hot Wallet
- `lFat2TQw` — Complete a Trade on the Base App
- `HUghpqnk` — Follow Our Sponsors
- `OStCrx5O` — Stake in RootstockCollective DAO
- `a3NhVSaE` — Download Decentraland
- `h24RwqF6` — Connect Your Wallet to Coinfello & Do an AI Crypto Action (Bonus)
