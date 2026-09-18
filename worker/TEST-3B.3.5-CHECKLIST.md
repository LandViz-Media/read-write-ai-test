# Test 3B.3.5 Verification Checklist

- [ ] `POST /api/v1/studies` responds through the existing Worker URL.
- [ ] Browser CORS preflight succeeds for `https://landviz-media.github.io`.
- [ ] Worker authenticates as GitHub App installation 162348099.
- [ ] `data/studies.json` is created/updated.
- [ ] `data/studyAreas/{studyId}.geojson` is created.
- [ ] Both files are in one Git commit.
- [ ] Save Study reports success only after the branch update succeeds.
- [ ] Continue to OSM Data Collection is enabled only after persistence succeeds.
