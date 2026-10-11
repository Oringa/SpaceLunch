# Deploying CENTRIFUGE to alonoring.com

`npm run build` produces a static `dist/` folder of HTML, JS and CSS. The game needs no simulation server, accounts or database; the physics runs in the player's browser. Asset paths are relative, so the same folder works at `alonoring.com/centrifuge/`, at a subdomain, or anywhere else. It must be served over HTTP(S). Opening `index.html` from disk does not work, because browsers block module workers on `file://`.

The repository also ships a small production server, `npm start` (`scripts/serve-subpath.mjs`, Node only, no dependencies). It serves `dist/` under `/centrifuge/`, redirects `/` there, answers `/healthz`, compresses with brotli/gzip, and caches hashed assets for a year.

## Option R: Railway (recommended)

`railway.json` already configures everything: build `npm run build`, start `npm start`, health check `/healthz`, restart on failure. Railway sets `PORT` and the server binds to it.

### 1. Deploy

1. Railway dashboard → **New Project → Deploy from GitHub repo** → `Oringa/SpaceLunch`.
2. In the service's **Settings → Source**, choose the branch: `main` once this work is merged, or `claude/centrifuge-kinetic-launch` to try it now. Railway redeploys on every push to that branch.
3. Wait for the first deploy to go green. Railway installs with `npm ci`, using Node 22 from `engines`, then builds and starts.
4. **Settings → Networking → Generate Domain**, then open `https://<name>.up.railway.app/centrifuge/`. The bare domain redirects there.

No environment variables are needed. Optional: `BASE_PATH` changes the mount path (default `/centrifuge/`).

### 2. Put it on your domain (GoDaddy DNS)

**R1, subdomain: `centrifuge.alonoring.com`.** This works with GoDaddy DNS and changes nothing else on alonoring.com.

1. Railway: service **Settings → Networking → Custom Domain** → `centrifuge.alonoring.com`. If Railway asks for a target port, choose the port the service listens on (the one shown next to the generated domain). Railway then shows a CNAME target such as `abc123.up.railway.app`, and sometimes a TXT verification record.
2. GoDaddy: **My Products → Domains → alonoring.com → DNS → Add New Record**:
   - Type `CNAME`, Name `centrifuge`, Value = the target Railway showed, TTL default.
   - If Railway asked for a TXT record, add it exactly as shown, for example Name `_railway-verify.centrifuge`.
3. Wait for Railway to show the domain as verified and the certificate as issued. This takes minutes to an hour. Then open `https://centrifuge.alonoring.com/centrifuge/`. `https://centrifuge.alonoring.com/` redirects there.

   To serve the game at the root of the subdomain instead, set the service variable `BASE_PATH=/` and redeploy. The build is relative, so no rebuild flags are needed.

**R2, exact path: `alonoring.com/centrifuge`.** A path on the apex belongs to whatever serves `alonoring.com`, so that server must forward `/centrifuge/*` to the game. The game already lives under `/centrifuge/`, so the request path is passed through unchanged; nothing is rewritten.

- *Main site is also on Railway* (same project): add a reverse-proxy rule in the main site's service that forwards `/centrifuge/` to the game over private networking: `http://<game-service>.railway.internal:<PORT>/centrifuge/`. Set the game service variable `PORT=8080`, for example, so the internal port is fixed. Railway's private networking can be IPv6; when `HOST` is unset, the server listens dual-stack. Examples:
  - Express with http-proxy-middleware v3: `app.use(createProxyMiddleware({ target: 'http://centrifuge.railway.internal:8080', pathFilter: '/centrifuge' }))`
  - Next.js `next.config.js`: `rewrites: async () => [{ source: '/centrifuge/:path*', destination: 'https://<name>.up.railway.app/centrifuge/:path*' }]`
  - Caddy: `handle /centrifuge* { reverse_proxy centrifuge.railway.internal:8080 }`
  - nginx: `location /centrifuge/ { proxy_pass http://centrifuge.railway.internal:8080; }`
- *Main site on GoDaddy cPanel hosting*: no proxy is needed. Copy `dist/` into `public_html/centrifuge/` (Option A below).
- *Main site on GoDaddy Website Builder*: it cannot proxy or host sub-paths. Use R1, or move the apex to a host you control.

Note: GoDaddy DNS cannot point the apex `alonoring.com` itself at Railway, because it lacks CNAME flattening (ALIAS) at `@`. Moving the whole apex to Railway would mean switching nameservers to a provider that has it, such as Cloudflare. R1 avoids this.

### Updating

Push to the deployed branch and Railway rebuilds. Each deploy runs the type-check as part of `npm run build`, so a broken commit fails the build instead of replacing the live site.

## Option A: GoDaddy web hosting (cPanel) → `alonoring.com/centrifuge`

Use this if a GoDaddy *Web Hosting* plan (Linux/cPanel) serves alonoring.com. The game is then just files next to your site; no Railway is needed.

1. Build (or use the provided `centrifuge-dist.zip`): `npm ci && npm run build`.
2. In GoDaddy: **My Products → Web Hosting → Manage → cPanel Admin → File Manager**.
3. Open `public_html/`, create a folder named `centrifuge`.
4. Upload the zip into `public_html/centrifuge/` and choose **Extract**. Make sure `index.html` and the `assets/` folder end up directly inside `centrifuge/`, not in a nested `dist/` folder.
5. Visit `https://alonoring.com/centrifuge/`. Include the trailing slash; most hosts add it automatically.

Updating later: rebuild and replace the folder contents.

## Option B: GoDaddy holds only the domain (or a Website Builder site) → GitHub Pages

GoDaddy Website Builder cannot host an app at a sub-path. GitHub Pages hosts it free.

1. In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge the branch into `main`, or run the **CI and GitHub Pages** workflow manually from the *Actions* tab. The workflow tests, builds and deploys `dist/`.

Then pick a URL:

**B1, subdomain (simplest): `centrifuge.alonoring.com`**

3. GitHub repo **Settings → Pages → Custom domain**: `centrifuge.alonoring.com`, then tick *Enforce HTTPS* once the certificate is issued.
4. GoDaddy: **My Products → Domains → alonoring.com → DNS → Add record**: Type `CNAME`, Name `centrifuge`, Value `oringa.github.io`, TTL default.

**B2, exact path: `alonoring.com/centrifuge`**

GitHub serves every project repository of an account under the account's custom domain. To use this:

3. Create a repository named `Oringa.github.io` (it can hold a simple home page) and set its Pages custom domain to `alonoring.com`.
4. GoDaddy DNS for the apex: four `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, plus `CNAME` `www` → `oringa.github.io`. Do not do this if alonoring.com already hosts a site you want to keep.
5. Rename this repository to `centrifuge` (Settings → General). With Pages enabled it then appears at `https://alonoring.com/centrifuge/`.

DNS changes can take from a few minutes to a few hours.

## Checking a deployment

Locally, `npm run build && npm start` runs exactly what Railway runs, at `http://127.0.0.1:4173/centrifuge/`. With `PORT=8080 npm start` it listens on all interfaces, as on Railway. `npm run serve:subpath` is the same server, used by the Playwright tests (`npm run test:browser`).

After deploying, check:

- `https://<host>/healthz` → `ok`
- `https://<host>/centrifuge/` → the mission map loads. *Start here* → **LAUNCH** shows the spin-up, then the flight.
- The browser devtools Network tab shows the `simulation.worker` script loading with status 200. If it fails, the path or base is wrong.
