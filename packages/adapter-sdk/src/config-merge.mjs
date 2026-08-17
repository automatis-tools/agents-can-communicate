const MARKER = "acc:owned";
// Ownership of single entries inside a container someone else also writes to.
// `enabledPlugins` in a Claude Code settings file holds every plugin the user
// has, so taking the whole key would destroy them - and giving it back on
// uninstall would destroy them again.
const ENTRY_MARKER = "acc:ownedEntries";

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

/**
 * Add entries inside containers ACC shares with the user.
 *
 * Records `[container, key]` pairs, so uninstall removes exactly the entries ACC
 * added. A container ACC had to create is additionally recorded as a whole owned
 * key, since removing the last entry from something nobody else wanted should
 * take the container with it.
 */
export function mergeOwnedEntries(existing, additions,
  { owner = MARKER, entryOwner = ENTRY_MARKER } = {}) {
  const merged = { ...existing };
  const owned = new Set(existing?.[owner] ?? []);
  const entries = new Map((existing?.[entryOwner] ?? [])
    .map(pair => [`${pair[0]}\u0000${pair[1]}`, pair]));

  for (const [container, values] of Object.entries(additions)) {
    const had = Object.hasOwn(existing ?? {}, container);
    merged[container] = { ...(existing?.[container] ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      merged[container][key] = value;
      entries.set(`${container}\u0000${key}`, [container, key]);
    }
    // Ours entirely, so uninstall may remove it outright.
    if (!had) owned.add(container);
  }

  merged[owner] = [...owned].sort();
  merged[entryOwner] = [...entries.values()]
    .sort((left, right) => left.join("/").localeCompare(right.join("/")));
  return merged;
}

/** Remove only the entries ACC recorded adding, leaving every other one. */
export function removeOwnedEntries(existing,
  { owner = MARKER, entryOwner = ENTRY_MARKER } = {}) {
  const result = { ...(existing ?? {}) };
  for (const [container, key] of result[entryOwner] ?? []) {
    if (result[container] === null || typeof result[container] !== "object") continue;
    const remaining = { ...result[container] };
    delete remaining[key];
    result[container] = remaining;
  }
  delete result[entryOwner];
  // Whole keys ACC created are handled by the same ownership record as before.
  return removeOwnedConfig(result, { owner });
}

export function ownedEntries(existing, { entryOwner = ENTRY_MARKER } = {}) {
  return (existing?.[entryOwner] ?? []).map(pair => [...pair]);
}
