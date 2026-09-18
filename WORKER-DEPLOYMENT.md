# Test 3B.3.5 — Worker Deployment

Test 3B.3.5 adds the application-level persistence endpoint:

`POST /api/v1/studies`

The endpoint accepts the browser's validated `study` object and its GeoJSON `studyArea` artifact and writes both files to the configured GitHub repository in a **single Git commit**:

- `data/studies.json`
- `data/studyAreas/{studyId}.geojson`

## Existing secret

The Worker expects the GitHub App private key as the existing Cloudflare secret:

`GITHUB_APP_PRIVATE_KEY`

Do not put the PEM private key in `worker.js`, this repository, or the browser application.

## Deploy

Use the Worker directory with Wrangler or paste `worker.js` into the existing Cloudflare Worker. The provided `wrangler.toml` is configured for the existing Worker name.

If the secret already exists, no secret change is required.

If configuring from the command line for a new environment:

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler deploy
```

The public application does not need a GitHub token.

## Routes retained

- `GET /health`
- `GET /github/status`
- `GET /github/test`
- `POST /api/v1/studies`

The GitHub App installation is restricted to the configured repository and receives only the Contents write permission when the installation token is minted. GitHub documents installation-token generation and repository Contents write access for installation tokens. The Worker then uses the Git database tree/commit/reference flow so the two study artifacts are committed together.

## Test 3B.3.5 acceptance test

1. Deploy the Worker.
2. Verify `/health` reports `version: 3B.3.5`.
3. Verify `/github/status` succeeds.
4. Open the GitHub Pages application.
5. Create the Ogden/Madrid study area.
6. Click **Save Study**.
7. Confirm the UI reports **Study Saved**.
8. Confirm the private GitHub repository contains:

```text
data/studies.json
data/studyAreas/{studyId}.geojson
```

9. Confirm both changes appear in the same Git commit.
10. Confirm **Continue to OSM Data Collection** becomes enabled.
