const MARKER = "acc:owned";
// Ownership of single entries inside a container someone else also writes to.
// `enabledPlugins` in a Claude Code settings file holds every plugin the user
// has, so taking the whole key would destroy them - and giving it back on
// uninstall would destroy them again.
const ENTRY_MARKER = "acc:ownedEntries";
// Containers ACC had to create. Recorded separately from whole owned keys:
// creating one is permission to remove it when it ends up empty, not permission
// to take whatever the user has put in it since.
const CREATED_MARKER = "acc:createdContainers";

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
 * added. A container ACC had to create is recorded too, but as a container it may
 * clean up rather than as a key it owns: an empty one left behind is litter, and
 * one the user has since put their own entries into is theirs.
 */
export function mergeOwnedEntries(existing, additions,
  { entryOwner = ENTRY_MARKER, createdOwner = CREATED_MARKER } = {}) {
  const merged = { ...existing };
  const entries = new Map((existing?.[entryOwner] ?? [])
    .map(pair => [`${pair[0]}\u0000${pair[1]}`, pair]));
  const created = new Set(existing?.[createdOwner] ?? []);

  for (const [container, values] of Object.entries(additions)) {
    if (!Object.hasOwn(existing ?? {}, container)) created.add(container);
    merged[container] = { ...(existing?.[container] ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      merged[container][key] = value;
      entries.set(`${container}\u0000${key}`, [container, key]);
    }
  }

  merged[entryOwner] = [...entries.values()]
    .sort((left, right) => left.join("/").localeCompare(right.join("/")));
  if (created.size > 0) merged[createdOwner] = [...created].sort();
  return merged;
}

/** Remove only the entries ACC recorded adding, leaving every other one. */
export function removeOwnedEntries(existing,
  { owner = MARKER, entryOwner = ENTRY_MARKER, createdOwner = CREATED_MARKER } = {}) {
  const result = { ...(existing ?? {}) };
  for (const [container, key] of result[entryOwner] ?? []) {
    if (result[container] === null || typeof result[container] !== "object") continue;
    const remaining = { ...result[container] };
    delete remaining[key];
    result[container] = remaining;
  }
  // A container ACC created goes only if nothing is left in it. Taking it
  // outright would delete entries the user added after the install - the exact
  // loss that recording ownership per entry exists to prevent.
  for (const container of result[createdOwner] ?? []) {
    const value = result[container];
    if (value !== null && typeof value === "object" && Object.keys(value).length === 0) {
      delete result[container];
    }
  }
  delete result[entryOwner];
  delete result[createdOwner];
  return removeOwnedConfig(result, { owner });
}

export function ownedEntries(existing, { entryOwner = ENTRY_MARKER } = {}) {
  return (existing?.[entryOwner] ?? []).map(pair => [...pair]);
}
