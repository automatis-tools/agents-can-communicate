import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
const label = process.argv[4];
const { createFakeClock, createFakeIds } = await import(pathToFileURL(path.join(repo, 'tests/helpers/memory-store.mjs')).href);
const { createStoreIoProbe } = await import(pathToFileURL(path.join(repo, 'tests/helpers/store-io-probe.mjs')).href);
if (!['old', 'candidate'].includes(label)) throw new Error('expected old or candidate');
const installed = path.join(evidence, label + '-consumer/node_modules/agents-can-communicate');
const manifest = JSON.parse(await readFile(path.join(installed, 'package.json')));
const moduleUrl = name => pathToFileURL(path.join(installed, 'node_modules/@agents-can-communicate', name, 'src/index.mjs')).href;
const { createCoordinationService } = await import(moduleUrl('core'));
const { openFilesystemStore } = await import(moduleUrl('storage-filesystem'));
const root = await realpath(await mkdtemp(path.join(evidence, label + '-measurement-')));
const workspaceId = 'workspace_read_cost', clock = createFakeClock('2026-09-01T21:00:00.000Z'), ids = createFakeIds();
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
let probe;
try {
  const store = await openFilesystemStore({ root, workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ workspaceId, participantId, harness: 'fixture', heartbeatCadenceMs: 60_000 });
  const sender = await open('sender'), reader = await open('reader');
  const send = key => service.sendMessage({ ...owner(sender), clientMessageId: key, toParticipantIds: ['reader'],
    kind: 'note', obligation: 'none', subject: key, body: 'Same measured fixture' });
  probe = createStoreIoProbe(root);
  const started = performance.now(), sends = {}, totals = {}, messages = [];
  let stateReads = 0, pageReads = 0, pageWrites = 0, indexBytes = 0;
  for (let i = 0; i < 60; i++) {
    const m = await probe.capture(() => send('client_' + i));
    messages.push(m.result); delete m.result;
    stateReads += m.stateReads; pageReads += m.pageReads; pageWrites += m.pageWrites; indexBytes += m.indexWrittenBytes;
    if ([1, 20, 40, 60].includes(i + 1)) {
      sends[i + 1] = m;
      totals[i + 1] = { stateReads, pageReads, pageWrites, indexBytes, elapsedMs: performance.now() - started };
    }
  }
  const offer = message => ({ messageId: message.messageId, recipientParticipantId: 'reader', targetSessionId: reader.sessionId,
    targetGeneration: reader.generation, transport: 'next-turn', adapterId: 'fixture', clientVersion: '1.0.0' });
  const read = await probe.capture(() => service.readReceipt(offer(messages[0])));
  const offered = await probe.capture(() => service.recordOfferSucceeded(offer(messages[0])));
  const ack = await probe.capture(() => service.acknowledgeMessage({ ...owner(reader), messageId: messages[0].messageId }));
  const failed = await probe.capture(() => service.recordOfferFailed({ ...offer(messages[1]), safeErrorCode: 'transport_rejected' }));
  const reopened = await openFilesystemStore({ root, workspaceId, clock, ids });
  const coldService = createCoordinationService({ store: reopened, clock, ids });
  const cold = await probe.capture(() => coldService.readReceipt(offer(messages[0])));
  const retry = await probe.capture(() => coldService.sendMessage({ ...owner(sender), clientMessageId: 'client_0',
    toParticipantIds: ['reader'], kind: 'note', obligation: 'none', subject: 'client_0', body: 'Same measured fixture' }));
  for (const m of [read, offered, ack, failed, cold, retry]) delete m.result;
  const report = { label, node: process.version, platform: process.platform, packageVersion: manifest.version,
    storeContract: manifest.accStoreVersion, capturedAt: new Date().toISOString(), sends, totals, read, offered, ack, failed, cold, retry };
  await writeFile(path.join(evidence, 'measurement-' + label + '.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ label, totals, lastSends: Object.fromEntries(Object.entries(sends)
    .map(([n,m]) => [n, { stateReads:m.stateReads, pageReads:m.pageReads, pageWrites:m.pageWrites,
      indexWrittenBytes:m.indexWrittenBytes, indexFlushes:m.indexFlushes, flushes:m.flushes, elapsedMs:m.elapsedMs }])),
    receiptReads: [read.stateReads, offered.stateReads, ack.stateReads, failed.stateReads, cold.stateReads] }));
} finally { probe?.stop(); await rm(root, { recursive: true, force: true }); }
