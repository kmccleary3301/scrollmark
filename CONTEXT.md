# Scrollmark Archive Durability Context

This context defines the language for making Scrollmark's browser archive recoverable without treating browser-profile storage as the only copy.

## Archive and cache

**Canonical archive**:
The acknowledged, normalized record of an X archive held outside the browser profile. It is the authority for recovery and is partitioned into account namespaces.
_Avoid_: Browser database, cache, backup copy

**Browser cache**:
The disposable IndexedDB projection used for capture continuity, rendering, and local search. It may be rebuilt from the canonical archive and is never sufficient evidence of durability by itself.
_Avoid_: Primary archive, durable store

**Account namespace**:
The isolated portion of the canonical archive belonging to one authenticated X account identity. Records, sequences, checkpoints, snapshots, and tombstones cannot cross namespaces without an explicit migration decision.
_Avoid_: Database suffix, global account

**Namespace-owned entity**:
A canonical Tweet or User observation belongs to exactly one account namespace, even when the same public X object is observed in another namespace. Cross-namespace deduplication is derived and cannot change either namespace's authority.
_Avoid_: Global entity, shared record

**Durable commit**:
A normalized archive mutation that the companion has committed under an account namespace and acknowledged with a receipt. Browser-only or outbox-pending data is not durable.
_Avoid_: Local write, cached write

## Canonical content and delivery

**Semantic relationship**:
An authoritative, typed relationship such as capture membership, bookmark-folder membership, a social edge, or a Tweet reference. It is distinct from an embedded payload link or a derived search/index row.
_Avoid_: Generic graph edge, UI link

**Canonical payload**:
A versioned record envelope containing stable identity and integrity metadata plus validated normalized Tweet/User JSON. It preserves additive fields without making raw network events canonical.
_Avoid_: Raw event, browser row

**Canonical journal**:
The append-only sequence of admitted normalized mutations and semantic tombstones behind the current-state canonical records. It is not the raw recorder event stream or a receipt-only audit log.
_Avoid_: Raw journal, cache history

**Archive delta**:
An idempotent, versioned description of normalized archive mutations, including identity, ordering context, content hashes, relationships, and semantic tombstones where applicable.
_Avoid_: Table mirror, raw event

**Client sequence**:
The contiguous ordering assigned by one paired browser client epoch to mutations admitted for one namespace. It detects missing or reordered browser delivery but is not the archive's durable commit order.
_Avoid_: Timestamp order, database row ID

**Archive sequence**:
The contiguous, companion-assigned commit order for one account namespace. It is the only cursor used to reconcile the canonical journal and is advanced atomically with the durable commit.
_Avoid_: Client sequence, wall-clock watermark

**Commit receipt**:
The companion's replayable proof of an atomic archive-delta commit, including client and archive ranges, content/batch hashes, chain head, and resulting checkpoint. A receipt is not a best-effort HTTP success string.
_Avoid_: Accepted IDs, delivery callback

**Reconciliation stream**:
A finite, namespace-scoped, hash-verifiable sequence of journal deltas or canonical-state bootstrap pages pinned to one target checkpoint. It is not a live subscription and cannot silently move its target while being read.
_Avoid_: Unbounded sync, table dump

**Pending outbox**:
A bounded set of normalized mutations accepted locally but not yet acknowledged by the companion. Its records are explicitly pending and must stop admitting new writes at the configured safety bound.
_Avoid_: Durable queue, successful commit

**Durability status**:
The risk-precedence summary of companion health, pending outbox/quarantine, checkpoint validity, and cache recovery. `Durable` means verified receipt and matching projection; `Pending`, `Degraded`, `Stopping`, `Stopped`, and `Recovery required` explicitly describe weaker states.
_Avoid_: Sync indicator, saved badge

**Checkpoint**:
A companion-issued point in an account namespace's acknowledged sequence that identifies the canonical state from which replay or cache reconciliation can continue. It includes a chain hash; the sequence alone is insufficient proof.
_Avoid_: Browser counter, timestamp watermark

**Rehydration generation**:
An isolated, hash-verified staging projection built from a pinned companion reconciliation stream before it replaces the active browser cache. Partial generations are never presented as the active archive.
_Avoid_: Partial cache, lazy first page

**Quarantine**:
An isolated holding state for writes or records whose account identity, schema, hash, or relationship integrity is not safe to admit to the canonical archive. Quarantined data is not presented as durable or merged by guesswork.
_Avoid_: Temporary namespace, best-effort merge

**Recovery state**:
The explicit application state entered when the browser cache is missing, implausibly small, or divergent from the continuity summary or companion checkpoint. It blocks misleading empty-archive presentation while reconstruction is validated.
_Avoid_: Fresh install, empty archive

**Recovery gate**:
The blocking user surface shown when identity, companion, checkpoint, sentinel, or browser projection evidence is insufficient to present live tables as a healthy archive. It exposes bounded repair actions and keeps partial or empty staging generations out of the normal surface.
_Avoid_: Warning banner, empty-cache success

