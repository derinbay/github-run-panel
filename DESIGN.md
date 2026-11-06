# GitHub Run Panel: design

World: a dark departure board above two ruled ledgers on warm grid paper.

- Type: Archivo variable (condensed 70–85% widths for headings and figures), JetBrains Mono for data only; both self-hosted under `fonts/`. Tabular numerals everywhere.
- Colour: ink on paper; colour only marks state. Vermilion `--seal` is reserved for what needs attention; `--pass` green, `--run` blue, `--lamp` yellow only on the board.
- Board: running rows with a yellow lamp, queued rows after a "Queued" separator; self-hosted runners as cream plates with a hashed hue square, GitHub-hosted as outline plates; mono elapsed time.
- Ledgers: PR and issue lists, each row title + mono meta line (repo#number, author, branch/labels), state cells, seal, relative age. A 3px double rule under each head.
- Signature: the rotated double-bordered vermilion seal (CI BROKEN, CHANGES, APPROVED on pull requests; the configured `sealLabels` on issues). Its stamp animation is the only motion and respects `prefers-reduced-motion`.
- Language: Turkish when the browser prefers it, English otherwise; every visible string lives in `STRINGS` in `index.html`.
- Themes: light and dark tokens on `:root`, auto by `prefers-color-scheme`, overridable and stored in `run-panel-theme`.
- Layout: fills 100vh at 1920x1080 with internal scrolling; below 1280px wide or 760px tall the page flows and the ledgers stack.
