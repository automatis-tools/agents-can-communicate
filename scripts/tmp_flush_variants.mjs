// Measurement only (throwaway branch): beside the suite, four times a second,
// how long a 4 KB record takes to reach the disk in each directory given, three
// ways - written and left to the cache (plain), written and flushed
// (FlushFileBuffers), and written through (FILE_FLAG_WRITE_THROUGH, which
// libuv sets for O_DSYNC). Plain says how much of the others is the disk.
// Usage: node scripts/tmp_flush_variants.mjs <log> <dir>... ; stops when <log>.stop exists.
import fs from "node:fs";
import path from "node:path";

const [log, ...directories] = process.argv.slice(2);
const stop = `${log}.stop`;
const block = Buffer.alloc(4096, 1);
// UV_FS_O_DSYNC on Windows; Node does not list it there, and passes it through.
const DSYNC = process.platform === "win32" ? 0x04000000 : fs.constants.O_DSYNC;
const WRITE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;

const variants = {
  plain: file => { const fd = fs.openSync(file, WRITE); try { fs.writeSync(fd, block); } finally { fs.closeSync(fd); } },
  flush: file => { const fd = fs.openSync(file, WRITE); try { fs.writeSync(fd, block); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
  through: file => { const fd = fs.openSync(file, WRITE | DSYNC); try { fs.writeSync(fd, block); } finally { fs.closeSync(fd); } },
};

const files = directories.map(directory => {
  fs.mkdirSync(directory, { recursive: true });
  return Object.fromEntries(Object.keys(variants)
    .map(name => [name, path.join(directory, `tmp-variant-${process.pid}-${name}.bin`)]));
});

const tick = () => {
  const sample = { t: Date.now() };
  for (const [index, directory] of directories.entries()) {
    for (const [name, write] of Object.entries(variants)) {
      const at = performance.now();
      write(files[index][name]);
      sample[`${path.parse(directory).root.replace(/[\\/:]/g, "") || "root"}.${name}`] =
        Math.round((performance.now() - at) * 10) / 10;
    }
  }
  fs.appendFileSync(log, `${JSON.stringify(sample)}\n`);
  if (fs.existsSync(stop)) {
    for (const set of files) for (const file of Object.values(set)) fs.rmSync(file, { force: true });
    return;
  }
  setTimeout(tick, 250);
};
setTimeout(tick, 250);
