import { AccError, EXIT, validateRecord } from "@agents-can-communicate/protocol";

const SEQUENCE_WIDTH = 16;
export const ZERO_CURSOR = "0".repeat(SEQUENCE_WIDTH);

const pad = value => String(value).padStart(SEQUENCE_WIDTH, "0");
const key = (kind, id) => `${kind}:${id}`;

// Reference CoordinationStore. It exists so the contract suite has a second
// implementation to run against: a contract only one implementation satisfies
// is indistinguishable from that implementation's behaviour.
export function createMemoryStore({ clock, ids, workspaceId }) {
  let committed = new Map();
  let events = [];
  let nextSequence = 1;

  // `kinds` is enforced here exactly as the filesystem store enforces it. A
  // double that waves the declaration through lets a transaction reach for
  // something it never read, pass every test, and find nothing in production.
  async function transaction(callback, { kinds } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    const declared = kind => {
      if (wanted !== null && !wanted.has(kind)) {
        throw new AccError(EXIT.DATA,
          `this transaction did not declare ${kind}, so it was never read`,
          { kind, declared: [...wanted] });
      }
    };
    // Staged copies, swapped in only on success. A failed callback must leave
    // neither a record nor an event behind.
    const staged = new Map(committed);
    const stagedEvents = [];
    let sequence = nextSequence;

    const tx = Object.freeze({
      get(kind, id) {
        declared(kind);
        return staged.get(key(kind, id))?.record ?? null;
      },
      generationOf(kind, id) {
        declared(kind);
        return staged.get(key(kind, id))?.generation ?? null;
      },
      list(kind, predicate = () => true) {
        declared(kind);
        return [...staged.values()]
          .filter(entry => entry.kind === kind && predicate(entry.record))
          .map(entry => entry.record);
      },
      put(kind, id, record, expectedGeneration = null) {
        declared(kind);
        const actual = staged.get(key(kind, id))?.generation ?? null;
        if (actual !== expectedGeneration) {
          throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
            { kind, id, expectedGeneration, actualGeneration: actual });
        }
        validateRecord(kind, record);
        const generation = ids.next("generation");
        staged.set(key(kind, id), { kind, id, record, generation });
        return generation;
      },
      remove(kind, id, expectedGeneration = null) {
        declared(kind);
        const actual = staged.get(key(kind, id))?.generation ?? null;
        if (actual !== expectedGeneration) {
          throw new AccError(EXIT.CONFLICT, `${kind} ${id} changed under this transaction`,
            { kind, id, expectedGeneration, actualGeneration: actual });
        }
        staged.delete(key(kind, id));
      },
      append(event) {
        const stamped = { ...event, sequence: pad(sequence) };
        sequence += 1;
        validateRecord("event", stamped);
        stagedEvents.push(stamped);
        return stamped;
      },
    });

    const result = await callback(tx);
    committed = staged;
    events = [...events, ...stagedEvents];
    nextSequence = sequence;
    return result;
  }

  async function eventsSince(workspaceId, cursor, limit) {
    const after = cursor ?? ZERO_CURSOR;
    const matching = events.map(event => validateRecord("event", event))
      .filter(event => event.workspaceId === workspaceId && event.sequence > after);
    const page = matching.slice(0, limit);
    // The double reports the boundary too, so a caller that forgets to handle
    // a trimmed log cannot pass its tests and then read short in production.
    return { cursor: page.at(-1)?.sequence ?? after, events: page,
      trimmedThrough: trimmedThrough };
  }

  // One record by id, with the checks a snapshot applies to it: absent,
  // removed, or another workspace's all answer null.
  async function stateRecord(workspaceId, kind, id) {
    const entry = committed.get(key(kind, id));
    if (entry === undefined || entry.record.workspaceId !== workspaceId) return null;
    return validateRecord(kind, entry.record);
  }

  // `kinds` narrows the read, exactly as the filesystem store does. A double
  // that ignores an option the real store honours lets a caller pass its tests
  // and behave differently in the only place that matters.
  async function snapshot(workspaceId, { kinds } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    const of = kind => (wanted !== null && !wanted.has(kind) ? [] : [...committed.values()]
      .filter(entry => entry.kind === kind && entry.record.workspaceId === workspaceId)
      .map(entry => validateRecord(kind, entry.record)));
    const workspace = wanted !== null && !wanted.has("workspace") ? null
      : [...committed.values()].find(entry => entry.kind === "workspace"
        && entry.record.workspaceId === workspaceId)?.record ?? null;
    return {
      workspace: workspace === null ? null : validateRecord("workspace", workspace),
      participants: of("participant"),
      sessions: of("session"),
      intents: of("intent"),
      claims: of("claim"),
      messages: of("message"),
      receipts: of("receipt"),
    };
  }

  let trimmedThrough = null;

  // Trimming drops events at or below a boundary and reports where the log now
  // starts, exactly as the filesystem store does.
  async function trimHistory(boundary) {
    trimmedThrough = trimmedThrough === null || boundary > trimmedThrough
      ? boundary : trimmedThrough;
    const before = events.length;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].sequence <= boundary) events.splice(index, 1);
    }
    return { reclaimed: before - events.length, trimmedThrough, remaining: false };
  }

  // The envelope generation, which `snapshot` deliberately withholds. Reclaiming
  // reads eligibility outside the writer mutex and applies it inside, and this
  // is what proves the record did not change in between.
  async function stateEnvelopes(workspaceId, { kinds } = {}) {
    const wanted = kinds === undefined ? null : new Set(kinds);
    return [...committed.values()].filter(entry => entry.record.workspaceId === workspaceId
      && (wanted === null || wanted.has(entry.kind)));
  }

  // A double that removed a record whose generation had moved would let a
  // caller pass its tests and lose a renewed claim in the only place that
  // matters, so the generation check is real here too.
  async function reclaimRecords(plan) {
    // A function is decided here rather than by the caller, exactly as the
    // filesystem store decides it under the writer mutex.
    const entries = typeof plan === "function" ? await plan() : plan;
    let reclaimed = 0;
    let skipped = 0;
    for (const entry of entries) {
      const found = committed.get(key(entry.kind, entry.id));
      if (found === undefined || found.generation !== entry.generation) {
        skipped += 1;
        continue;
      }
      committed.delete(key(entry.kind, entry.id));
      reclaimed += 1;
    }
    return { reclaimed, skipped, remaining: false };
  }

  // Ephemeral records live outside transactions and outside the event log:
  // they are presence and Intent for a workspace that has not materialised.
  const volatile = new Map();
  let ephemeralTail = Promise.resolve();
  const withEphemeralWriter = async callback => {
    const previous = ephemeralTail;
    let release;
    ephemeralTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };
  const ephemeral = Object.freeze({
    async get(kind, id) { return volatile.get(key(kind, id)) ?? null; },
    async put(kind, id, record) {
      validateRecord(kind, record);
      return withEphemeralWriter(async () => {
        volatile.set(key(kind, id), record);
        return record;
      });
    },
    async update(kind, id, updater) {
      return withEphemeralWriter(async () => {
        const current = volatile.get(key(kind, id)) ?? null;
        const next = await updater(current);
        if (next === null) return null;
        validateRecord(kind, next);
        volatile.set(key(kind, id), next);
        return next;
      });
    },
    async delete(kind, id, guard = () => true) {
      return withEphemeralWriter(async () => {
        const current = volatile.get(key(kind, id)) ?? null;
        if (current === null || !await guard(current)) return;
        volatile.delete(key(kind, id));
      });
    },
    async list(kind) {
      return [...volatile.entries()]
        .filter(([entryKey]) => entryKey.startsWith(`${kind}:`))
        .map(([, record]) => validateRecord(kind, record));
    },
  });

  return Object.freeze({ transaction, eventsSince, snapshot, stateRecord, stateEnvelopes,
    reclaimRecords, trimHistory, ephemeral, clock, ids,
    workspaceId });
}

export function createFakeClock(startIso) {
  let current = Date.parse(startIso);
  return Object.freeze({
    now: () => new Date(current).toISOString(),
    advance: milliseconds => { current += milliseconds; return new Date(current).toISOString(); },
  });
}

export function createFakeIds() {
  const counters = new Map();
  return Object.freeze({
    next(kind) {
      const value = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, value);
      return `${kind}_${String(value).padStart(6, "0")}`;
    },
  });
}
