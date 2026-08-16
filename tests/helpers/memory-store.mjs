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

  async function transaction(callback) {
    // Staged copies, swapped in only on success. A failed callback must leave
    // neither a record nor an event behind.
    const staged = new Map(committed);
    const stagedEvents = [];
    let sequence = nextSequence;

    const tx = Object.freeze({
      get(kind, id) {
        return staged.get(key(kind, id))?.record ?? null;
      },
      generationOf(kind, id) {
        return staged.get(key(kind, id))?.generation ?? null;
      },
      list(kind, predicate = () => true) {
        return [...staged.values()]
          .filter(entry => entry.kind === kind && predicate(entry.record))
          .map(entry => entry.record);
      },
      put(kind, id, record, expectedGeneration = null) {
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
    const matching = events.filter(event => event.workspaceId === workspaceId
      && event.sequence > after);
    const page = matching.slice(0, limit);
    return { cursor: page.at(-1)?.sequence ?? after, events: page };
  }

  async function snapshot(workspaceId) {
    const of = kind => [...committed.values()]
      .filter(entry => entry.kind === kind && entry.record.workspaceId === workspaceId)
      .map(entry => entry.record);
    return {
      workspace: [...committed.values()]
        .find(entry => entry.kind === "workspace" && entry.record.workspaceId === workspaceId)
        ?.record ?? null,
      participants: of("participant"),
      sessions: of("session"),
      intents: of("intent"),
      workstreams: of("workstream"),
      tasks: of("task"),
      claims: of("claim"),
    };
  }

  // Ephemeral records live outside transactions and outside the event log:
  // they are presence and Intent for a workspace that has not materialised.
  const volatile = new Map();
  const ephemeral = Object.freeze({
    async get(kind, id) { return volatile.get(key(kind, id)) ?? null; },
    async put(kind, id, record) { volatile.set(key(kind, id), record); return record; },
    async delete(kind, id) { volatile.delete(key(kind, id)); },
    async list(kind) {
      return [...volatile.entries()]
        .filter(([entryKey]) => entryKey.startsWith(`${kind}:`))
        .map(([, record]) => record);
    },
  });

  return Object.freeze({ transaction, eventsSince, snapshot, ephemeral, clock, ids,
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
