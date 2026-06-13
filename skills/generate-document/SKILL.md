---
name: generate-document
description: Generate a downloadable document file in the sandbox — PDF, Word (.docx), Excel (.xlsx), or a styled standalone HTML — using run_code. Use when the user wants an actual file to download, not just text in the chat.
---

# Generate a document file

Write the file into the working directory with run_code (server-side Python 3).
It then appears in the chat with a 檢視 (preview) / 下載 (download) button — PDF,
DOCX and HTML render in-app; XLSX downloads. Pick the format the user asked for.

## PDF — reportlab (already installed)
```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
styles = getSampleStyleSheet()
doc = SimpleDocTemplate("report.pdf", pagesize=A4)
flow = [Paragraph("標題", styles["Title"]), Spacer(1,12),
        Paragraph("內文段落…", styles["BodyText"]), Spacer(1,12)]
t = Table([["項目","值"],["A","10"],["B","20"]])
t.setStyle(TableStyle([("GRID",(0,0),(-1,-1),0.5,colors.grey),
                       ("BACKGROUND",(0,0),(-1,0),colors.lightgrey)]))
flow.append(t)
doc.build(flow); print("wrote report.pdf")
```
Note: reportlab's default fonts don't render CJK. For Chinese text, register a CJK
font first, e.g.:
```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
# then use fontName="STSong-Light" in your styles/TableStyle
```
If CJK still fails, fall back to the **HTML** path below (best for Chinese).

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
- For Chinese-heavy documents prefer HTML or DOCX; for reportlab PDF you MUST
  register a CJK font or the text will be blank/boxes.
- Save into the working directory (relative path, no folders) so the file surfaces
  in the chat. After it's written, briefly confirm — don't paste the file back.
- Combine with **write-report** for the content structure and **make-tables** for
  tabular data.
