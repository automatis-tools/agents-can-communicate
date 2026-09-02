const CERTIFICATION =
  /^node_modules\/@agents-can-communicate\/adapter-[^/]+\/certification\.json$/;
const ADAPTER_FIXTURE =
  /^node_modules\/@agents-can-communicate\/adapter-[^/]+\/fixtures\//;

export async function verifyCertificationFixtureAllowlist(listed, readJson) {
  const certifications = listed.filter(entry => CERTIFICATION.test(entry));
  const allowed = new Set();

  for (const certification of certifications) {
    const manifest = await readJson(certification);
    const packageRoot = certification.slice(0, -"/certification.json".length);
    for (const [index, evidence] of (manifest.evidence ?? []).entries()) {
      for (const key of ["fixture", "provenance"]) {
        if (typeof evidence[key] !== "string" || !evidence[key].startsWith("fixtures/")) {
          throw new Error(`${certification} evidence ${index} has invalid ${key}`);
        }
        const referenced = `${packageRoot}/${evidence[key]}`;
        if (!listed.includes(referenced)) {
          throw new Error(`certification fixture is missing: ${referenced}`);
        }
        allowed.add(referenced);
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
