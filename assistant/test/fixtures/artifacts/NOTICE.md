# Disposable artifact samples

One sample per supported artifact type, authored by hand for the assistant tests under this
repository's MIT license. They stand in for files produced by existing skills; no skill or
generator was run to make them, so skill generation itself is not evidenced here.

| Type | File | Format |
|---|---|---|
| document | `relatorio-semanal.md` | Markdown, previewed as plain text |
| slides | `apresentacao.html` | HTML deck (CSS scroll-snap, no script) |
| page | `pagina-inicial.html` | HTML |
| dashboard | `painel-metricas.html` | HTML with inline SVG chart |
| design | `cartao-visual.svg` | SVG |
| design_system | `tokens.json` | JSON design tokens |

`pagina-hostil.html` is a negative control: script, refresh, base, CSS, image, form, link and
frame requests that must all stay blocked inside the preview.

- Fonts: only system font stacks (Georgia, Times New Roman, Segoe UI, system-ui, sans-serif). No
  font file is bundled, embedded or downloaded; rendering varies with the installed fonts.
- Assets: inline CSS and inline SVG only. No raster image, external URL or third-party asset. The
  SVG `xmlns` value is a namespace identifier, not a request.
- Blocked formats: PDF, DOCX and PPTX have no local renderer here (no LibreOffice or converter),
  so they are refused at registration rather than shown as previews.
