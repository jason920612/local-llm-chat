---
name: generate-document
description: Generate a downloadable document file in the sandbox — PDF, Word (.docx), Excel (.xlsx), or a styled standalone HTML — using run_code. Use when the user wants an actual file to download, not just text in the chat.
---

# Generate a document file

Write the file into the working directory with run_code (server-side Python 3).
It then appears in the chat with a 檢視 (preview) / 下載 (download) button — PDF,
DOCX and HTML render in-app; XLSX downloads. Pick the format the user asked for.

## PDF — reportlab (already installed)

⚠️ For Chinese, you MUST EMBED a real TrueType font. Do NOT use reportlab's
built-in CID fonts (`STSong-Light`/`MSung-Light`) — they are Simplified (Adobe-GB1),
not embedded, and render BLANK or as GARBLED glyphs (wrong characters) in browser
viewers, especially for Traditional Chinese. Embedding a .ttf/.ttc fixes glyphs
AND makes the PDF portable everywhere.

```python
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Find and embed an installed CJK font (covers Traditional + Simplified).
CANDIDATES = [
    ("C:/Windows/Fonts/msjh.ttc", 0),     # Microsoft JhengHei — Traditional (preferred)
    ("C:/Windows/Fonts/mingliu.ttc", 0),  # MingLiU — Traditional
    ("C:/Windows/Fonts/msyh.ttc", 0),     # Microsoft YaHei — Simplified
    ("C:/Windows/Fonts/simsun.ttc", 0),   # SimSun — Simplified
    ("/System/Library/Fonts/PingFang.ttc", 0),            # macOS
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),  # Linux
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
]
CJK = None
for path, idx in CANDIDATES:
    if os.path.exists(path):
        try:
            pdfmetrics.registerFont(TTFont("CJK", path, subfontIndex=idx))
            CJK = "CJK"; break
        except Exception:
            pass
assert CJK, "no CJK TTF found — use the HTML path instead"

title = ParagraphStyle("T", fontName=CJK, fontSize=20, leading=26, spaceAfter=16, alignment=1)
h2    = ParagraphStyle("H2", fontName=CJK, fontSize=14, leading=20, spaceBefore=12, spaceAfter=6)
body  = ParagraphStyle("B", fontName=CJK, fontSize=11, leading=17, spaceAfter=8)

doc = SimpleDocTemplate("report.pdf", pagesize=A4)
flow = [
    Paragraph("報告標題", title),
    Paragraph("摘要章節", h2),
    Paragraph("這是一段中文內文，使用內嵌字型才會正確顯示。", body),
    Spacer(1, 8),
]
data = [["項目", "值"], ["A", "10"], ["B", "20"]]   # plain strings are fine
t = Table(data, colWidths=[200, 200])
t.setStyle(TableStyle([
    ("FONTNAME", (0,0), (-1,-1), CJK),     # REQUIRED: CJK font on the table too
    ("GRID", (0,0), (-1,-1), 0.5, colors.grey),
    ("BACKGROUND", (0,0), (-1,0), colors.lightgrey),
]))
flow.append(t)
doc.build(flow); print("wrote report.pdf")
```
If no CJK TTF is found (the assert fails), use the **HTML** path below — it's the
most reliable for Chinese; the user can print it to PDF.

## Word (.docx) — python-docx (install on first use)
```python
import subprocess, sys
subprocess.run([sys.executable,"-m","pip","install","-q","python-docx"], check=False)
from docx import Document
d = Document()
d.add_heading("標題", 0)
d.add_paragraph("內文…")
t = d.add_table(rows=1, cols=2); t.style = "Light Grid Accent 1"
t.rows[0].cells[0].text = "項目"; t.rows[0].cells[1].text = "值"
for name,val in [("A","10"),("B","20")]:
    r = t.add_row().cells; r[0].text = name; r[1].text = val
d.save("report.docx"); print("wrote report.docx")
```

## Excel (.xlsx) — openpyxl (already installed)
See the **make-tables** skill.

## Styled standalone HTML (no dependencies; best for Chinese, print-to-PDF)
Write a self-contained .html with inline CSS. It previews in-app; the user can
print it to PDF from the browser.
```python
html = """<!doctype html><meta charset="utf-8"><style>
body{font-family:system-ui,"Noto Sans TC",sans-serif;max-width:780px;margin:auto;padding:32px;line-height:1.6}
h1{border-bottom:2px solid #444} table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:6px 10px} th{background:#f0f0f0}
</style><h1>標題</h1><p>內文…</p>
<table><tr><th>項目</th><th>值</th></tr><tr><td>A</td><td>10</td></tr></table>"""
open("report.html","w",encoding="utf-8").write(html); print("wrote report.html")
```

## Rules
- Reply in the user's language. Pick ONE format matching the request (PDF / Word /
  Excel / HTML); offer an alternative only if the first fails.
- For a Chinese PDF you MUST embed a real TrueType font (TTFont) and set it on
  every style AND the table; never use the built-in CID fonts for Chinese (they
  render blank or garbled). For Chinese-heavy docs, HTML and DOCX are also reliable.
- Save into the working directory (relative path, no folders) so the file surfaces
  in the chat. After it's written, briefly confirm — don't paste the file back.
- Combine with **write-report** for the content structure and **make-tables** for
  tabular data.
