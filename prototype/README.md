# Preserved prototype

`papercut-agent-comms/` is an exact archive of the committed protocol baseline at Papercut source commit `9a866cf16f97a0aa1af7ea792acc79bc02278633`.

It preserves the directory shape expected by its tests. Run from the repository root:

```bash
npm run test:prototype
npm run test:prototype:sigterm
```

The preserved `cli-round1` SIGTERM test uses a fixed 80-ms startup delay. In transfer verification, some focused and serial runs passed, while later focused, serial, and parallel runs could signal the child before its handler was installed and report `null !== 0`. A fresh target-repository full run was 180/181 with only this failure. The commands intentionally retain that diagnostic behavior. Fix the harness with condition-based readiness in the mutable integrated snapshot, not in this immutable archive.

The prototype is intentionally not installed as the public ACC package. It remains coupled to Git and Papercut-specific conventions and predates the standalone Workspace/Intent/Workstream model.

`reports/` contains the Markdown task briefs, execution reports, and progress ledger from the original implementation. They are historical evidence and may reference ignored build artifacts or absolute paths that are not present here.

Later hardening work is archived separately under `migration/patches/`.
