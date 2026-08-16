const MARKER = "acc:owned";

/**
 * Merge ACC entries into a user's config and record ownership, so uninstall can
 * remove exactly what ACC added and nothing else.
 *
 * The ownership record is what makes uninstall safe: without it the only way to
 * remove entries is to guess by shape, which is how a tool deletes a user's
 * unrelated hook that happened to look similar.
 */
export function mergeOwnedConfig(existing, additions, { owner = MARKER } = {}) {
  const merged = { ...existing };
  const owned = new Set(existing?.[owner] ?? []);
  for (const [key, value] of Object.entries(additions)) {
    merged[key] = value;
    owned.add(key);
  }
  merged[owner] = [...owned].sort();
  return merged;
}

export function removeOwnedConfig(existing, { owner = MARKER } = {}) {
  const owned = new Set(existing?.[owner] ?? []);
  const result = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    // Unrelated keys survive untouched, including keys a user added by hand
    // under a name ACC also uses elsewhere.
    if (key !== owner && !owned.has(key)) result[key] = value;
  }
  return result;
}

export function ownedKeys(existing, { owner = MARKER } = {}) {
  return [...(existing?.[owner] ?? [])];
}
