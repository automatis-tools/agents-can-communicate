import { AccError, EXIT, assertPortableId, validateRecord }
  from "@agents-can-communicate/protocol";

export function transactionKinds(kinds, exactKinds = []) {
  const wanted = kinds === undefined ? null : new Set(kinds);
  if (!Array.isArray(exactKinds) || exactKinds.some(kind => wanted === null || !wanted.has(kind))) {
    throw new AccError(EXIT.DATA, "exactKinds must be a subset of explicit transaction kinds",
      { kinds, exactKinds });
  }
  return { wanted, exact: new Set(exactKinds),
    eager: wanted === null ? null : new Set([...wanted].filter(kind => !exactKinds.includes(kind))) };
}

export function createTransactionView({ kinds, exactKinds = [], loaded, loadEnvelope,
  ids, appendEvent, lookupIndex }) {
  const { wanted, exact } = transactionKinds(kinds, exactKinds);
  const staged = new Map(), pending = new Map(), operations = new Set();
  let accepting = true;
  const declared = kind => {
    if (wanted !== null && !wanted.has(kind)) {
      throw new AccError(EXIT.DATA, `this transaction did not declare ${kind}, so it was never read`,
        { kind, declared: [...wanted] });
    }
  };
  const loadedId = (kind, id) => {
    declared(kind);
    if (exact.has(kind) && !loaded.has(`${kind}:${id}`)) {
      throw new AccError(EXIT.DATA, "an exact transaction record must be loaded before access", { kind, id });
    }
  };
  const active = () => {
    if (!accepting) throw new AccError(EXIT.DATA, "transaction async reads are closed");
  };
  const entryFor = key => {
    const entry = staged.get(key) ?? loaded.get(key) ?? null;
    return entry?.removed === true ? null : entry;
  };
  const track = operation => {
    operations.add(operation);
    operation.catch(() => {}); // finish() propagates a rejected unawaited read under the lock.
    return operation;
  };
  const read = async (kind, id) => {
    declared(kind);
    assertPortableId(kind, "record kind");
    assertPortableId(id, "record id");
    const key = `${kind}:${id}`;
    if (staged.has(key) || loaded.has(key)) return entryFor(key);
    if (!exact.has(kind)) return null;
    if (!pending.has(key)) pending.set(key, track(Promise.resolve().then(() => loadEnvelope(kind, id))));
    return pending.get(key);
  };
  const tx = Object.freeze({
    async load(kind, id) {
      active();
      const key = `${kind}:${id}`;
      if (!loaded.has(key)) {
        const envelope = await read(kind, id);
        loaded.set(key, envelope);
      }
      else declared(kind);
      return entryFor(key)?.record ?? null;
    },
    async lookup(index, tuple) {
      active();
      if (typeof lookupIndex !== "function") {
        throw new AccError(EXIT.USAGE, "the transaction store does not support indexed lookup");
      }
      return track(Promise.resolve().then(() => lookupIndex(index, tuple, { declared, loaded, staged, read })));
    },
    get(kind, id) {
      loadedId(kind, id);
      return entryFor(`${kind}:${id}`)?.record ?? null;
    },
    generationOf(kind, id) {
      loadedId(kind, id);
      return entryFor(`${kind}:${id}`)?.generation ?? null;
    },
    list(kind, predicate = () => true) {
      declared(kind);
      if (exact.has(kind)) throw new AccError(EXIT.DATA, "an exact transaction kind cannot be listed", { kind });
      const merged = new Map();
      for (const source of [loaded, staged]) {
        for (const [key, entry] of source) if (entry?.kind === kind) merged.set(key, entry);
      }
      return [...merged.values()].filter(entry => entry.removed !== true)
        .map(entry => entry.record).filter(predicate);
    },
    put(kind, id, record, expectedGeneration = null) {
      loadedId(kind, id);
      const key = `${kind}:${id}`, actual = entryFor(key)?.generation ?? null;
      if (actual !== expectedGeneration) {
        throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
          { kind, id, expectedGeneration, actualGeneration: actual });
      }
      validateRecord(kind, record);
      const generation = ids.next("generation");
      staged.set(key, { kind, id, record, generation });
      return generation;
    },
    remove(kind, id, expectedGeneration = null) {
      loadedId(kind, id);
      const key = `${kind}:${id}`, actual = entryFor(key)?.generation ?? null;
      if (actual !== expectedGeneration) {
        throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
          { kind, id, expectedGeneration, actualGeneration: actual });
      }
      const persisted = loaded.get(key);
      if (persisted == null) staged.delete(key);
      else staged.set(key, { kind, id, generation: persisted.generation, removed: true });
    },
    append: appendEvent,
  });
  async function finish() {
    accepting = false;
    const drained = new Set();
    let failed = false, reason;
    // A rejection cannot release the writer while sibling reads still run.
    // In-flight lookups may register further primary reads while we drain.
    for (;;) {
      const batch = [...operations].filter(operation => !drained.has(operation));
      if (batch.length === 0) break;
      for (const operation of batch) drained.add(operation);
      for (const result of await Promise.allSettled(batch)) {
        if (result.status === "rejected" && !failed) { failed = true; reason = result.reason; }
      }
    }
    if (failed) throw reason;
  }
  return { tx, staged, finish };
}
