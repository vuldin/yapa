# Review notes — training / context / system-prompt pipeline

Items flagged during review of the buckets/, curation/, training/ modules and the recall/list changes.

## Things to check out

1. **Pagination gap in curation and bucket scan** — `curation/index.ts:35`, `buckets/index.ts:57` (and the other `getDocumentsByFilter(..., 500|2000)` call sites). Grabs up to N docs, then filters client-side for `classified_at == null` (or similar). On a collection with more than N memories where most are already classified, new unclassified memories past the Nth boundary are never picked up. Chroma's `where` supports `$exists` / null comparisons — push the filter into the query. Not a correctness bug on current corpora, but it's a silent scaling cliff.

2. **`findDocByManifestId` is O(M × C × 2000)** — `verification.ts:28-40`. Every memory in the verify run triggers a full scan of every collection. Gather-once + index-by-id would make it O(M). Fine today, worth fixing before running verify on larger corpora.

3. **Unused config: `EVAL_MIN_IMPROVEMENT`** — `config.ts:95`. Declared, exported, never referenced. Either wire it into `eval_compare` or the promotion gate ("only promote if eval beats incumbent by X"), or drop it.

4. **`VERIFICATION_ATTEMPTS_MAX` defined but not enforced** — `config.ts:96`, re-exported from `verification.ts:139`. `verifyAdapterAgainstManifest` increments `verification_attempts` on metadata but nothing checks the cap. Either implement the "give up after N failed verifications" rule, or drop the config.

5. **Router "already routed" check is a `startsWith`** — `router.ts:79-82`. `metadata.promoted_to?.toString().startsWith('system-prompt')` works because `system-prompt-v*` and `training-v*` can't collide today, but it's fragile — a future bucket name like `system-prompt-eval` would match incorrectly. Switch to an exact prefix check (e.g., `str.split('-v')[0] === 'system-prompt'`) or track the bucket tag separately in metadata.

6. **`bucket_route_now` is not gated by `confirm`** — unlike activate/trigger/cancel/promote/demote. Justifiable because writes are reversible (`selected_for` is intermediate; deactivate clears everything), but either add a `confirm: true` gate for symmetry, or add a comment explaining why this one is different.

7. **No tests for `eval.ts`, `verification.ts`, or `promotion.ts`** — the three highest-level orchestrators. Their dependencies (judge, synthesis, holdout, registry, fireworks) are well-tested, but an integration test with mocked inference + judge would catch wiring bugs between them cheaply.

## Non-issues noted during review (documenting so we don't re-litigate)

- **Dynamic `await import(...)` inside every tool handler in `tools.ts`** — matches the existing sync-tools pattern. Consistent, intentional.
- **`bucket_route_now` bumps `nextVersion()` even on partial failure** — acceptable; artifacts directory is append-only and audit-trail friendly.
- **Training failure clears `selected_for` on the whole manifest** — intentional per the Phase 3 failure path. Memories re-enter RAG and are re-eligible on the next routing cycle (which will land them in a new version number).
- **Preview SHA-256 sign-off gate in `training_trigger`** — intentional and well-designed; prevents training on silently-modified data.
- **README "41 tools" claim** — counted, it's accurate.