**Continuity sentinel**:
A versioned, checksummed advisory record held by userscript-manager storage with archive/namespace fingerprints, approximate counts, last acknowledged sequence/checkpoint, and recovery metadata. It detects site-data/profile discontinuity but never becomes canonical authority.
_Avoid_: Archive copy, authentication token

**Durable destroy**:
A separately guarded irreversible operation that deletes the companion canonical archive after authenticated archive binding, explicit pending-data disclosure, recovery-artifact review, typed archive-identity confirmation, and a second confirmation. Cache clear, logout, and Bundle Library deletion never imply it.
_Avoid_: Clear browser cache, logout

**Tombstone**:
An acknowledged semantic deletion of an authoritative normalized record or relationship, carrying enough identity and ordering data to prevent the deleted item from reappearing during reconciliation.
_Avoid_: Cache delete, index cleanup

**Snapshot**:
An immutable, separately stored SQLite image of canonical companion state plus a versioned manifest whose image, logical-table, namespace, sequence, and checkpoint evidence has been verified. It can be selected for explicit restore after companion loss or corruption; it is not an IndexedDB export or share bundle.
_Avoid_: IndexedDB export, unverified copy, canonical bundle

**Snapshot cut point**:
The companion-issued checkpoint and per-namespace sequence boundary at which a snapshot is taken after briefly quiescing canonical commits. Pending browser outbox mutations after that boundary are not part of the snapshot.
_Avoid_: Snapshot timestamp, browser count

**Snapshot verification state**:
The immutable lifecycle evidence for a snapshot: `writing`, `verifying`, `verified`, `corrupt`, `incompatible`, `restore_failed`, or `restored`. Only `verified` artifacts are restore candidates.
_Avoid_: Completion marker alone, best-effort valid

**Migration generation**:
A versioned companion or browser storage generation produced by an isolated migration and admitted only after semantic validation. A generation is identified by archive UUID, schema/protocol versions, checkpoint, and verification evidence; a filename alone is not authority.
_Avoid_: In-place upgrade, active file by timestamp

**Migration journal**:
The durable state machine and audit record for copy, transform, validation, pointer switch, browser rebuild, commit, and rollback. It preserves the prior verified generation when a migration is interrupted or rejected.
_Avoid_: Console log, migration success flag

**Bootstrap migration**:
The explicit, identity-validated conversion of an existing browser-only projection into an initial companion archive. It never silently promotes IndexedDB or imported/derived rows and retains the source until canonical validation and a verified snapshot pass.
_Avoid_: Browser promotion, automatic import

## Existing product boundaries

**Raw lane**:
The optional encrypted recorder event/blob retention path used for forensic detail. It is separate from the normalized canonical restore path and remains subject to the existing fail-closed direct-message policy.
_Avoid_: Source of truth for cache rebuild

**Canonical bundle**:
The existing `twe.bundle.v1` portable share/library format. It remains isolated from live captures and is not silently promoted to companion archive state.
_Avoid_: Companion journal, full archive snapshot

**Bundle source projection**:
A read-only, one-namespace representation of a pinned canonical companion checkpoint in `twe.bundle.v1` envelopes. It carries non-secret source metadata, privacy choices, relationship/article/media warnings, and no canonical journal or restore authority.
_Avoid_: Canonical snapshot, browser cache export

**Bundle Library import**:
An isolated compatibility import of `twe.bundle.v1` or legacy JSON/JSONL into bundle-scoped snapshots, collections, items, reports, and derived search documents. It may be partial with explicit warnings, but it never admits a canonical namespace or mutates live captures.
_Avoid_: Archive restore, namespace adoption

**Companion bridge**:
The versioned adapter boundary between authenticated canonical companion state and portable bundle projections. It requires a pinned verified checkpoint for canonical export and treats imported companion metadata as an untrusted claim until explicitly compared.
_Avoid_: Bundle as authority, implicit sync

**Acceptance evidence card**:
A versioned, redacted record binding one durability scenario to an exact source/build/config/fixture, expected and observed state, independent oracle hashes, artifacts, metrics, retry history, privacy check, and pass/fail/block disposition. It is release evidence, not a production diagnostic payload.
_Avoid_: Console pass line, screenshot-only proof

**Fault-injection boundary**:
A named test-only interruption point at a durable write, receipt/checkpoint, snapshot, migration, browser-generation, sentinel, or destructive-operation transition. Each boundary must leave a valid pre-state, post-state, quarantine/pending state, or retained rollback artifact after restart.
_Avoid_: Random kill only, unclassified crash


**Release manifest**:
A versioned, hashed binding of the userscript artifact, companion package/runtime, neutral contract and schema revisions, migration matrix, snapshot-manifest revision, and supported client range. It identifies exactly which artifacts may interoperate and which evidence cards are valid.
_Avoid_: Package version alone, mutable latest tag

**Tranche packet**:
A source-edit authorization unit with one owner, bounded paths/symbols, locked contracts, invariants, failpoints, rollback behavior, proof commands, evidence-card fields, and exit criteria. It is smaller than an architecture rewrite and stronger than a file checklist.
_Avoid_: Unbounded implementation issue, implicit architecture change
