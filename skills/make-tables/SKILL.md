---
name: make-tables
description: Present data as clean tables in the reply, and optionally export it as a CSV or Excel file. Use when the user asks for a table, comparison grid, data sheet, or spreadsheet.
---

# Make tables (and export them)

## In-chat tables
Use Markdown GFM tables — they render with borders in the app:
```
| 欄位 | 說明 | 值 |
|------|------|----|
| … | … | … |
```
- Keep headers short; right-align numeric columns conceptually (put units in the
  header, e.g. "價格 (USD)").
- For wide data, prefer fewer, meaningful columns over dumping everything.
- For a comparison, put the options as columns and criteria as rows (or vice
  versa) — whichever the user will scan.

## Export to a file (requires the sandbox / run_code)
Save into the working directory so it shows up with a 檢視/下載 button.

CSV (no dependencies):
```python
import csv
rows = [["name","price"],["A","10"],["B","20"]]
with open("data.csv","w",newline="",encoding="utf-8-sig") as f:
    csv.writer(f).writerows(rows)
print("wrote data.csv")
```

Excel (.xlsx) with openpyxl (already installed):
```python
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "Sheet1"
ws.append(["name","price"]); ws.append(["A",10]); ws.append(["B",20])
# simple formatting
from openpyxl.styles import Font
for c in ws[1]: c.font = Font(bold=True)
wb.save("data.xlsx"); print("wrote data.xlsx")
```
`pandas` is also available (`df.to_csv` / `df.to_excel`) if you already have a
DataFrame.

## Rules
- Reply in the user's language.
- Use `utf-8-sig` for CSV so Chinese opens correctly in Excel.
- After writing a file, tell the user it's ready (they can 檢視/下載 it). Don't
  paste the entire file contents back if it's large.
