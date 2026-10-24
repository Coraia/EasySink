# Development resource boundary

The resource fix keeps one declared sealed source/resource root and at most two named work slots (A and B). A run gets its own small evidence directory, never a new full product tree or App. First use requires an empty slot; an occupied slot is rejected, including after a failed run. No automatic reset, deletion, B fallback or label-based slot creation. Explicit retirement requires a matching lease and a closed receipt with every recorded PID absent. Rebuildable source uses its protected base/diff and full manifest; it does not require another source archive. Other necessary evidence must be retained independently. A private test database recorded by this policy may be reset from its hash-verified closed baseline only after all owned processes exit and the owner explicitly confirms its unique evidence has been retained. It is not archived in full. Old/unknown databases and the real library are outside this policy; unique unretained data blocks retirement. Only fake-slot reset/reuse is exercised now; no real old slot is retired.

Development source has small Python/UI code in its slot, a complete source manifest and an explicit shared-resource map. Only `data/stardict.db` may be a symlink, to the exact declared read-only sealed dictionary. Other resources are served by an exact manifest lookup in the sealed root, never arbitrary symlink traversal. Changed shared assets are rejected rather than silently using the base. This exception is for development only. A release App contains an independent dictionary inode and verifies its own actual bundle bytes.

Private writable databases are native clones of a consistent closed snapshot, with independent inodes and WAL paths. Native cloning must succeed directly; no ordinary-copy fallback or hardlinks. Dictionary indexing refuses symlinks and read-only files/directories before SQLite opens a write connection. Large hashes use bounded streaming reads.

Before a real operation, measured free space minus its declared worst-case growth must remain at least 10 GiB. RAM headroom and CPU load are measured and compared with explicit budgets. Unknown facts/budgets reject the run. Passing a small resource check does not resume functional, native, physical-input or performance acceptance.

The portable handoff contains the policy, the lexicon guard and the desktop
builder integration only. Private `.runtime` caller adapters are intentionally
absent; the new Mac must migrate each real caller explicitly before resuming
that path. The finite check verifies that the shipped builder imports the
policy and exposes explicit budgets, but it does not build an App.

Failure modes fixed before implementation and checked with tiny fake resources:

1. Native clone unavailable, failing, same inode, symlink source, existing destination or cross-volume: stop without ordinary copy.
2. Source database has a nonempty WAL, destination aliases a source or private WAL path, or source changes: reject.
3. A second run attempts an occupied slot, an arbitrary slot name, or old evidence reuse: reject without changing evidence or creating another slot.
4. Hashing tries a whole-file read: reject in the check; stream SHA must still match.
5. Low disk, insufficient/unknown RAM, unavailable/over-budget CPU or absent growth budget: reject before allocation.
6. Development manifest drift, undeclared resource change, writable sealed dictionary, unexpected symlink or path escape: reject; exact declared dictionary reference is the only link exception.
7. Indexing is pointed at the sealed dictionary or its development reference: reject before writes.
8. Release resource cloning fails: reject; a successful release dictionary remains an independent file, not a shared development reference.
9. Retirement has a wrong owner/run, live PID, unretained payload, unverifiable dictionary link, existing retirement receipt or evidence inside the slot: reject before removal. A fully closed, retained tiny slot may be retired and claimed again without overwriting its old evidence.

Run only `check_resource_policy.py --output ABS_FRESH_JSON` for the authorized tiny-resource checks. It does not launch a reader, build an App or access a real library/dictionary.
