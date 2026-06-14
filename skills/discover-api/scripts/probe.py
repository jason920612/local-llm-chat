#!/usr/bin/env python3
"""Discover a website's backend API so you can call it directly for PUBLIC data.

It (read-only) probes standard API-discovery paths, scrapes the site's own
frontend JS for endpoint URLs, and checks for OpenAPI/Swagger and GraphQL. It
does NOT brute-force credentials, bypass auth, or flood the server.

Usage:
    python probe.py <base_url> [--js 8] [--delay 0.3]
"""
import argparse
import json
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (compatible; api-discovery-bot/1.0)"

# Standard, well-known discovery paths (a curated list — NOT a fuzzing wordlist).
COMMON = [
    "/openapi.json", "/openapi.yaml", "/swagger.json", "/swagger/v1/swagger.json",
    "/v2/api-docs", "/v3/api-docs", "/api-docs", "/api/swagger.json",
    "/api", "/api/v1", "/api/v2", "/api/health", "/api/status", "/status",
    "/graphql", "/api/graphql", "/.well-known/openid-configuration",
    "/robots.txt", "/sitemap.xml",
]

ENDPOINT_RES = [
    re.compile(r"""["'`](/api/[A-Za-z0-9_\-/.{}:]+)["'`]"""),
    re.compile(r"""["'`](https?://[A-Za-z0-9_\-.]*api[A-Za-z0-9_\-./{}:?=&]*)["'`]"""),
    re.compile(r"""["'`](/v\d+/[A-Za-z0-9_\-/.{}:]+)["'`]"""),
    re.compile(r"(/graphql\b)"),
]
SECRET_HINT = re.compile(r"(api[_-]?key|apikey|client[_-]?id|access[_-]?token|bearer)", re.I)


def get(session, url, **kw):
    try:
        return session.get(url, timeout=15, **kw)
    except Exception as e:
        return e


def short(r) -> str:
    ct = r.headers.get("content-type", "")
    body = r.text[:300].replace("\n", " ")
    return f"{r.status_code} {ct.split(';')[0]}  {body}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base_url")
    ap.add_argument("--js", type=int, default=8, help="max frontend JS files to scan")
    ap.add_argument("--delay", type=float, default=0.3)
    a = ap.parse_args()

    base = a.base_url if "://" in a.base_url else "https://" + a.base_url
    origin = "{0.scheme}://{0.netloc}".format(urlparse(base))
    s = requests.Session()
    s.headers["User-Agent"] = UA

    print(f"# API discovery for {origin}\n")

    print("## Standard discovery paths")
    openapi_found = []
    for path in COMMON:
        r = get(s, origin + path)
        if isinstance(r, Exception):
            continue
        if r.status_code < 400 or r.status_code in (401, 403):
            print(f"  {path:42} -> {short(r)}")
            ct = r.headers.get("content-type", "")
            if "json" in ct and ("openapi" in r.text[:200] or "swagger" in r.text[:200]):
                openapi_found.append(origin + path)
        time.sleep(a.delay)

    if openapi_found:
        print("\n## OpenAPI/Swagger found")
        for u in openapi_found:
            try:
                spec = s.get(u, timeout=15).json()
                paths = list((spec.get("paths") or {}).keys())
                print(f"  {u}: {len(paths)} endpoints")
                for p in paths[:40]:
                    print(f"    {p}")
            except Exception as e:
                print(f"  {u}: could not parse ({e})")

    # GraphQL introspection (light): just confirm schema availability.
    print("\n## GraphQL")
    for gp in ("/graphql", "/api/graphql"):
        try:
            r = s.post(origin + gp, json={"query": "{__schema{queryType{name}}}"}, timeout=15)
            if r.ok and "__schema" in r.text:
                print(f"  {gp}: introspection OK -> {r.text[:200]}")
        except Exception:
            pass

    # Scrape the homepage's own JS for endpoint URLs.
    print("\n## Endpoints referenced in the site's frontend JS")
    found, scripts = set(), []
    home = get(s, base)
    if not isinstance(home, Exception) and home.ok:
        for tag in BeautifulSoup(home.text, "lxml").find_all("script", src=True):
            u = urljoin(base, tag["src"])
            if urlparse(u).netloc == urlparse(base).netloc:
                scripts.append(u)
        # also scan inline page text
        blobs = [home.text]
        for u in scripts[: a.js]:
            rr = get(s, u)
            if not isinstance(rr, Exception) and rr.ok:
                blobs.append(rr.text)
            time.sleep(a.delay)
        secrets = set()
        for b in blobs:
            for rx in ENDPOINT_RES:
                found.update(m if isinstance(m, str) else m[0] for m in rx.findall(b))
            secrets.update(SECRET_HINT.findall(b))
        for e in sorted(found)[:60]:
            print(f"  {e}")
        if secrets:
            print(f"\n  (JS mentions auth-ish keys: {sorted(set(x.lower() for x in secrets))} "
                  f"— only use credentials that are clearly meant to be public.)")
    else:
        print("  (could not load homepage)")

    print("\nNext: pick an endpoint above and test it directly with curl/python; "
          "replicate the Content-Type/headers the frontend uses; inspect the JSON.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
