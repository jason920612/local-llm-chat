#!/usr/bin/env python3
"""Extract printable strings (ASCII + UTF-16LE) from a binary — a stand-in for the
`strings` tool, which isn't installed in the sandbox.

Usage: python strings.py <file> [min_len=4]
"""
import re
import sys

if len(sys.argv) < 2:
    sys.exit("usage: python strings.py <file> [min_len]")
n = int(sys.argv[2]) if len(sys.argv) > 2 else 4
data = open(sys.argv[1], "rb").read()

seen = set()
for m in re.finditer((r"[\x20-\x7e]{%d,}" % n).encode(), data):
    s = m.group().decode("ascii", "replace")
    if s not in seen:
        seen.add(s)
        print(s)
for m in re.finditer((r"(?:[\x20-\x7e]\x00){%d,}" % n).encode(), data):
    s = m.group().decode("utf-16le", "replace").strip("\x00")
    if s and s not in seen:
        seen.add(s)
        print(s)
