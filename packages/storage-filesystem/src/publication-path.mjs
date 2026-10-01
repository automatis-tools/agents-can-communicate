import path from "node:path";

// A journal entry names each file it publishes relative to the store root, with
// forward slashes on every platform. path.relative gives backslashes on Windows,
// and an entry would then read differently depending on where it was written.
export function publicationPath(root, file, pathApi = path) {
  return pathApi.relative(root, file).split(pathApi.sep).join("/");
}
