// Interleave the sorted discovery list so every package and acceptance group
// contributes to each shard. No hand-maintained allowlist can miss a new test.
export function runnerOptions(args) {
  const options = { list: false, ifNeeded: false, shard: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--list" && !options.list) options.list = true;
    else if (argument === "--if-needed" && !options.ifNeeded) options.ifNeeded = true;
    else if (argument === "--shard" && options.shard === null) {
      const match = /^(\d+)\/(\d+)$/.exec(args[++index] ?? "");
      if (match === null) throw new Error("--shard requires index/count, for example 1/2");
      const [, part, count] = match.map(Number);
      if (!Number.isSafeInteger(part) || !Number.isSafeInteger(count) || part < 1 || count < part) {
        throw new Error("shard index and count must be positive integers with index <= count");
      }
      options.shard = { part, count };
    } else throw new Error(`unknown or repeated argument: ${argument}`);
  }
  if (options.ifNeeded && options.shard !== null) {
    throw new Error("--if-needed requires a complete suite, not a shard");
  }
  return options;
}

export function shardFiles(files, shard) {
  if (shard === null) return files;
  const selected = files.filter((_file, index) => index % shard.count === shard.part - 1);
  if (selected.length === 0) throw new Error("empty shard - refusing to report success");
  return selected;
}
