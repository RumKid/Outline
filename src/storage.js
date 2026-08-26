(function (root) {
  const FALLBACK_KEYS = [
    'pvp_tasks', 'pvp_habits', 'pvp_water', 'pvp_sessions', 'pvp_active',
    'pvp_sleep', 'pvp_intentions', 'pvp_daily_summaries', 'pvp_wealth',
    'pvp_projects', 'pvp_journal', 'pvp_ideas', 'pvp_enc_salt',
    'pvp_enc_verify', 'pvp_private_vault'
  ];

  function snapshot(storage, schemaVersion, now = new Date()) {
    const values = {};
    FALLBACK_KEYS.forEach(key => {
      const value = storage.getItem(key);
      if (value !== null) values[key] = value;
    });
    return { schemaVersion, savedAt: now.toISOString(), values };
  }

  function rotateAndSave(storage, currentKey, previousKey, value) {
    const current = storage.getItem(currentKey);
    if (current) storage.setItem(previousKey, current);
    storage.setItem(currentKey, JSON.stringify(value));
  }

  function restore(storage, currentKey, previousKey) {
    const raw = storage.getItem(currentKey) || storage.getItem(previousKey);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed.values || typeof parsed.values !== 'object') {
      throw new Error('Invalid browser backup');
    }
    Object.entries(parsed.values).forEach(([key, value]) => storage.setItem(key, value));
    return true;
  }

  const api = { FALLBACK_KEYS, snapshot, rotateAndSave, restore };
  root.OutlineStorage = api;
  if (root !== globalThis) globalThis.OutlineStorage = api;
})(typeof window === 'object' ? window : globalThis);
