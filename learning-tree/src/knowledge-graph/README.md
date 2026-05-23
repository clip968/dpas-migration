# Knowledge Graph Data

Add reviewed knowledge cards in `cards.ts`.

- Add or update source evidence in `evidenceSources`.
- Add the card body/content near `richConceptContent` or `visualContent` when needed.
- Add the final `GraphCard` entry in `graphCards`.

Add relationships in `edges.ts`.

- Use an existing `EdgeKind` from `types.ts`.
- Keep labels short; the app renders them directly.

Use `paths.ts` for curated learning sequences and `updates.ts` for pending review candidates.
