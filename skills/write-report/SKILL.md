---
name: write-report
description: Compose a polished, well-structured report directly in the chat reply — with headings, summary, tables, diagrams, and data charts. Use when the user asks for a report, analysis, write-up, briefing, comparison, or summary document.
---

# Write a polished report

Produce a clear, skimmable report IN THE REPLY using the app's live rendering.
Don't dump a wall of text — structure it and show data visually.

## Structure (adapt to the request)

1. **Title** (H1) + a one-paragraph **executive summary** / TL;DR up top.
2. **Sections** with H2/H3 headings. Lead each with the conclusion, then detail.
3. **Tables** for any structured comparison — use Markdown GFM tables:
   ```
   | 項目 | A | B |
   |------|---|---|
   | 價格 | … | … |
   ```
4. **Diagrams** for flows/architecture/relationships — use a ```mermaid block
   (flowchart, sequence, pie, gantt, mindmap).
5. **Data charts** for numbers/trends — use a ```chart block with a Vega-Lite v5
   JSON spec (inline "data".values). Prefer a chart over describing numbers.
6. **Key takeaways** / recommendations as a short bullet list at the end.
7. If facts come from search, cite them with [n].

## Rules

- Reply in the user's language.
- Use real rendered tables/charts/diagrams (the app renders them live) — not ASCII
  art and not screenshots.
- Be concise and concrete; no filler. Bold the few things that matter.
- If the user wants a downloadable file (PDF / Word / Excel / standalone HTML),
  switch to the **generate-document** skill.
- If the report is mostly tabular data, also see the **make-tables** skill.
