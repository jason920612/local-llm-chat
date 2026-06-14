---
name: discover-api
description: Discover backend JSON/GraphQL APIs and explore boundaries/endpoints for security testing and authorized pentesting. Use to find hidden APIs, map attack surface, test for misconfigurations instead of scraping HTML. Focus on boundary exploration (what endpoints exist, what params they accept, how auth is enforced).
---

# Discover a site's backend API and call it directly

Many sites render data from a JSON/GraphQL API that's far cleaner to use than
scraping HTML. Find that API by inspecting what the site itself does, then request
it directly.

## Procedure

1. **Probe with the bundled script** (read-only: tries standard discovery paths,
   scans the site's own frontend JS for endpoint URLs, checks OpenAPI/Swagger and
   GraphQL):
   ```bash
   pip install -q requests beautifulsoup4 lxml   # usually already installed
   python scripts/probe.py https://example.com
   ```

2. **If OpenAPI/Swagger is found** (`/openapi.json`, `/swagger.json`, `/v3/api-docs`…):
   you now have the full endpoint list + parameters — read it and call what you need.

3. **If GraphQL is exposed**: run an introspection query to get the schema, then
   write a focused query:
   ```bash
   curl -s -X POST https://example.com/graphql -H 'content-type: application/json' \
     -d '{"query":"{__schema{queryType{name} types{name}}}"}' | python -m json.tool | head -60
   ```

4. **Otherwise, learn from the frontend**: the probe lists `/api/...` URLs found in
   the JS. Open the relevant JS (or use the mirror-site skill) and read how it
   builds the request — method, path, query params, and headers (Content-Type,
   any public tokens it sends).

5. **Test the request directly** and inspect the response shape:
   ```bash
   curl -s 'https://example.com/api/v1/items?limit=5' -H 'accept: application/json' | python -m json.tool | head -40
   # or in python: requests.get(url, params=..., headers=...).json()
   ```
   Then iterate params until you get the data you need, and use it.

## Notes
- Prefer a documented endpoint (OpenAPI/GraphQL schema) over guessing; replicate
  the exact headers/Content-Type the site's own frontend sends.
- Keep request volume light with a small delay so probing stays fast and reliable;
  back off on 429.
