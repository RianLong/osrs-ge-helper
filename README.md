# GE Helper (OSRS)

A web app for making money on the Old School RuneScape Grand Exchange. Use it on the website, or run it on your own PC.

## Use it online
The site is published from this repository by GitHub Pages. Every push to `main` redeploys it automatically (see `.github/workflows/pages.yml`, which publishes the `public/` folder).

On the website, your settings, bank and trades are saved in your browser. They don't follow you to other devices; use **Settings & Help → Download backup / Restore backup** to move them.

### Hiscores lookup (Cloudflare Worker)
The official hiscores can't be called from a web page, so the site looks up levels through a small free Cloudflare Worker, `worker/hiscores.js`. To set it up:
1. Sign in at https://dash.cloudflare.com and open **Workers & Pages → Create → Create Worker**.
2. Name it (for example `ge-hiscores`) and click **Deploy**.
3. Click **Edit code**, replace everything with the contents of `worker/hiscores.js`, and click **Deploy** again.
4. Copy the worker's address (like `https://ge-hiscores.yourname.workers.dev`).
5. Paste it into `public/config.js` as `hiscoresProxy` and push, or just paste it into **Settings & Help** on the site.

## Run it on your PC
Needs Node.js 18 or newer. There's nothing to install.

    node server.js

Then open http://localhost:3000. Running locally, data is saved in `data/state.json` and the local server handles price and hiscore lookups itself (no Worker needed).

Set the `OSRS_UA` environment variable to add your own contact to the User-Agent the wiki receives. Set `PORT` to change the port.

## What's inside
- **Dashboard**: a Smart Plan that fills your GE slots for the cash you have, with tracked trades pinned and walked through Bought → Listed → Sold, plus price dips, spikes and volume surges.
- **Quick Flips**: every profitable flip with its margin after tax, realistic quantity, fill time and a confidence rating.
- **Skilling Profits**: about 120 processing methods (herblore, cooking, fletching, crafting, smithing, enchanting, sawmill, tanning), plus potion decanting and high alchemy, filtered by your levels.
- **Deep Analysis**: a price chart, cheap/expensive signal, a 1h and 4h forecast, and quick or patient offer prices for any item.
- **My Trades**: all your offers with live advice to raise, lower, sell, hold or cancel. Desktop notifications are optional.
- **Character & Bank**: skill levels from the hiscores, and a pasted bank import (the RuneLite Bank Memory plugin's "Copy item data to clipboard" works) with suggestions for each item.

## Data sources
- Prices: OSRS Wiki real-time prices API (https://prices.runescape.wiki).
- Levels: the official OSRS hiscores.
