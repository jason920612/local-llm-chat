---
name: generate-document
description: Generate a downloadable document file in the sandbox — PDF, Word (.docx), Excel (.xlsx), or a styled standalone HTML — using run_code. Use when the user wants an actual file to download, not just text in the chat.
---

# Generate a document file

Write the file into the working directory with run_code (server-side Python 3).
It then appears in the chat with a 檢視 (preview) / 下載 (download) button — PDF,
DOCX and HTML render in-app; XLSX downloads. Pick the format the user asked for.

## PDF — reportlab (already installed)

⚠️ Chinese PDFs render BLANK (you see the table grid but no text) unless you set
the CJK font correctly:
1. Register a built-in CJK font: `STSong-Light` or `MSung-Light` (NOT
   `STSongStd-Light`/`MHei-Medium` — those aren't available).
2. Set `fontName` to it on EVERY style — title, headings, body — AND add
   `("FONTNAME",(0,0),(-1,-1),CJK)` to the table's TableStyle. Any element left on
   the default Helvetica will show nothing for Chinese.
3. These built-in fonts are referenced (not embedded), so viewers need CJK CMap
   data — this app's preview already loads it. For a PDF that's portable to every
   external viewer, either embed a real .ttf via `TTFont`, or use the HTML path.

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

CJK = "STSong-Light"                       # built-in; or "MSung-Light"
pdfmetrics.registerFont(UnicodeCIDFont(CJK))

# Define styles with the CJK font AND wordWrap="CJK" — both are required.
title = ParagraphStyle("T", fontName=CJK, fontSize=20, leading=26, spaceAfter=16, alignment=1, wordWrap="CJK")
h2    = ParagraphStyle("H2", fontName=CJK, fontSize=14, leading=20, spaceBefore=12, spaceAfter=6, wordWrap="CJK")
body  = ParagraphStyle("B", fontName=CJK, fontSize=11, leading=17, spaceAfter=8, wordWrap="CJK")

doc = SimpleDocTemplate("report.pdf", pagesize=A4)
flow = [
    Paragraph("報告標題", title),
    Paragraph("摘要章節", h2),
    Paragraph("這是一段較長的中文內文，必須要能正確換行才不會整段消失……", body),
    Spacer(1, 8),
]
# Wrap table cells in Paragraphs (with the CJK body style) so long cell text wraps too.
data = [[Paragraph("項目", body), Paragraph("值", body)],
        [Paragraph("A", body), Paragraph("10", body)]]
t = Table(data, colWidths=[200, 200])
t.setStyle(TableStyle([
    ("GRID", (0,0), (-1,-1), 0.5, colors.grey),
    ("BACKGROUND", (0,0), (-1,0), colors.lightgrey),
    ("FONTNAME", (0,0), (-1,-1), CJK),     # also set the font on the table
]))
flow.append(t)
doc.build(flow); print("wrote report.pdf")
```
If CJK still misbehaves, fall back to the **HTML** path below (most reliable for
Chinese; the user can print it to PDF).

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
- For Chinese-heavy documents prefer HTML or DOCX; for reportlab PDF you MUST set a
  registered CJK font (STSong-Light/MSung-Light) on every style AND the table, or
  the text renders blank (you'd see the table grid but no characters).
- Save into the working directory (relative path, no folders) so the file surfaces
  in the chat. After it's written, briefly confirm — don't paste the file back.
- Combine with **write-report** for the content structure and **make-tables** for
  tabular data.
