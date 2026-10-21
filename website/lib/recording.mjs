// Public demo records contain selected message facts, never native owner context.
export function validateRecording(record) {
  const text = JSON.stringify(record);
  if (/(?:generation|session)_[A-Za-z0-9_-]{6,}|\/(?:Users|private|home)\/|Bearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{10,}/.test(text)) {
    throw new Error("recording privacy contract failed");
  }
  const allow = (object, keys) => {
    if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) {
      throw new Error("recording privacy contract failed: unexpected native context");
    }
  };
  allow(record, ["version", "capturedAt", "accVersion", "delivery", "clients", "messages", "events", "source", "note"]);
  const fail = () => { throw new Error("recording data contract failed"); };
  const string = value => typeof value === "string" && Boolean(value.trim());
  const version = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
  const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
  if (record?.version !== 1 || !string(record.note) || !version(record.accVersion) || !date(record.capturedAt)
    || record.delivery !== "Explicit inbox" || record.source?.kind !== "native-client-capture"
    || !Array.isArray(record.clients) || record.clients.length !== 2
    || !Array.isArray(record.messages) || record.messages.length !== 2
    || !Array.isArray(record.events) || record.events.length !== 4) fail();
  for (const client of record.clients) allow(client, ["id", "name", "version"]);
  for (const message of record.messages) allow(message, ["id", "client", "label", "text", "sentAt", "inReplyTo"]);
  for (const event of record.events) allow(event, ["kind", "client", "messageId", "at", "label"]);
  allow(record.source, ["kind", "artifacts"]);
  if (!Array.isArray(record.source.artifacts)) fail();
  for (const artifact of record.source.artifacts) allow(artifact, ["name", "sha256"]);
  const clients = new Set(record.clients.map(client => client.id));
  if (clients.size !== 2 || record.clients.some(client => !string(client.name) || !string(client.id) || !version(client.version))) fail();
  const [question, answer] = record.messages;
  if (record.messages.some(message => typeof message.id !== "string" || !/^message_[A-Za-z0-9_-]+$/.test(message.id) || !clients.has(message.client)
    || !string(message.label) || !string(message.text) || !date(message.sentAt)
    || (message.inReplyTo !== undefined && !string(message.inReplyTo)))
    || question.id === answer.id || question.client === answer.client || answer.inReplyTo !== question.id
    || record.capturedAt !== question.sentAt) fail();
  const ids = [question.id, question.id, answer.id, answer.id];
  const actors = [question.client, answer.client, answer.client, question.client];
  let previous = Date.parse(record.capturedAt);
  for (const [index, event] of record.events.entries()) {
    if (typeof event.label !== "string" || !event.label || !date(event.at) || Date.parse(event.at) < previous || event.messageId !== ids[index]
      || event.client !== actors[index] || event.kind !== (index % 2 ? "retrieved" : "recorded")) fail();
    previous = Date.parse(event.at);
  }
  if (record.events[0].at !== question.sentAt || record.events[2].at !== answer.sentAt
    || !record.source.artifacts?.length || record.source.artifacts.some(artifact =>
      typeof artifact.name !== "string" || !/^[a-z0-9.-]+$/.test(artifact.name)
      || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256))) fail();
}
