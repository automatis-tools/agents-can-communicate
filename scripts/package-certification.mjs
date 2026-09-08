import { createHash } from "node:crypto";
import path from "node:path";

import { validateCapture } from "./spikes/delivery-capture.mjs";

const CERTIFICATION =
  /^node_modules\/@agents-can-communicate\/adapter-[^/]+\/certification\.json$/;
const ADAPTER_FIXTURE =
  /^node_modules\/@agents-can-communicate\/adapter-[^/]+\/fixtures\//;
const SHA256 = /^[a-f0-9]{64}$/;

function validFixturePath(value) {
  return typeof value === "string" && value.startsWith("fixtures/")
    && value.endsWith(".json") && !value.includes("\\")
    && path.posix.normalize(value) === value
    && /^fixtures\/(?:[^/]+\/)*[^/]+\.json$/.test(value);
}

function fixtureEntry(certification, packageRoot, reference, label, listed, allowed) {
  if (!validFixturePath(reference)) {
    throw new Error(`${certification} has invalid ${label} fixture`);
  }
  const entry = `${packageRoot}/${reference}`;
  if (!listed.includes(entry)) throw new Error(`certification fixture is missing: ${entry}`);
  allowed.add(entry);
  return entry;
}

async function associatedEvidence(certification, packageRoot, reference, label,
  listed, allowed, readBytes) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)
    || Object.keys(reference).length !== 2
    || !Object.hasOwn(reference, "fixture") || !SHA256.test(reference.sha256)) {
    throw new Error(`${certification} has invalid ${label}`);
  }
  const entry = fixtureEntry(certification, packageRoot, reference.fixture,
    label, listed, allowed);
  if (typeof readBytes !== "function") {
    throw new Error(`${certification} ${label} requires raw fixture reads`);
  }
  const bytes = await readBytes(entry);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.sha256) {
    throw new Error(`${certification} ${label} digest differs: ${entry}`);
  }
  return { bytes, entry };
}

function parseEvidenceJson({ bytes, entry }, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON: ${entry}`);
  }
}

export async function verifyCertificationFixtureAllowlist(listed, readJson, readBytes) {
  const certifications = listed.filter(entry => CERTIFICATION.test(entry));
  const allowed = new Set();
  const provenanceByEntry = new Map();

  for (const certification of certifications) {
    const manifest = await readJson(certification);
    const packageRoot = certification.slice(0, -"/certification.json".length);
    for (const [index, evidence] of (manifest.evidence ?? []).entries()) {
      for (const key of ["fixture", "provenance"]) {
        if (!validFixturePath(evidence[key])) {
          throw new Error(`${certification} evidence ${index} has invalid ${key}`);
        }
        const referenced = `${packageRoot}/${evidence[key]}`;
        if (!listed.includes(referenced)) {
          throw new Error(`certification fixture is missing: ${referenced}`);
        }
        allowed.add(referenced);
      }

      const provenanceEntry = `${packageRoot}/${evidence.provenance}`;
      if (!provenanceByEntry.has(provenanceEntry)) {
        provenanceByEntry.set(provenanceEntry, await readJson(provenanceEntry));
      }
      const provenance = provenanceByEntry.get(provenanceEntry);
      const records = provenance.captures?.filter(record => record.id === evidence.provenanceId);
      if (records?.length !== 1) {
        throw new Error(`${certification} evidence ${index} does not select one provenance record`);
      }
      const record = records[0];
      for (const key of ["client", "version", "platform", "observedAt", "fixture"]) {
        if (record[key] !== evidence[key]) {
          throw new Error(`${certification} evidence ${index} ${key} differs from selected provenance`);
        }
      }

      let productEvidence;
      if (record.productEvidence !== undefined) {
        productEvidence = parseEvidenceJson(await associatedEvidence(certification, packageRoot,
          record.productEvidence, "productEvidence", listed, allowed, readBytes), "productEvidence");
      }
      if (record.historicalFixtures !== undefined) {
        if (!Array.isArray(record.historicalFixtures)) {
          throw new Error(`${certification} has invalid historicalFixtures`);
        }
        for (const [referenceIndex, reference] of record.historicalFixtures.entries()) {
          await associatedEvidence(certification, packageRoot, reference,
            `historicalFixtures ${referenceIndex}`, listed, allowed, readBytes);
        }
      }

      const capture = await readJson(`${packageRoot}/${evidence.fixture}`);
      if (capture?.capability === "native_delivery") {
        validateCapture(capture, { productEvidence });
      }
    }
  }

  const unreferenced = listed.filter(entry => ADAPTER_FIXTURE.test(entry)
    && !allowed.has(entry));
  if (unreferenced.length > 0) {
    throw new Error(`unreferenced certification fixture is published: ${unreferenced[0]}`);
  }
  return { certifications, allowed };
}
