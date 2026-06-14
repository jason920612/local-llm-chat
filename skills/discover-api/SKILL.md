---
name: discover-api
description: Figure out a website's backend/JSON API so you can call it directly for PUBLIC data — instead of scraping HTML. Use when a site clearly loads data from an API (dynamic dashboards, infinite scroll, prices/charts) and you want structured data, or to learn how its frontend talks to its backend.
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

## Rules — stay legitimate

- **Public data and public endpoints only.** Do NOT try to bypass authentication,
  access another user's data, or reach anything behind a login you don't own.
- **No credential/key brute-forcing**, no large fuzzing wordlists, no DoS. Only the
  curated standard paths + endpoints the site itself references.
- **Respect robots.txt, the site's Terms, and rate limits**: keep requests light,
  add delays, stop if you get 401/403/429 or the site signals "don't".
- Only use API keys/tokens that are clearly meant to be public (e.g. ones the
  frontend ships openly for read-only public data); never exfiltrate secrets.
- If the data genuinely requires private/authenticated access, stop and tell the
  user instead of forcing it.
