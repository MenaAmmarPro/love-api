# love-api

The wishes-wall backend for the [Love for Mena](https://menaammarpro.github.io/)
sites — a tiny **Cloudflare Worker** over a **Workers KV** namespace.

It stores the kind notes people leave on the wishes wall and serves them back,
so the wall works for **any** visitor (no GitHub account needed).

## API

Base URL: `https://love-api.<your-subdomain>.workers.dev`

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | Liveness check — `{ ok: true, service: "love-api" }` |
| `GET` | `/wishes?limit=1..100&cursor=` | Newest-first list of wishes |
| `POST` | `/wishes` | Add a wish — body `{ name, message, website }` |

`POST /wishes` rules:

- `name` — optional, max 40 chars (defaults to "Someone")
- `message` — required, max 280 chars
- `website` — **honeypot**; must be empty. Bots that fill it get a fake `201`
  and nothing is stored.
- Per-IP rate limit: 5 writes per minute (`429` when exceeded)
- A light abuse guard rejects links / obvious spam (`422`)
- Control characters are stripped and whitespace is collapsed

Responses are JSON and CORS is locked to the org domain (plus localhost for
development). Wishes appear **instantly** — no approval step.

## One-time setup

Requires a free [Cloudflare](https://dash.cloudflare.com/) account.

1. **Install the CLI** and log in:

   ```powershell
   npm install
   npx wrangler login
   ```

2. **Create the KV namespace** and copy the returned `id`:

   ```powershell
   npx wrangler kv namespace create WISHES
   ```

3. **Paste the id** into `wrangler.toml` (replace `PASTE_KV_NAMESPACE_ID_HERE`).

4. **Deploy**:

   ```powershell
   npm run deploy
   ```

   Wrangler prints the Worker URL — it looks like
   `https://love-api.<your-subdomain>.workers.dev`.

5. **Tell the website.** In the `loveformymena` repo, open `js/config.js` and set:

   ```js
   window.MENA_CONFIG = { wishesApi: "https://love-api.<your-subdomain>.workers.dev" };
   ```

## Auto-deploy via GitHub Actions

`.github/workflows/deploy.yml` runs the tests, then deploys on every push to
`main`. Add two repository secrets (**Settings → Secrets and variables →
Actions**):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with **Workers Scripts:Edit** and **Workers KV Storage:Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id |

Until you paste a real KV id into `wrangler.toml`, the workflow **skips** the
deploy with a warning (the tests still run), so nothing breaks.

## Develop & test

```powershell
npm test        # node --test (no extra dependencies)
npm run dev     # local Worker at http://localhost:8787
```

## Files

- `src/index.js` — routing, CORS, validation, rate limit, abuse guard
- `src/store.js` — KV read/write helpers (time-sortable keys)
- `test/index.test.js` — unit tests against an in-memory KV
- `test/mock-kv.js` — the in-memory KV stand-in
- `wrangler.toml` — Worker config + KV binding

## License

Creative Commons BY-NC-ND 4.0 — see [`LICENSE`](LICENSE).
© 2026 Ammar (MenaAmmarPro). Made with care for Mena.
