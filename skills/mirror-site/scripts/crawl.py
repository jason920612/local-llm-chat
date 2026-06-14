#!/usr/bin/env python3
"""Download a website (same domain) into a local folder of searchable text, so
you can grep/analyze it when you don't know the site's structure.

Usage:
    python crawl.py <start_url> [--out site] [--max-pages 200] [--max-depth 3]
                    [--delay 0.3] [--same-host] [--keep-html]

Output:
    <out>/pages/0001.txt ...   one file per page: URL + title + readable text
    <out>/index.tsv            file<TAB>url<TAB>title  (manifest)
    <out>/html/...             raw HTML (only with --keep-html)

Then explore it (see the explore-codebase skill), e.g.:
    grep -rn -i "rate limit" site/pages
"""
import argparse
import os
import re
import sys
import time
from collections import deque
from urllib.parse import urljoin, urlparse, urldefrag
from urllib import robotparser

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (compatible; doc-research-bot/1.0)"
SKIP_EXT = re.compile(
    r"\.(png|jpe?g|gif|webp|svg|ico|css|js|mp4|webm|mp3|wav|zip|gz|tar|"
    r"pdf|docx?|xlsx?|pptx?|woff2?|ttf|eot)(\?|$)",
    re.I,
)


def host_key(netloc: str, same_host: bool) -> str:
    """Group by full host, or by registrable-ish domain (last two labels)."""
    h = netloc.lower().split(":")[0]
    if same_host:
        return h
    parts = h.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else h


def clean_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "lxml")
    title = (soup.title.string or "").strip() if soup.title else ""
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    text = re.sub(r"\n{3,}", "\n\n", soup.get_text("\n", strip=True))
    return title, text


def seed_from_sitemap(session, origin: str) -> list[str]:
    urls = []
    for path in ("/sitemap.xml", "/sitemap_index.xml"):
        try:
            r = session.get(origin + path, timeout=15)
            if r.ok and "xml" in r.headers.get("content-type", ""):
                urls += re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", r.text)
        except Exception:
            pass
    return urls


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("start_url")
    ap.add_argument("--out", default="site")
    ap.add_argument("--max-pages", type=int, default=200)
    ap.add_argument("--max-depth", type=int, default=3)
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--same-host", action="store_true",
                    help="restrict to the exact host (default: same domain)")
    ap.add_argument("--keep-html", action="store_true")
    a = ap.parse_args()

    start = a.start_url if "://" in a.start_url else "https://" + a.start_url
    p = urlparse(start)
    origin = f"{p.scheme}://{p.netloc}"
    allowed = host_key(p.netloc, a.same_host)

    session = requests.Session()
    session.headers["User-Agent"] = UA

    rp = robotparser.RobotFileParser()
    try:
        rp.set_url(origin + "/robots.txt")
        rp.read()
    except Exception:
        rp = None

    os.makedirs(os.path.join(a.out, "pages"), exist_ok=True)
    if a.keep_html:
        os.makedirs(os.path.join(a.out, "html"), exist_ok=True)

    seen, q = set(), deque()
    for u in [start, *seed_from_sitemap(session, origin)]:
        u = urldefrag(u)[0]
        if u not in seen:
            seen.add(u)
            q.append((u, 0))

    index = open(os.path.join(a.out, "index.tsv"), "w", encoding="utf-8")
    saved = 0
    while q and saved < a.max_pages:
        url, depth = q.popleft()
        if rp and not rp.can_fetch(UA, url):
            continue
        try:
            r = session.get(url, timeout=20)
        except Exception as e:
            print(f"skip {url}: {e}", file=sys.stderr)
            continue
        if not r.ok or "text/html" not in r.headers.get("content-type", ""):
            continue

        title, text = clean_text(r.text)
        saved += 1
        fn = f"pages/{saved:04d}.txt"
        with open(os.path.join(a.out, fn), "w", encoding="utf-8") as f:
            f.write(f"URL: {url}\nTITLE: {title}\n\n{text}\n")
        if a.keep_html:
            with open(os.path.join(a.out, "html", f"{saved:04d}.html"),
                      "w", encoding="utf-8") as f:
                f.write(r.text)
        index.write(f"{fn}\t{url}\t{title}\n")
        index.flush()
        print(f"[{saved}/{a.max_pages}] d{depth} {url}")

        if depth < a.max_depth:
            for tag in BeautifulSoup(r.text, "lxml").find_all("a", href=True):
                nxt = urldefrag(urljoin(url, tag["href"]))[0]
                pp = urlparse(nxt)
                if pp.scheme not in ("http", "https"):
                    continue
                if host_key(pp.netloc, a.same_host) != allowed:
                    continue
                if SKIP_EXT.search(nxt) or nxt in seen:
                    continue
                seen.add(nxt)
                q.append((nxt, depth + 1))
        time.sleep(a.delay)

    index.close()
    print(f"\nDone: {saved} pages -> {a.out}/pages/ (manifest: {a.out}/index.tsv)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
