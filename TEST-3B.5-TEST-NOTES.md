# Test 3B.5 — School Building & Education Data

## Test sequence
1. Start from a saved study and complete Test 3B.4 OSM Data Collection.
2. For this milestone, use an Iowa-only study such as Ogden/Madrid.
3. Click **Run School Building + Education Test**.
4. Verify candidate OSM buildings are identified within 150 meters of each OSM school feature.
5. Verify the browser fetches and parses the official Iowa Department of Education 2025-26 building directory, 2025-26 building enrollment, and 2020-21 building enrollment files.
6. Review the OSM-to-DOE evidence table. Match results are deterministic name-based test results only; they are not final reconciliation decisions.

## Data sources
- Iowa PK-12 Education Statistics: https://educate.iowa.gov/pk-12/data/education-statistics
- 2025-26 Public School Building Directory: https://educate.iowa.gov/media/11648/download?inline=
- 2025-26 Public School Building enrollment: https://educate.iowa.gov/media/12228/download?inline=
- 2020-21 Public School Building enrollment: https://educate.iowa.gov/media/7631/download?inline=

The education files are fetched directly by browser JavaScript. If the Iowa DOE site blocks cross-origin browser requests, the UI reports that a Worker proxy may be needed; no silent proxy is introduced in this milestone.

## Scope boundary
This milestone does not:
- edit OpenStreetMap;
- automatically select an authoritative school building;
- use AI;
- write OSM/DOE reconciliation results to GitHub.
