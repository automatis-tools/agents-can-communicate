import { runAstro } from "./lib/astro-build.mjs";
try { console.log(await runAstro(process.argv.slice(2))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
