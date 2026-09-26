#!/usr/bin/env node
// Kept only for installs made by ACC 0.7.x or earlier. A 0.7.x updater refuses a
// downloaded package without this file, and a `claude` shell shim written by
// 0.7.x still runs it through its launcher until `acc install` or `acc update`
// retires the shim. A shim reads any exit other than 0 as "launch the vendor
// command untouched", so this answers 1 and writes nothing.
export async function main() {
  process.exitCode = 1;
}
