#!/usr/bin/env node
// Deliberately outside runEntry: observation must not acquire a runtime lease,
// schedule updates or open/recover the coordination store.
import { runIndicator } from "@agents-can-communicate/cli/indicator";
await runIndicator();
