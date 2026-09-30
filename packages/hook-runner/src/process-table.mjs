// The table lives in the adapter SDK, which adapters that read a process's
// arguments share with the hook runner; this keeps the runner's own name.
export { readProcessTable } from "@agents-can-communicate/adapter-sdk";
