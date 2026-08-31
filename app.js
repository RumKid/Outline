/* ================================================================
   UTILITIES
   ================================================================ */
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
const DATA_SCHEMA_VERSION = 1;
function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const today = () => dateKey();
const clamp = (v,mn,mx) => Math.max(mn, Math.min(mx, v));

function fmtDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function fmtDuration(mins) {
  if (!mins || mins <= 0) return '0m';
  const h = Math.floor(mins/60), m = mins%60;
  return h===0 ? `${m}m` : m===0 ? `${h}h` : `${h}h ${m}m`;
}
function last7() {
  return Array.from({length:7},(_,i)=>{
    const d=new Date(); d.setDate(d.getDate()-(6-i));
    return dateKey(d);
  });
}
function thisWeek() {
  const now=new Date(), day=now.getDay();
  const diff=day===0?-6:1-day;
  const mon=new Date(now); mon.setDate(now.getDate()+diff);
  return Array.from({length:7},(_,i)=>{
    const d=new Date(mon); d.setDate(mon.getDate()+i);
    return dateKey(d);
  });
}
function addDays(dateStr, amount) {
  const d = new Date((dateStr || today()) + 'T12:00:00');
  d.setDate(d.getDate() + amount);
  return dateKey(d);
}
function escH(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function eventArg(value) { return escH(JSON.stringify(String(value ?? ''))); }

function getDefaultWealthCategories() {
  return {
    income: ['Salary', 'Freelance', 'Investments', 'Gift', 'Other'],
    expense: ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Health', 'Education', 'Subscriptions', 'Other']
  };
}

const WEALTH_ACCOUNT_TYPES = new Set(['bank', 'cash', 'credit', 'investment']);
const WEALTH_CURRENCIES = new Set(['₹', '$', '€', '£']);
const WEALTH_TRANSACTION_TYPES = new Set(['income', 'expense', 'transfer']);

function isValidWealthText(value, maxLength = 100) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001F\u007F]/.test(value);
}

function toWealthNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidWealthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00');
  return !Number.isNaN(date.getTime()) && dateKey(date) === value;
}

function showToast(message, tone = 'info') {
  if (!document?.createElement || !document?.body?.appendChild) {
    if (typeof alert === 'function') alert(message);
    return;
  }
  const existing = document.querySelector('.outline-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `outline-toast ${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function showWealthValidationError(message) {
  showToast(message, 'error');
}

function lastWeek() {
  const now=new Date(), day=now.getDay();
  const diff=day===0?-13:-6-day;
  const mon=new Date(now); mon.setDate(now.getDate()+diff);
  return Array.from({length:7},(_,i)=>{
    const d=new Date(mon); d.setDate(mon.getDate()+i);
    return dateKey(d);
  });
}

/* ================================================================
   AUTH — AES-GCM ENCRYPTION ENGINE (SubtleCrypto / PBKDF2)
   ================================================================ */
const Auth = (() => {
  const SALT_KEY    = 'pvp_enc_salt';
  const VERIFY_KEY  = 'pvp_enc_verify';
  const VAULT_KEY   = 'pvp_private_vault';
  const PRIVATE_KEYS = ['pvp_tasks', 'pvp_habits', 'pvp_water', 'pvp_sessions', 'pvp_active', 'pvp_sleep', 'pvp_intentions', 'pvp_daily_summaries', 'pvp_wealth', 'pvp_projects', 'pvp_journal', 'pvp_ideas'];
  const VERIFY_MSG  = 'outline-verified';
  let _cryptoKey    = null; // lives in memory only
  let vaultTimer    = null;

  // ── helpers ────────────────────────────────────────────────────
  const { b64, unb64, deriveKey, encrypt: aesEncrypt, decrypt: aesDecrypt } = OutlineAuthCrypto;

  async function encryptProjectSubtasks(projects, key) {
    let modified = false;
    const encryptedProjects = await Promise.all((projects || []).map(async project => {
      const projectCopy = { ...project };
      projectCopy.tasks = await Promise.all((project.tasks || []).map(async task => {
        const taskCopy = { ...task };
        taskCopy.subtasks = await Promise.all((task.subtasks || []).map(async subtask => {
          const subtaskCopy = { ...subtask };
          if (typeof subtaskCopy.title === 'string') {
            const enc = await aesEncrypt(key, subtaskCopy.title);
            subtaskCopy.title = { _enc: true, ...enc };
            modified = true;
          }
          return subtaskCopy;
        }));
        return taskCopy;
      }));
      return projectCopy;
    }));
    return { encryptedProjects, modified };
  }

  function vaultSnapshot() {
    const snapshot = {};
    PRIVATE_KEYS.forEach(key => {
      const decryptedKey = key === 'pvp_journal' ? 'pvp_journal_dec' : key === 'pvp_ideas' ? 'pvp_ideas_dec' : key;
      snapshot[key] = S._cache[decryptedKey] !== undefined ? S._cache[decryptedKey] : S._cache[key] !== undefined ? S._cache[key] : S.g(key);
    });
    return snapshot;
  }

  async function saveVault() {
    if (!_cryptoKey) return false;
    const encrypted = await aesEncrypt(_cryptoKey, vaultSnapshot());
    localStorage.setItem(VAULT_KEY, JSON.stringify({ _enc: true, ...encrypted }));
    PRIVATE_KEYS.forEach(key => localStorage.removeItem(key));
    return true;
  }

  async function restoreVault() {
    if (!_cryptoKey) return false;
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const snapshot = await aesDecrypt(_cryptoKey, parsed);
    Object.entries(snapshot || {}).forEach(([key, value]) => { S._cache[key] = value; });
    if (snapshot.pvp_journal !== undefined) S._cache.pvp_journal_dec = snapshot.pvp_journal;
    if (snapshot.pvp_ideas !== undefined) S._cache.pvp_ideas_dec = snapshot.pvp_ideas;
    return true;
  }

  // ── public API ─────────────────────────────────────────────────
  return {
    hasPassword() {
      return !!localStorage.getItem(VERIFY_KEY);
    },
    isUnlocked() {
      return _cryptoKey !== null;
    },
    lock() {
      _cryptoKey = null;
    },
    isWriteAllowed() {
      return !this.hasPassword() || this.isUnlocked();
    },
    async flushVault() { return saveVault(); },
    queueVaultSave() {
      if (!this.hasPassword() || !this.isUnlocked()) return;
      clearTimeout(vaultTimer);
      vaultTimer = setTimeout(() => saveVault().catch(error => console.error('Vault save failed:', error)), 300);
    },
    async rotatePassword(password) {
      if (!_cryptoKey || !password || password.length < 6) return false;
      const oldSnapshot = vaultSnapshot();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const newKey = await deriveKey(password, salt);
      const encryptedVault = await aesEncrypt(newKey, oldSnapshot);
      const verifyPayload = await aesEncrypt(newKey, VERIFY_MSG);
      localStorage.setItem(SALT_KEY, b64(salt));
      localStorage.setItem(VERIFY_KEY, JSON.stringify(verifyPayload));
      localStorage.setItem(VAULT_KEY, JSON.stringify({ _enc: true, ...encryptedVault }));
      _cryptoKey = newKey;
      PRIVATE_KEYS.forEach(key => localStorage.removeItem(key));
      return true;
    },

    // Set a new password (first-time or change). Encrypts a
    // known verification token so we can test it on unlock.
    async setPassword(password, existingPlainJournal, existingPlainIdeas) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem(SALT_KEY, b64(salt));
      const key = await deriveKey(password, salt);
      _cryptoKey = key;

      // Store verification token
      const verifyPayload = await aesEncrypt(key, VERIFY_MSG);
      localStorage.setItem(VERIFY_KEY, JSON.stringify(verifyPayload));

      // Encrypt any existing plaintext data right now
      if (existingPlainJournal && Object.keys(existingPlainJournal).length > 0) {
        const enc = await aesEncrypt(key, existingPlainJournal);
        localStorage.setItem('pvp_journal', JSON.stringify({ _enc: true, ...enc }));
        S._cache['pvp_journal'] = null;
        S._cache['pvp_journal'] = existingPlainJournal;
        await DM.saveJournal();
      }
      if (existingPlainIdeas && existingPlainIdeas.length > 0) {
        const enc = await aesEncrypt(key, existingPlainIdeas);
        localStorage.setItem('pvp_ideas', JSON.stringify({ _enc: true, ...enc }));
        S._cache['pvp_ideas'] = null;
        S._cache['pvp_ideas'] = existingPlainIdeas;
        await DM.save();
      }

      // Encrypt task and subtask titles in localStorage/cache
      const tasks = S.tasks();
      let tasksModified = false;
      const encryptedTasks = await Promise.all(tasks.map(async t => {
        let taskCopy = { ...t };
        if (typeof taskCopy.title === 'string') {
          const enc = await aesEncrypt(key, taskCopy.title);
          taskCopy.title = { _enc: true, ...enc };
          tasksModified = true;
        }
        if (taskCopy.subtasks) {
          taskCopy.subtasks = await Promise.all(taskCopy.subtasks.map(async s => {
            let subCopy = { ...s };
            if (typeof subCopy.title === 'string') {
              const enc = await aesEncrypt(key, subCopy.title);
              subCopy.title = { _enc: true, ...enc };
              tasksModified = true;
            }
            return subCopy;
          }));
        }
        return taskCopy;
      }));
      if (tasksModified) {
        localStorage.setItem('pvp_tasks', JSON.stringify(encryptedTasks));
        S._cache['pvp_tasks'] = encryptedTasks;
        await DM.save();
      }

      // Encrypt daily intentions in localStorage/cache
      const intentions = S.intentions();
      let intentionsModified = false;
      const encryptedIntentions = {};
      for (const d of Object.keys(intentions)) {
        if (typeof intentions[d] === 'string') {
          const enc = await aesEncrypt(key, intentions[d]);
          encryptedIntentions[d] = { _enc: true, ...enc };
          intentionsModified = true;
        } else {
          encryptedIntentions[d] = intentions[d];
        }
      }
      if (intentionsModified) {
        localStorage.setItem('pvp_intentions', JSON.stringify(encryptedIntentions));
        S._cache['pvp_intentions'] = encryptedIntentions;
        await DM.save();
      }

      // Encrypt wealth accounts and transaction notes in localStorage/cache
      const wealthData = S.wealth();
      let wealthModified = false;
      if (wealthData.accounts.length > 0 || wealthData.transactions.length > 0) {
        wealthData.accounts = await Promise.all(wealthData.accounts.map(async a => {
          let aCopy = { ...a };
          if (typeof aCopy.name === 'string') {
            const enc = await aesEncrypt(key, aCopy.name);
            aCopy.name = { _enc: true, ...enc };
            wealthModified = true;
          }
          return aCopy;
        }));
        wealthData.transactions = await Promise.all(wealthData.transactions.map(async t => {
          let tCopy = { ...t };
          if (typeof tCopy.note === 'string' && tCopy.note) {
            const enc = await aesEncrypt(key, tCopy.note);
            tCopy.note = { _enc: true, ...enc };
            wealthModified = true;
          }
          return tCopy;
        }));
      }
      if (wealthModified) {
        localStorage.setItem('pvp_wealth', JSON.stringify(wealthData));
        S._cache['pvp_wealth'] = wealthData;
        await DM.save();
      }

      // Encrypt project titles and task titles in localStorage/cache
      const projects = S.projects();
      let projectsModified = false;
      const encryptedProjects = await Promise.all(projects.map(async project => {
        let projectCopy = { ...project };
        if (typeof projectCopy.title === 'string') {
          const enc = await aesEncrypt(key, projectCopy.title);
          projectCopy.title = { _enc: true, ...enc };
          projectsModified = true;
        }
        if (typeof projectCopy.description === 'string' && projectCopy.description) {
          const enc = await aesEncrypt(key, projectCopy.description);
          projectCopy.description = { _enc: true, ...enc };
          projectsModified = true;
        }
        if (projectCopy.tasks) {
          projectCopy.tasks = await Promise.all(projectCopy.tasks.map(async task => {
            let taskCopy = { ...task };
            if (typeof taskCopy.title === 'string') {
              const enc = await aesEncrypt(key, taskCopy.title);
              taskCopy.title = { _enc: true, ...enc };
              projectsModified = true;
            }
            if (taskCopy.subtasks) {
              taskCopy.subtasks = await Promise.all(taskCopy.subtasks.map(async subtask => {
                const subtaskCopy = { ...subtask };
                if (typeof subtaskCopy.title === 'string') {
                  const enc = await aesEncrypt(key, subtaskCopy.title);
                  subtaskCopy.title = { _enc: true, ...enc };
                  projectsModified = true;
                }
                return subtaskCopy;
              }));
            }
            return taskCopy;
          }));
        }
        return projectCopy;
      }));
      if (projectsModified) {
        localStorage.setItem('pvp_projects', JSON.stringify(encryptedProjects));
        S._cache['pvp_projects'] = encryptedProjects;
        await DM.save();
      }
      await saveVault();
    },

    // Try to unlock with the given password. Returns true/false.
    async unlock(password) {
      const saltRaw = localStorage.getItem(SALT_KEY);
      const verifyRaw = localStorage.getItem(VERIFY_KEY);
      if (!saltRaw || !verifyRaw) return false;
      try {
        const salt = unb64(saltRaw);
        const key  = await deriveKey(password, salt);
        const payload = JSON.parse(verifyRaw);
        const result  = await aesDecrypt(key, payload);
        if (result !== VERIFY_MSG) return false;
        _cryptoKey = key;
        if (await restoreVault()) return true;
        const projectMigration = await encryptProjectSubtasks(S.projects(), key);
        if (projectMigration.modified) {
          localStorage.setItem('pvp_projects', JSON.stringify(projectMigration.encryptedProjects));
          S._cache['pvp_projects'] = projectMigration.encryptedProjects;
          await DM.save();
        }
        await saveVault();
        return true;
      } catch {
        return false;
      }
    },

    // Encrypt any JS value. Returns { _enc:true, iv, data }.
    async encrypt(obj) {
      if (!_cryptoKey) throw new Error('Not unlocked');
      const p = await aesEncrypt(_cryptoKey, obj);
      return { _enc: true, ...p };
    },

    // Decrypt a payload { _enc, iv, data } → original JS value.
    async decrypt(payload) {
      if (!_cryptoKey) throw new Error('Not unlocked');
      return aesDecrypt(_cryptoKey, payload);
    },

    // Read + decrypt a localStorage key. Returns null if locked or missing.
    async readEncrypted(lsKey) {
      if (!_cryptoKey) return null;
      try {
        const raw = localStorage.getItem(lsKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed._enc) return parsed; // unencrypted legacy
        return await this.decrypt(parsed);
      } catch { return null; }
    },

    // Write + encrypt a value to a localStorage key.
    async writeEncrypted(lsKey, obj) {
      if (!_cryptoKey) throw new Error('Not unlocked');
      const enc = await this.encrypt(obj);
      localStorage.setItem(lsKey, JSON.stringify(enc));
    },

    // Encrypt a field value asynchronously if unlocked.
    async encryptField(val) {
      if (typeof val !== 'string') return val;
      if (!this.hasPassword()) return val;
      if (!_cryptoKey) throw new Error('Outline is locked');
      return this.encrypt(val);
    },

    // Decrypt a field value asynchronously if unlocked.
    async decryptField(val, placeholder) {
      if (typeof val === 'string') return val;
      if (val && val._enc) {
        if (_cryptoKey) {
          try {
            return await this.decrypt(val);
          } catch {
            return placeholder || '[Error Decrypting]';
          }
        }
        return placeholder || '[Locked]';
      }
      return val;
    }
  };
})();

function getStatsForDates(dates) {
  let scoreSum = 0, scoreCount = 0;
  let waterSum = 0;
  let studySum = 0;
  let sleepSum = 0, sleepCount = 0;
  let habitTotal = 0, habitDone = 0;

  const habits = S.habits();

  dates.forEach(d => {
    const s = calcScoreForDate(d);
    scoreSum += s;
    scoreCount++;

    waterSum += (S.waterMap()[d] || 0);

    const dayStudy = S.sessions().filter(s => s.date === d).reduce((sum, x) => sum + x.mins, 0);
    studySum += dayStudy;

    const sl = S.sleepMap()[d];
    if (sl) {
      sleepSum += sl.mins;
      sleepCount++;
    }

    habits.forEach(h => {
      habitTotal++;
      if (h.logs.includes(d)) {
        habitDone++;
      }
    });
  });

  return {
    scoreAvg: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
    waterAvg: scoreCount > 0 ? (waterSum / scoreCount) : 0,
    studyTotal: studySum,
    sleepAvg: sleepCount > 0 ? Math.round(sleepSum / sleepCount) : 0,
    habitPct: habitTotal > 0 ? Math.round((habitDone / habitTotal) * 100) : 0
  };
}

function fmtDurationShort(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function renderTrend(cur, prev, unit = '') {
  if (prev === 0) return `<span class="trend-neutral">—</span>`;
  const diff = cur - prev;
  if (diff > 0) return `<span class="trend-up">▲ +${diff}${unit}</span>`;
  if (diff < 0) return `<span class="trend-down">▼ ${diff}${unit}</span>`;
  return `<span class="trend-neutral">— 0${unit}</span>`;
}

function renderTrendStudy(cur, prev) {
  if (prev === 0) return `<span class="trend-neutral">—</span>`;
  const diff = cur - prev;
  if (diff > 0) return `<span class="trend-up">▲ +${fmtDurationShort(diff)}</span>`;
  if (diff < 0) return `<span class="trend-down">▼ -${fmtDurationShort(Math.abs(diff))}</span>`;
  return `<span class="trend-neutral">—</span>`;
}

function renderTrendSleep(cur, prev) {
  if (prev === 0) return `<span class="trend-neutral">—</span>`;
  const diff = cur - prev;
  if (diff > 0) return `<span class="trend-up">▲ +${fmtDurationShort(diff)}</span>`;
  if (diff < 0) return `<span class="trend-down">▼ -${fmtDurationShort(Math.abs(diff))}</span>`;
  return `<span class="trend-neutral">—</span>`;
}

function renderTrendWater(cur, prev) {
  if (prev === 0) return `<span class="trend-neutral">—</span>`;
  const diff = cur - prev;
  const diffL = (diff / 1000).toFixed(1);
  if (diff > 0) return `<span class="trend-up">▲ +${diffL}L</span>`;
  if (diff < 0) return `<span class="trend-down">▼ ${diffL}L</span>`;
  return `<span class="trend-neutral">—</span>`;
}

/* ================================================================
   FILE SYSTEM DATA MANAGER
   ================================================================ */
const DM = {
  dirHandle: null,
  fileName: 'outline-data.json',
  journalFileName: 'outline-journal.json',
  journalPendingKey: 'pvp_journal_pending',
  journalDraftKey: 'pvp_journal_draft',
  backupFileName: 'outline-data.backup.json',
  backupPreviousFileName: 'outline-data.backup.previous.json',
  journalBackupFileName: 'outline-journal.backup.json',
  journalBackupPreviousFileName: 'outline-journal.backup.previous.json',
  fallback: false,          // true = localStorage-only mode
  fallbackBackupKey: 'pvp_fallback_backup',
  fallbackBackupPreviousKey: 'pvp_fallback_backup_previous',
  saveTimer: null,
  saveJournalTimer: null,
  saveInFlight: null,
  journalSaveInFlight: null,
  savePending: false,
  journalSavePending: false,
  saveRetryTimer: null,
  journalRetryTimer: null,
  saveRetryCount: 0,
  journalRetryCount: 0,
  recoveryNotice: null,
  schemaMigrationNotice: null,
  schemaBlocked: false,
  skipNextDataBackup: false,
  skipNextJournalBackup: false,

  fallbackSnapshot() {
    return OutlineStorage.snapshot(localStorage, DATA_SCHEMA_VERSION);
  },

  saveFallbackBackup() {
    if (!this.fallback) return false;
    OutlineStorage.rotateAndSave(localStorage, this.fallbackBackupKey, this.fallbackBackupPreviousKey, this.fallbackSnapshot());
    return true;
  },

  restoreFallbackBackup() {
    const restored = OutlineStorage.restore(localStorage, this.fallbackBackupKey, this.fallbackBackupPreviousKey);
    if (!restored) return false;
    S.clearCache();
    return true;
  },

  exportFallback() {
    const blob = new Blob([JSON.stringify(this.fallbackSnapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'outline-browser-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  async exportCurrentData() {
    const data = this.fallback ? this.fallbackSnapshot() : (await this.load()) || this.fallbackSnapshot();
    const journal = this.fallback ? null : await this.loadJournal();
    const payload = { ...data, journal, exportType: 'outline-full-backup', exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'outline-full-backup.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast('Full backup downloaded', 'success');
  },

  // ── IndexedDB: persist the directory handle ──────────────────
  _dbProm: null,
  openDB() {
    if (this._dbProm) return this._dbProm;
    this._dbProm = new Promise((res, rej) => {
      const req = indexedDB.open('pvp_fs_v2', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => res(e.target.result);
      req.onerror   = () => rej(req.error);
    });
    return this._dbProm;
  },
  async storeHandle(h) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(h, 'dir');
    } catch(e) { console.warn('storeHandle:', e); }
  },
  async getStoredHandle() {
    try {
      const db = await this.openDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get('dir');
        req.onsuccess = () => res(req.result || null);
        req.onerror   = () => rej(req.error);
      });
    } catch { return null; }
  },

  // ── Init: check if we have a stored handle ───────────────────
  async init() {
    // Check if File System Access API is supported
    if (!window.showDirectoryPicker) {
      console.warn('File System Access API not supported — using localStorage');
      this.fallback = true;
      this.setStatus('browser', 'Browser storage only', 'File API not supported');
      return 'fallback';
    }
    const h = await this.getStoredHandle();
    if (h) {
      this.dirHandle = h;
      // Try to silently check if permission is already granted
      try {
        const q = await h.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') {
          // Already have permission — load data and go straight in
          await this.loadAll();
          this.setConnectedStatus(h.name);
          return 'ready';
        }
        // Permission not granted yet — try requesting it silently
        // (some browsers allow this without a gesture on reload)
        const r = await h.requestPermission({ mode: 'readwrite' });
        if (r === 'granted') {
          await this.loadAll();
          this.setConnectedStatus(h.name);
          return 'ready';
        }
      } catch(e) {
        console.warn('Auto-restore failed:', e);
      }
      // Could not auto-restore — need user gesture
      return 'restore';
    }
    return 'setup';
  },

  // ── Request/restore permission ────────────────────────────────
  async requestPermission() {
    if (!this.dirHandle) return false;
    try {
      const perm = await this.dirHandle.requestPermission({ mode: 'readwrite' });
      return perm === 'granted';
    } catch { return false; }
  },

  // ── Pick a folder ─────────────────────────────────────────────
  async pick() {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      const permission = await h.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted' && await h.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        this.setStatus('disconnected', 'Folder access denied', 'Allow read/write access and try again');
        return false;
      }
      if (!(await this.prepareForFolderSwitch())) return false;
      this.dirHandle = h;
      await this.storeHandle(h);
      this.fallback = false;
      return true;
    } catch(e) {
      if (e.name !== 'AbortError') console.error('pick:', e);
      return false;
    }
  },

  // Finish writes against the current folder before changing its handle.
  // Otherwise an in-flight write can continue against the newly selected
  // folder, or a delayed write can leave the app stuck in a pending state.
  async prepareForFolderSwitch() {
    const hadPendingData = this.savePending || this.saveInFlight;
    const hadPendingJournal = this.journalSavePending || this.journalSaveInFlight;
    const [dataResult, journalResult] = await Promise.all([
      hadPendingData ? this.flush() : true,
      hadPendingJournal ? this.flushJournal() : true
    ]);
    if (dataResult === false || journalResult === false) return false;

    clearTimeout(this.saveTimer);
    clearTimeout(this.saveRetryTimer);
    clearTimeout(this.saveJournalTimer);
    clearTimeout(this.journalRetryTimer);
    this.saveTimer = null;
    this.saveRetryTimer = null;
    this.saveJournalTimer = null;
    this.journalRetryTimer = null;
    this.savePending = false;
    this.journalSavePending = false;
    return !this.saveInFlight && !this.journalSaveInFlight;
  },

  // ── Read data from file ───────────────────────────────────────
  async readText(fileName, handle = this.dirHandle) {
    const fh = await handle.getFileHandle(fileName);
    const file = await fh.getFile();
    return file.text();
  },

  async writeText(fileName, text, handle = this.dirHandle) {
    const fh = await handle.getFileHandle(fileName, { create: true });
    const wr = await fh.createWritable();
    try {
      await wr.write(text);
      await wr.close();
    } catch (error) {
      try { await wr.abort(); } catch {}
      throw error;
    }
  },

  async backupExistingFile(fileName, backupFileName, previousBackupFileName, skipFlag, handle = this.dirHandle) {
    if (this[skipFlag]) {
      this[skipFlag] = false;
      return;
    }
    let currentText;
    try {
      currentText = await this.readText(fileName, handle);
    } catch (error) {
      if (error?.name === 'NotFoundError') return;
      throw error;
    }

    try {
      const previousBackup = await this.readText(backupFileName, handle);
      await this.writeText(previousBackupFileName, previousBackup, handle);
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
    await this.writeText(backupFileName, currentText, handle);
  },

  async loadJsonWithBackup(fileName, backupFileName, previousBackupFileName, kind, skipFlag) {
    let primaryText = null;
    try {
      primaryText = await this.readText(fileName);
    } catch (error) {
      if (error?.name !== 'NotFoundError') console.error(`Could not read ${kind}:`, error);
    }

    if (primaryText !== null) {
      try {
        return JSON.parse(primaryText);
      } catch (error) {
        console.error(`${kind} is corrupted:`, error);
      }
    }

    for (const recoveryFileName of [backupFileName, previousBackupFileName]) {
      try {
        const backupText = await this.readText(recoveryFileName);
        const recovered = JSON.parse(backupText);
        this.recoveryNotice = `${kind} backup restored`;
        this[skipFlag] = true;
        return recovered;
      } catch (error) {
        if (error?.name !== 'NotFoundError') console.error(`Could not recover ${kind} from ${recoveryFileName}:`, error);
      }
    }
    return null;
  },

  migrateData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const version = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 0;
    if (version > DATA_SCHEMA_VERSION) {
      this.schemaBlocked = true;
      this.schemaMigrationNotice = `Schema ${version} requires a newer Outline version`;
      this.setStatus('disconnected', 'Unsupported data version', 'Update Outline before saving');
      return null;
    }

    this.schemaBlocked = false;
    if (version === DATA_SCHEMA_VERSION) return data;

    const migrated = {
      ...data,
      schemaVersion: DATA_SCHEMA_VERSION,
      tasks: Array.isArray(data.tasks) ? data.tasks.map(task => ({
        ...task,
        subtasks: Array.isArray(task.subtasks) ? task.subtasks : []
      })) : [],
      habits: Array.isArray(data.habits) ? data.habits : [],
      water: data.water && typeof data.water === 'object' ? data.water : {},
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      sleep: data.sleep && typeof data.sleep === 'object' ? data.sleep : {},
      intentions: data.intentions && typeof data.intentions === 'object' ? data.intentions : {},
      dailySummaries: data.dailySummaries && typeof data.dailySummaries === 'object' ? data.dailySummaries : {},
      wealth: data.wealth && typeof data.wealth === 'object' ? data.wealth : { accounts: [], transactions: [], budgets: {}, categories: getDefaultWealthCategories() },
      projects: Array.isArray(data.projects) ? data.projects.map(project => ({
        ...project,
        tasks: Array.isArray(project.tasks) ? project.tasks.map(task => ({
          ...task,
          subtasks: Array.isArray(task.subtasks) ? task.subtasks : []
        })) : []
      })) : [],
      ideas: data.ideas ?? []
    };
    this.schemaMigrationNotice = `Legacy data upgraded to schema ${DATA_SCHEMA_VERSION}`;
    return migrated;
  },

  async load() {
    if (this.fallback || !this.dirHandle) return null;
    const data = await this.loadJsonWithBackup(this.fileName, this.backupFileName, this.backupPreviousFileName, 'Outline data', 'skipNextDataBackup');
    return this.migrateData(data);
  },

  // ── Write data to file ────────────────────────────────────────
  save() {
    if (this.fallback) this.saveFallbackBackup();
    if (this.fallback || !this.dirHandle) return Promise.resolve(false);
    compileDailySummaries();
    this.savePending = true;
    this.saveRetryCount = 0;
    clearTimeout(this.saveRetryTimer);
    this.saveRetryTimer = null;
    clearTimeout(this.saveTimer);
    this.setStatus('saving', 'Changes pending', 'Saving soon…');
    this.saveTimer = setTimeout(() => this.flush(), 800);
    return this.saveInFlight || Promise.resolve(true);
  },

  async flush() {
    if (this.fallback || !this.dirHandle) return false;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    clearTimeout(this.saveRetryTimer);
    this.saveRetryTimer = null;
    if (this.saveInFlight) {
      const result = await this.saveInFlight;
      if (result && this.savePending) return this.flush();
      return result;
    }
    if (!this.savePending) return true;
    this.savePending = false;
    this.saveInFlight = this._doSave().finally(() => {
      this.saveInFlight = null;
    });
    const result = await this.saveInFlight;
    if (result && this.savePending) return this.flush();
    return result;
  },

  scheduleSaveRetry() {
    clearTimeout(this.saveRetryTimer);
    const delay = Math.min(30000, 2000 * (2 ** Math.min(this.saveRetryCount - 1, 4)));
    this.saveRetryTimer = setTimeout(() => this.flush(), delay);
  },

  async _doSave() {
    if (!this.dirHandle || this.schemaBlocked) {
      if (this.schemaBlocked) this.setStatus('disconnected', 'Unsupported data version', 'Update Outline before saving');
      return false;
    }
    const targetHandle = this.dirHandle;
    this.setStatus('saving', 'Saving…', 'Writing to folder');
    if (Auth.hasPassword() && Auth.isUnlocked()) await Auth.flushVault();
    const data = {
      schemaVersion: DATA_SCHEMA_VERSION,
      tasks:          S.g('pvp_tasks')           || [],
      habits:         S.g('pvp_habits')          || [],
      water:          S.g('pvp_water')           || {},
      sessions:       S.g('pvp_sessions')        || [],
      active:         S.g('pvp_active'),
      sleep:          S.g('pvp_sleep')           || {},
      intentions:     S.g('pvp_intentions')      || {},
      dailySummaries: S.g('pvp_daily_summaries') || {},
      wealth:         S.g('pvp_wealth')          || { accounts:[], transactions:[], budgets:{}, categories:getDefaultWealthCategories() },
      projects:       S.g('pvp_projects')        || [],
      ideas:          (() => { const r = localStorage.getItem('pvp_ideas'); return r ? JSON.parse(r) : []; })(),
      savedAt:        new Date().toISOString(),
    };
    const vaultRaw = Auth.hasPassword() && Auth.isUnlocked() ? localStorage.getItem('pvp_private_vault') : null;
    if (vaultRaw) {
      data.privateVault = JSON.parse(vaultRaw);
      delete data.tasks; delete data.habits; delete data.water; delete data.sessions;
      delete data.active; delete data.sleep; delete data.intentions; delete data.dailySummaries;
      delete data.wealth; delete data.projects; delete data.ideas;
    }

    try {
      await this.backupExistingFile(this.fileName, this.backupFileName, this.backupPreviousFileName, 'skipNextDataBackup', targetHandle);
    } catch (error) {
      console.error('Could not create data backup; save cancelled:', error);
      this.savePending = true;
      this.saveRetryCount++;
      this.scheduleSaveRetry();
      this.setStatus('disconnected', 'Backup failed', 'Save cancelled · retrying automatically');
      return false;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.writeText(this.fileName, JSON.stringify(data, null, 2), targetHandle);
        this.saveRetryCount = 0;
        const now = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
        this.setStatus('connected', 'Saved to folder', `Last saved ${now}`);
        return true;
      } catch(e) {
        console.error(`Save attempt ${attempt} failed:`, e);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    this.savePending = true;
    this.saveRetryCount++;
    this.scheduleSaveRetry();
    this.setStatus('disconnected', 'Save failed', 'Retrying automatically · click to retry');
    return false;
  },

  // ── Read journal from file ────────────────────────────────────
  async loadJournal() {
    if (this.fallback || !this.dirHandle) return null;
    return this.loadJsonWithBackup(this.journalFileName, this.journalBackupFileName, this.journalBackupPreviousFileName, 'Journal data', 'skipNextJournalBackup');
  },

  // ── Write journal to file ─────────────────────────────────────
  saveJournal() {
    if (this.fallback || !this.dirHandle) return Promise.resolve(false);
    this.journalSavePending = true;
    this.journalRetryCount = 0;
    clearTimeout(this.journalRetryTimer);
    this.journalRetryTimer = null;
    clearTimeout(this.saveJournalTimer);
    // Journal edits are already debounced by updateJournalText. Start the
    // durable write immediately so a quick reload cannot lose the edit.
    return this.flushJournal();
  },

  async flushJournal() {
    if (this.fallback || !this.dirHandle) return false;
    clearTimeout(this.saveJournalTimer);
    this.saveJournalTimer = null;
    clearTimeout(this.journalRetryTimer);
    this.journalRetryTimer = null;
    if (this.journalSaveInFlight) {
      const result = await this.journalSaveInFlight;
      if (result && this.journalSavePending) return this.flushJournal();
      return result;
    }
    if (!this.journalSavePending) return true;
    this.journalSavePending = false;
    this.journalSaveInFlight = this._doSaveJournal().finally(() => {
      this.journalSaveInFlight = null;
    });
    const result = await this.journalSaveInFlight;
    if (result && this.journalSavePending) return this.flushJournal();
    return result;
  },

  scheduleJournalRetry() {
    clearTimeout(this.journalRetryTimer);
    const delay = Math.min(30000, 2000 * (2 ** Math.min(this.journalRetryCount - 1, 4)));
    this.journalRetryTimer = setTimeout(() => this.flushJournal(), delay);
  },

  async _doSaveJournal() {
    if (!this.dirHandle) return false;
    const targetHandle = this.dirHandle;
    const raw = localStorage.getItem('pvp_journal');
    const plainData = Auth.hasPassword() && Auth.isUnlocked()
      ? (S._cache['pvp_journal_dec'] || {})
      : (raw ? JSON.parse(raw) : {});
    const data = Auth.hasPassword() && Auth.isUnlocked()
      ? await Auth.encrypt(plainData)
      : plainData;
    try {
      await this.backupExistingFile(this.journalFileName, this.journalBackupFileName, this.journalBackupPreviousFileName, 'skipNextJournalBackup', targetHandle);
    } catch (error) {
      console.error('Could not create journal backup; save cancelled:', error);
      this.journalSavePending = true;
      this.journalRetryCount++;
      this.scheduleJournalRetry();
      this.setStatus('disconnected', 'Backup failed', 'Journal save cancelled · retrying automatically');
      return false;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.writeText(this.journalFileName, JSON.stringify(data, null, 2), targetHandle);
        localStorage.removeItem(this.journalPendingKey);
        this.journalRetryCount = 0;
        return true;
      } catch(e) {
        console.error(`Journal save attempt ${attempt} failed:`, e);
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    this.journalSavePending = true;
    this.journalRetryCount++;
    this.scheduleJournalRetry();
    this.setStatus('disconnected', 'Journal save failed', 'Retrying automatically · click to retry');
    return false;
  },

  async flushAll() {
    await Promise.allSettled([this.flush(), this.flushJournal()]);
  },

  async loadAll() {
    this.recoveryNotice = null;
    this.schemaMigrationNotice = null;
    this.schemaBlocked = false;
    const existing = await this.load();
    await this.applyToStore(existing);
    if (this.schemaMigrationNotice && !this.schemaBlocked) this.save();
    const existingJournal = await this.loadJournal();
    if (existingJournal && !existing?.privateVault) {
      // Store the raw blob (encrypted or plain) — decryption happens at read time
      delete S._cache['pvp_journal'];
      localStorage.setItem('pvp_journal', JSON.stringify(existingJournal));
      S._cache['pvp_journal_dec'] = undefined; // invalidate decrypted cache
    }
    // If the tab was reloaded while the file write was in flight, restore the
    // last local copy and retry it instead of replacing it with stale disk data.
    const pendingJournal = localStorage.getItem(this.journalPendingKey);
    if (pendingJournal && !existing?.privateVault) {
      localStorage.setItem('pvp_journal', pendingJournal);
      delete S._cache['pvp_journal'];
      S._cache['pvp_journal_dec'] = undefined;
      this.journalSavePending = true;
      this.flushJournal();
    }
    // Text input is debounced for disk writes. Recover a draft typed just
    // before reload, including when the debounce timer had not fired yet.
    if (!Auth.hasPassword()) {
      const draftRaw = localStorage.getItem(this.journalDraftKey);
      if (draftRaw) {
        try {
          const draft = JSON.parse(draftRaw);
          if (draft?.date && typeof draft.text === 'string') {
            const rawMap = localStorage.getItem('pvp_journal');
            const map = rawMap ? JSON.parse(rawMap) : {};
            map[draft.date] = { ...(map[draft.date] || {}), text: draft.text };
            const encoded = JSON.stringify(map);
            localStorage.setItem('pvp_journal', encoded);
            localStorage.setItem(this.journalPendingKey, encoded);
            delete S._cache['pvp_journal'];
            this.journalSavePending = true;
            localStorage.removeItem(this.journalDraftKey);
            this.flushJournal();
          }
        } catch (error) {
          console.warn('Could not recover journal draft:', error);
          localStorage.removeItem(this.journalDraftKey);
        }
      }
    }
    return existing;
  },

  // ── Load data into localStorage ───────────────────────────────
  async applyToStore(data) {
    if (!data) return;
    S.clearCache();
    if (data.privateVault) {
      localStorage.setItem('pvp_private_vault', JSON.stringify(data.privateVault));
      return;
    }
    if (data.tasks)          S.sSilent('pvp_tasks',           data.tasks);
    if (data.habits) {
      const defaults = ['Workout', 'Read', 'Study', 'Journal'];
      const migrated = data.habits.map(h => {
        if (defaults.includes(h.name) && !h.isDefault) {
          h.isDefault = true;
        }
        return h;
      });
      S.sSilent('pvp_habits', migrated);
    }
    if (data.water)          S.sSilent('pvp_water',           data.water);
    if (data.sessions)       S.sSilent('pvp_sessions',        data.sessions);
    if (data.active)         S.sSilent('pvp_active',          data.active);
    if (data.sleep)          S.sSilent('pvp_sleep',           data.sleep);
    if (data.intentions)     S.sSilent('pvp_intentions',      data.intentions);
    if (data.dailySummaries) S.sSilent('pvp_daily_summaries', data.dailySummaries);
    if (data.wealth)         S.sSilent('pvp_wealth',          data.wealth);
    if (data.projects)       S.sSilent('pvp_projects',        data.projects);
    // ideas may be an encrypted blob — store raw, don't decrypt here
    if (data.ideas !== undefined) {
      localStorage.setItem('pvp_ideas', JSON.stringify(data.ideas));
      S._cache['pvp_ideas'] = null;
      S._cache['pvp_ideas_dec'] = undefined;
    }
    compileDailySummaries();
  },

  // ── Status badge ─────────────────────────────────────────────
  setConnectedStatus(folderName) {
    if (this.schemaBlocked) {
      this.setStatus('disconnected', 'Unsupported data version', 'Update Outline before saving');
      return;
    }
    if (this.recoveryNotice) {
      recordRecoveryEvent(this.recoveryNotice, 'backup restored');
      this.setStatus('connected', 'Recovered backup', `${this.recoveryNotice} · ${folderName}`);
      return;
    }
    if (this.schemaMigrationNotice) {
      recordRecoveryEvent(this.schemaMigrationNotice, 'schema migration');
      this.setStatus('connected', 'Data upgraded', `${this.schemaMigrationNotice} · ${folderName}`);
      return;
    }
    this.setStatus('connected', 'Data folder connected', folderName);
  },

  setStatus(state, txt, sub) {
    this.currentStatus = { state, txt, sub };
    const dot = $('data-dot'), stxt = $('data-status-txt'), ssub = $('data-status-sub');
    if (dot) {
      dot.className = 'data-dot';
      if (state==='connected')    { dot.classList.add('connected'); }
      else if (state==='saving')  { dot.classList.add('saving'); }
      else if (state==='browser') { dot.classList.add('connected'); }
      else                        { dot.classList.add('disconnected'); }
    }
    if (stxt) stxt.textContent = txt;
    if (ssub) ssub.textContent = sub;
    const banner = $('save-state-banner');
    if (banner) {
      const persistent = state === 'disconnected';
      banner.classList.toggle('hidden', !persistent);
      banner.className = `save-state-banner ${persistent ? state : ''} ${persistent ? '' : 'hidden'}`;
      banner.textContent = persistent ? `${txt} — ${sub}` : '';
    }
  }
};

/* ================================================================
   SETUP FLOW
   ================================================================ */
function recordRecoveryEvent(message, type) {
  try {
    const current = JSON.parse(localStorage.getItem('pvp_recovery_history') || '[]');
    const entry = { message, type, at: new Date().toISOString() };
    if (!current.some(item => item.message === message && Date.parse(item.at) > Date.now() - 60000)) {
      localStorage.setItem('pvp_recovery_history', JSON.stringify([entry, ...current].slice(0, 20)));
    }
  } catch { /* recovery history is best-effort metadata */ }
}

function recoveryHistory() {
  try { return JSON.parse(localStorage.getItem('pvp_recovery_history') || '[]'); } catch { return []; }
}

function completePrivacyChecklist() {
  localStorage.setItem('pvp_privacy_checklist_done', '1');
  renderView('settings');
  showToast('Privacy checklist completed', 'success');
}

function handleDataStatusClick() {
  if (DM.savePending || DM.journalSavePending) {
    DM.flushAll();
    return;
  }
  pickFolder(true);
}

async function pickFolder(isChange) {
  const btn = $('setup-pick-btn');
  if (btn) btn.textContent = '⏳  Opening folder picker…';
  const ok = await DM.pick();
  if (!ok) {
    if (btn) btn.textContent = ' Select Data Folder';
    return;
  }
  await finishSetup(isChange);
}

async function restorePermission() {
  const ok = await DM.requestPermission();
  if (ok) {
    $('restore-banner').classList.add('hidden');
    await DM.loadAll();
    DM.setConnectedStatus(DM.dirHandle.name);
    hideOverlay();
    renderView('dashboard');
    updateScore();
  } else {
    // Permission denied — fall through to setup
    $('restore-banner').classList.add('hidden');
    $('setup-overlay').classList.remove('hidden');
  }
}

async function finishSetup(isChange) {
  // Try to load existing data from the chosen folder
  const existing = await DM.loadAll();
  if (!existing) {
    // First time — save current (possibly empty) data
    await DM._doSave();
  }
  const existingJournal = await DM.loadJournal();
  if (!existingJournal) {
    await DM._doSaveJournal();
  }
  DM.setConnectedStatus(DM.dirHandle.name);
  if (isChange) {
    // Already in app — just update status
    return;
  }
  hideOverlay();
  renderView('dashboard');
  updateScore();
}

async function useFallbackMode() {
  DM.fallback = true;
  DM.setStatus('browser', 'Browser storage', 'Data in browser cache');
  $('restore-banner').classList.add('hidden');
  hideOverlay();
  renderView('dashboard');
  updateScore();
}

function hideOverlay() { $('setup-overlay').classList.add('hidden'); }

/* ================================================================
   STORE (localStorage runtime cache + triggers DM.save)
   ================================================================ */
const S = {
  _cache: {},
  g(k) {
    if (this._cache[k] !== undefined) return this._cache[k];
    try {
      const val = JSON.parse(localStorage.getItem(k));
      this._cache[k] = val;
      return val;
    } catch {
      return null;
    }
  },
  s(k,v) {
    if (!Auth.isWriteAllowed()) throw new Error('Outline is locked');
    this._cache[k] = v;
    localStorage.setItem(k, JSON.stringify(v));
    Auth.queueVaultSave();
    DM.save();
  },
  sSilent(k,v) {
    if (!Auth.isWriteAllowed()) throw new Error('Outline is locked');
    this._cache[k] = v;
    localStorage.setItem(k, JSON.stringify(v));
    Auth.queueVaultSave();
  },
  clearCache() {
    this._cache = {};
  },

  habits() {
    let h=this.g('pvp_habits');
    if(!h){
      h=[
        {id:uid(),name:'Workout',icon:'',color:'#fb923c',logs:[],isDefault:true},
        {id:uid(),name:'Read',   icon:'',color:'#f472b6',logs:[],isDefault:true},
        {id:uid(),name:'Study',  icon:'', color:'#a78bfa',logs:[],isDefault:true},
        {id:uid(),name:'Journal',icon:'',color:'#34d399',logs:[],isDefault:true},
      ];
      this.s('pvp_habits',h);
    } else {
      let modified = false;
      const defaults = ['Workout', 'Read', 'Study', 'Journal'];
      h = h.map(item => {
        if (defaults.includes(item.name) && !item.isDefault) {
          item.isDefault = true;
          modified = true;
        }
        return item;
      });
      if (modified) {
        this.sSilent('pvp_habits', h);
      }
    }
    return h;
  },
  saveHabits(h){ this.s('pvp_habits',h); },
  toggleHabit(id){
    const t=today();
    this.s('pvp_habits', this.habits().map(h=>{
      if(h.id!==id) return h;
      const done=h.logs.includes(t);
      return {...h,logs:done?h.logs.filter(d=>d!==t):[...h.logs,t]};
    }));
  },
  streak(habit){
    // Start from today if already logged, otherwise from yesterday,
    // so we always show the most recent unbroken streak.
    let d = new Date();
    const todayStr = dateKey(d);
    if (!habit.logs.includes(todayStr)) {
      // today not yet checked — start counting from yesterday
      d.setDate(d.getDate() - 1);
    }
    let n = 0;
    while (true) {
      const ds = dateKey(d);
      if (habit.logs.includes(ds)) {
        n++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return n;
  },

  waterMap(){ return this.g('pvp_water')||{}; },
  waterToday(){ return this.waterMap()[today()]||0; },
  addWater(ml){ const m=this.waterMap(); m[today()]=(m[today()]||0)+ml; this.s('pvp_water',m); },
  removeWater(ml){ const m=this.waterMap(); m[today()]=Math.max(0,(m[today()]||0)-ml); this.s('pvp_water',m); },
  resetWater(){ const m=this.waterMap(); m[today()]=0; this.s('pvp_water',m); },

  sessions(){ return this.g('pvp_sessions')||[]; },
  activeSession(){ return this.g('pvp_active'); },
  startSession(){ 
    this.s('pvp_active',{start:new Date().toISOString()}); 
    localStorage.setItem('pvp_last_tick', String(Date.now()));
  },
  stopSession(endTimeMs){
    const a=this.activeSession(); if(!a) return;
    const end = endTimeMs ? new Date(endTimeMs) : new Date();
    const MAX_SESSION_MINS = 240; // 4 hour cap
    let mins=Math.round((end.getTime()-new Date(a.start).getTime())/60000);
    if(mins > MAX_SESSION_MINS) mins = MAX_SESSION_MINS;
    if(mins < 1) mins = 1;
    const ss=this.sessions();
    const sessionDate = dateKey(new Date(a.start));
    ss.push({id:uid(),date:sessionDate,start:a.start,end:end.toISOString(),mins});
    this.s('pvp_sessions',ss); this.s('pvp_active',null);
    localStorage.removeItem('pvp_last_tick');
  },
  delSession(id){ this.s('pvp_sessions', this.sessions().filter(s=>s.id!==id)); },
  todayStudyMins(){
    const t=today();
    const completed = this.sessions().filter(s=>s.date===t).reduce((s,x)=>s+x.mins,0);
    const a = this.activeSession();
    let activeMins = 0;
    if(a) {
      activeMins = Math.floor((Date.now()-new Date(a.start).getTime())/60000);
      if(activeMins > 240) activeMins = 240;
    }
    return completed + activeMins;
  },
  sleepMap(){ return this.g('pvp_sleep')||{}; },
  logSleep(bed,wake,mins){ const m=this.sleepMap(); m[today()]={bed,wake,mins}; this.s('pvp_sleep',m); },
  todaySleep(){ return this.sleepMap()[today()]||null; },

  intentions() { return this.g('pvp_intentions') || {}; },
  todayIntention() { return this.intentions()[today()] || ''; },
  async todayIntentionDecrypted() {
    const raw = this.todayIntention();
    if (!raw) return '';
    return Auth.decryptField(raw, '[Locked Intention]');
  },
  async setIntention(val) {
    const i = this.intentions();
    i[today()] = await Auth.encryptField(val);
    this.s('pvp_intentions', i);
  },

  // ── Journal (encrypted when password is set) ──────────────────
  journalMap() {
    // Synchronous read: returns decrypted map if unlocked,
    // empty object if locked (lock screen guards access anyway).
    if (!Auth.hasPassword()) {
      return this.g('pvp_journal') || {};
    }
    if (!Auth.isUnlocked()) return {};
    // Attempt sync read of already-cached decrypted value
    if (this._cache['pvp_journal_dec'] !== undefined) {
      return this._cache['pvp_journal_dec'] || {};
    }
    return {}; // caller must use journalMapAsync
  },
  async journalMapAsync() {
    if (!Auth.hasPassword()) return this.g('pvp_journal') || {};
    if (!Auth.isUnlocked()) return {};
    if (this._cache['pvp_journal_dec'] !== undefined) {
      return this._cache['pvp_journal_dec'] || {};
    }
    const map = await Auth.readEncrypted('pvp_journal');
    this._cache['pvp_journal_dec'] = map || {};
    return this._cache['pvp_journal_dec'];
  },
  async saveJournal(map) {
    this._cache['pvp_journal_dec'] = map;
    if (Auth.hasPassword() && Auth.isUnlocked()) {
      await Auth.writeEncrypted('pvp_journal', map);
      this._cache['pvp_journal'] = null; // invalidate raw cache
    } else {
      this._cache['pvp_journal'] = map;
      localStorage.setItem('pvp_journal', JSON.stringify(map));
    }
    if (!DM.fallback) {
      localStorage.setItem(DM.journalPendingKey, localStorage.getItem('pvp_journal') || '{}');
    }
    Auth.queueVaultSave();
    return DM.saveJournal();
  },

  // ── Ideas (encrypted when password is set) ────────────────────
  ideas() {
    if (!Auth.hasPassword()) return this.g('pvp_ideas') || [];
    if (!Auth.isUnlocked()) return [];
    if (this._cache['pvp_ideas_dec'] !== undefined) {
      return this._cache['pvp_ideas_dec'] || [];
    }
    return [];
  },
  async ideasAsync() {
    if (!Auth.hasPassword()) return this.g('pvp_ideas') || [];
    if (!Auth.isUnlocked()) return [];
    if (this._cache['pvp_ideas_dec'] !== undefined) {
      return this._cache['pvp_ideas_dec'] || [];
    }
    const list = await Auth.readEncrypted('pvp_ideas');
    this._cache['pvp_ideas_dec'] = list || [];
    return this._cache['pvp_ideas_dec'];
  },
  async _saveIdeas(list) {
    this._cache['pvp_ideas_dec'] = list;
    if (Auth.hasPassword() && Auth.isUnlocked()) {
      await Auth.writeEncrypted('pvp_ideas', list);
      this._cache['pvp_ideas'] = null;
    } else {
      this._cache['pvp_ideas'] = list;
      localStorage.setItem('pvp_ideas', JSON.stringify(list));
    }
    Auth.queueVaultSave();
    DM.save();
  },
  async addIdea(title, desc) {
    const list = await this.ideasAsync();
    list.push({ id: uid(), title, desc, column: 'inbox' });
    await this._saveIdeas(list);
  },
  async updateIdea(id, fields) {
    const list = (await this.ideasAsync()).map(idea =>
      idea.id === id ? { ...idea, ...fields } : idea
    );
    await this._saveIdeas(list);
  },
  async delIdea(id) {
    const list = (await this.ideasAsync()).filter(idea => idea.id !== id);
    await this._saveIdeas(list);
  },

  // ── Projects ──────────────────────────────────────────────────
  projects() {
    const list = this.g('pvp_projects') || [];
    return list.map(project => ({
      tasks: [],
      status: 'active',
      ...project,
      tasks: (Array.isArray(project.tasks) ? project.tasks : []).map(task => ({
        ...task,
        status: task.done ? 'done' : ['backlog', 'todo', 'in-progress'].includes(task.status) ? task.status : 'backlog'
      }))
    }));
  },
  async addProject(project) {
    const list = this.projects();
    const projectCopy = { ...project };
    projectCopy.title = await Auth.encryptField(projectCopy.title);
    if (projectCopy.description) {
      projectCopy.description = await Auth.encryptField(projectCopy.description);
    }
    projectCopy.status = projectCopy.status || 'active';
    projectCopy.tasks = Array.isArray(projectCopy.tasks) ? projectCopy.tasks : [];
    list.push(projectCopy);
    this.s('pvp_projects', list);
  },
  async updateProject(id, updates) {
    const list = this.projects();
    const idx = list.findIndex(project => project.id === id);
    if (idx === -1) return;
    const current = list[idx];
    const next = { ...current, ...updates };
    if (updates.title !== undefined && typeof updates.title === 'string') {
      next.title = await Auth.encryptField(updates.title);
    }
    if (updates.description !== undefined) {
      next.description = updates.description ? await Auth.encryptField(updates.description) : '';
    }
    list[idx] = next;
    this.s('pvp_projects', list);
  },
  delProject(id) {
    this.s('pvp_projects', this.projects().filter(project => project.id !== id));
  },
  async addProjectTask(projectId, title, priority = 'medium') {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    const encryptedTitle = await Auth.encryptField(title);
    project.tasks = Array.isArray(project.tasks) ? project.tasks : [];
    project.tasks.push({ id: uid(), title: encryptedTitle, priority, status: 'backlog', done: false, subtasks: [], createdAt: new Date().toISOString() });
    this.s('pvp_projects', list);
  },
  toggleProjectTask(projectId, taskId) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    project.tasks = (project.tasks || []).map(task => {
      if (task.id !== taskId) return task;
      const nextDone = !task.done;
      const subtasks = (task.subtasks || []).map(subtask => ({ ...subtask, done: nextDone }));
      return { ...task, status: nextDone ? 'done' : 'backlog', done: nextDone, subtasks };
    });
    this.s('pvp_projects', list);
  },
  delProjectTask(projectId, taskId) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    project.tasks = (project.tasks || []).filter(task => task.id !== taskId);
    this.s('pvp_projects', list);
  },
  setProjectTaskStatus(projectId, taskId, status) {
    const statuses = ['backlog', 'todo', 'in-progress', 'done'];
    if (!statuses.includes(status)) return;
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    project.tasks = (project.tasks || []).map(task => task.id === taskId
      ? { ...task, status, done: status === 'done', subtasks: status === 'done' ? (task.subtasks || []).map(subtask => ({ ...subtask, done: true })) : task.subtasks }
      : task);
    this.s('pvp_projects', list);
  },
  async addProjectSubtask(projectId, parentTaskId, title) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    const parentTask = (project.tasks || []).find(task => task.id === parentTaskId);
    if (!parentTask) return;
    const encryptedTitle = await Auth.encryptField(title);
    parentTask.subtasks = Array.isArray(parentTask.subtasks) ? parentTask.subtasks : [];
    parentTask.subtasks.push({ id: uid(), title: encryptedTitle, done: false });
    parentTask.done = false;
    this.s('pvp_projects', list);
  },
  toggleProjectSubtask(projectId, parentTaskId, subtaskId) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    const parentTask = (project.tasks || []).find(task => task.id === parentTaskId);
    if (!parentTask) return;
    parentTask.subtasks = (parentTask.subtasks || []).map(subtask => subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask);
    parentTask.done = parentTask.subtasks.length > 0 ? parentTask.subtasks.every(subtask => subtask.done) : parentTask.done;
    this.s('pvp_projects', list);
  },
  delProjectSubtask(projectId, parentTaskId, subtaskId) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project) return;
    const parentTask = (project.tasks || []).find(task => task.id === parentTaskId);
    if (!parentTask) return;
    parentTask.subtasks = (parentTask.subtasks || []).filter(subtask => subtask.id !== subtaskId);
    parentTask.done = parentTask.subtasks.length > 0 ? parentTask.subtasks.every(subtask => subtask.done) : parentTask.done;
    this.s('pvp_projects', list);
  },
  reorderProjectTasks(projectId, draggedTaskId, targetTaskId, after) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project || !project.tasks) return;
    const draggedTask = project.tasks.find(task => task.id === draggedTaskId);
    if (!draggedTask) return;
    const remaining = project.tasks.filter(task => task.id !== draggedTaskId);
    const targetIdx = remaining.findIndex(task => task.id === targetTaskId);
    if (targetIdx !== -1) {
      const insertIdx = after ? targetIdx + 1 : targetIdx;
      remaining.splice(insertIdx, 0, draggedTask);
    } else {
      remaining.push(draggedTask);
    }
    project.tasks = remaining;
    this.s('pvp_projects', list);
  },
  reorderProjectSubtasks(projectId, parentTaskId, draggedSubId, targetSubId, after) {
    const list = this.projects();
    const project = list.find(item => item.id === projectId);
    if (!project || !project.tasks) return;
    const parentTask = project.tasks.find(task => task.id === parentTaskId);
    if (!parentTask || !parentTask.subtasks) return;
    const draggedSub = parentTask.subtasks.find(subtask => subtask.id === draggedSubId);
    if (!draggedSub) return;
    const remaining = parentTask.subtasks.filter(subtask => subtask.id !== draggedSubId);
    const targetIdx = remaining.findIndex(subtask => subtask.id === targetSubId);
    if (targetIdx !== -1) {
      const insertIdx = after ? targetIdx + 1 : targetIdx;
      remaining.splice(insertIdx, 0, draggedSub);
    } else {
      remaining.push(draggedSub);
    }
    parentTask.subtasks = remaining;
    this.s('pvp_projects', list);
  },

  // ── Wealth Store Methods ──────────────────────────────────────
  wealth() {
    const defaultCategories = getDefaultWealthCategories();
    const data = this.g('pvp_wealth') || {};
    const categories = data.categories || {};
    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      transactions: Array.isArray(data.transactions) ? data.transactions : [],
      budgets: data.budgets && typeof data.budgets === 'object' ? data.budgets : {},
      categories: {
        income: Array.isArray(categories.income) && categories.income.length > 0 ? categories.income : defaultCategories.income,
        expense: Array.isArray(categories.expense) && categories.expense.length > 0 ? categories.expense : defaultCategories.expense
      }
    };
  },
  _saveWealth(w) {
    this.s('pvp_wealth', w);
  },
  async addWealthAccount(acc) {
    const name = typeof acc?.name === 'string' ? acc.name.trim() : '';
    const balance = toWealthNumber(acc?.balance);
    const type = acc?.type || 'bank';
    const currency = acc?.currency || '₹';
    if (!acc?.id || !isValidWealthText(name) || balance === null || !WEALTH_ACCOUNT_TYPES.has(type) || !WEALTH_CURRENCIES.has(currency)) return false;
    const w = this.wealth();
    const account = { ...acc, name, balance, type, currency };
    account.name = await Auth.encryptField(account.name);
    w.accounts.push(account);
    this._saveWealth(w);
    return true;
  },
  async editWealthAccount(id, updates) {
    const w = this.wealth();
    const idx = w.accounts.findIndex(a => a.id === id);
    if (idx === -1 || !updates || typeof updates !== 'object') return false;
    const next = { ...updates };
    if (next.name !== undefined) {
      if (!isValidWealthText(next.name)) return false;
      next.name = await Auth.encryptField(next.name.trim());
    }
    if (next.balance !== undefined) {
      next.balance = toWealthNumber(next.balance);
      if (next.balance === null) return false;
    }
    if (next.type !== undefined && !WEALTH_ACCOUNT_TYPES.has(next.type)) return false;
    if (next.currency !== undefined && !WEALTH_CURRENCIES.has(next.currency)) return false;
    w.accounts[idx] = { ...w.accounts[idx], ...next };
    this._saveWealth(w);
    return true;
  },
  delWealthAccount(id) {
    const w = this.wealth();
    if (!w.accounts.some(account => account.id === id)) return false;
    if (w.transactions.some(transaction => transaction.accountId === id || transaction.toAccountId === id)) return false;
    w.accounts = w.accounts.filter(a => a.id !== id);
    this._saveWealth(w);
    return true;
  },
  async addWealthTransaction(txn) {
    const type = txn?.type;
    const amount = toWealthNumber(txn?.amount);
    const date = txn?.date;
    if (!txn?.id || !WEALTH_TRANSACTION_TYPES.has(type) || amount === null || amount <= 0 || !isValidWealthDate(date)) return false;
    const w = this.wealth();
    const source = w.accounts.find(account => account.id === txn.accountId);
    if (!source || toWealthNumber(source.balance) === null) return false;
    if (type === 'transfer' && (!txn.toAccountId || txn.toAccountId === txn.accountId)) return false;
    const destination = type === 'transfer' ? w.accounts.find(account => account.id === txn.toAccountId) : null;
    if (type === 'transfer' && (!destination || toWealthNumber(destination.balance) === null)) return false;
    if (!isValidWealthText(txn.category, 80)) return false;
    if (txn.note !== undefined && txn.note !== '' && !isValidWealthText(txn.note, 500)) return false;

    const transaction = { ...txn, type, amount, date, category: txn.category.trim() };
    if (transaction.note) transaction.note = await Auth.encryptField(transaction.note.trim());
    w.transactions.push(transaction);

    // Update account balances
    if (type === 'income') {
      source.balance += amount;
    } else if (type === 'expense') {
      source.balance -= amount;
    } else if (type === 'transfer') {
      source.balance -= amount;
      destination.balance += amount;
    }

    this._saveWealth(w);
    return true;
  },
  delWealthTransaction(id) {
    const w = this.wealth();
    const txn = w.transactions.find(t => t.id === id);
    if (!txn) return false;
    const amount = toWealthNumber(txn.amount);
    if (amount === null || amount <= 0) return false;
    if (txn.type === 'income' || txn.type === 'expense') {
      const account = w.accounts.find(a => a.id === txn.accountId);
      if (!account || toWealthNumber(account.balance) === null) return false;
    } else if (txn.type === 'transfer') {
      const source = w.accounts.find(a => a.id === txn.accountId);
      const destination = w.accounts.find(a => a.id === txn.toAccountId);
      if (!source || !destination || toWealthNumber(source.balance) === null || toWealthNumber(destination.balance) === null) return false;
    } else {
      return false;
    }
    {
      if (txn.type === 'income') {
        const acct = w.accounts.find(a => a.id === txn.accountId);
        acct.balance -= amount;
      } else if (txn.type === 'expense') {
        const acct = w.accounts.find(a => a.id === txn.accountId);
        acct.balance += amount;
      } else if (txn.type === 'transfer') {
        const src = w.accounts.find(a => a.id === txn.accountId);
        const dst = w.accounts.find(a => a.id === txn.toAccountId);
        src.balance += amount;
        dst.balance -= amount;
      }
      w.transactions = w.transactions.filter(t => t.id !== id);
      this._saveWealth(w);
      return true;
    }
  },
  setWealthBudget(category, amount) {
    const w = this.wealth();
    const budget = toWealthNumber(amount);
    if (!isValidWealthText(category, 80) || budget === null || budget < 0 || !w.categories.expense.includes(category)) return false;
    w.budgets[category] = budget;
    this._saveWealth(w);
    return true;
  },
  delWealthBudget(category) {
    const w = this.wealth();
    if (!w.categories.expense.includes(category)) return false;
    delete w.budgets[category];
    this._saveWealth(w);
    return true;
  }
};

/* ================================================================
   DAILY SCORE
   ================================================================ */
function calcStreakForDate(habit, dateStr) {
  let n = 0;
  let curr = new Date(dateStr + 'T12:00:00'); // Use noon to avoid timezone shift issues
  while (true) {
    const ds = dateKey(curr);
    if (habit.logs && habit.logs.includes(ds)) {
      n++;
      curr.setDate(curr.getDate() - 1);
    } else {
      break;
    }
  }
  return n;
}

function calcSleepScore(mins) {
  if (!mins || mins <= 0) return 0;
  if (mins >= 420 && mins <= 480) return 1.0; // 7-8 hours (ideal)
  if (mins >= 360 && mins < 420) return 0.85 + ((mins - 360) / 60) * 0.15; // 6-7 hours
  if (mins > 480 && mins <= 540) return 0.85 + ((540 - mins) / 60) * 0.15; // 8-9 hours
  if (mins >= 300 && mins < 360) return 0.50 + ((mins - 300) / 60) * 0.35; // 5-6 hours
  if (mins > 540 && mins <= 600) return 0.50 + ((600 - mins) / 60) * 0.35; // 9-10 hours
  if (mins < 300) return (mins / 300) * 0.5; // < 5 hours
  if (mins > 600) {
    if (mins >= 840) return 0; // > 14 hours (oversleeping)
    return 0.5 * (1 - (mins - 600) / 240); // 10-14 hours falloff
  }
  return 0;
}

function calcScoreForDate(d){
  const dayTasks = S.tasks().filter(t => t.date === d);
  const habits = S.habits();
  const checkedHabits = habits.filter(h => h.logs && h.logs.includes(d));
  const waterMl = S.waterMap()[d] || 0;
  const sl = S.sleepMap()[d] || null;
  const sleepMins = sl ? sl.mins : 0;
  const studyMins = S.sessions().filter(s => s.date === d).reduce((sum, s) => sum + s.mins, 0);

  // 1. Edge Case: Empty Day (no data logged)
  const isEmptyDay = (
    dayTasks.length === 0 &&
    waterMl === 0 &&
    !sl &&
    studyMins === 0 &&
    checkedHabits.length === 0
  );
  if (isEmptyDay) {
    return 15;
  }

  // 2. Task Scoring with Ambition Penalty
  let taskS = 0.3; // default if no tasks planned
  if (dayTasks.length > 0) {
    const weights = { high: 5, medium: 3, low: 1 };
    let totalWeight = 0;
    let earnedWeight = 0;
    dayTasks.forEach(t => {
      const w = weights[t.priority] || 3;
      totalWeight += w;
      const subs = t.subtasks || [];
      if (subs.length > 0) {
        const doneSubs = subs.filter(s => s.done).length;
        earnedWeight += (doneSubs / subs.length) * w;
      } else {
        earnedWeight += (t.done ? 1 : 0) * w;
      }
    });

    const baseTaskScore = totalWeight === 0 ? 0.3 : (earnedWeight / totalWeight);
    let ambitionMultiplier = 1.0;
    if (totalWeight < 5) {
      ambitionMultiplier = 0.5;
    } else if (totalWeight > 15) {
      ambitionMultiplier = 1.1;
    }
    taskS = baseTaskScore * ambitionMultiplier;
  }

  // 3. Sleep Scoring with Sweet-Spot + Penalties
  const sleepS = calcSleepScore(sleepMins);

  // 4. Habit Scoring with Streak Multiplier
  let habitS = 0.4; // default if no habits exist
  if (habits.length > 0) {
    const baseHabitS = checkedHabits.length / habits.length;
    let avgMultiplier = 1.0;
    if (checkedHabits.length > 0) {
      let sumMultiplier = 0;
      checkedHabits.forEach(h => {
        const streak = calcStreakForDate(h, d);
        let mult = 1.0;
        if (streak >= 15) mult = 1.3;
        else if (streak >= 8) mult = 1.2;
        else if (streak >= 3) mult = 1.1;
        sumMultiplier += mult;
      });
      avgMultiplier = sumMultiplier / checkedHabits.length;
    }
    habitS = Math.min(1.0, baseHabitS * avgMultiplier);
  }

  // 5. Study Sessions Scoring
  const studyS = studyMins === 0 ? 0.5 : Math.min(1.0, studyMins / 90);

  // 6. Water Intake Scoring
  const waterS = waterMl === 0 ? 0.3 : Math.min(1.0, waterMl / 3500);

  // 7. Weekly Context Adjustment
  const dayOfWeek = new Date(d + 'T12:00:00').getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  const wTasks  = isWeekend ? 10 : 30;
  const wSleep  = isWeekend ? 35 : 25;
  const wHabits = isWeekend ? 30 : 20;
  const wStudy  = 15;
  const wWater  = 10;

  // 8. Aggregation
  let rawScore = (taskS * wTasks) + (sleepS * wSleep) + (habitS * wHabits) + (studyS * wStudy) + (waterS * wWater);

  // Severe dehydration penalty
  if (waterMl < 1500) {
    rawScore *= 0.7;
  }

  // Study bonus
  if (studyMins > 120) {
    rawScore += 5;
  }

  return Math.max(10, Math.min(100, Math.round(rawScore)));
}
function calcScore(){
  return calcScoreForDate(today());
}

function updateScore(){
  const s=calcScore();
  const el=$('score-val'); if(el) el.textContent=s;
  const arc=$('score-mini-arc');
  if(arc){ const c=2*Math.PI*11; arc.setAttribute('stroke-dashoffset',c*(1-s/100)); }
  if(s===100) triggerConfetti();
}

function areIntentionsEqual(a, b) {
  const normA = a || '';
  const normB = b || '';
  if (normA === normB) return true;
  if (typeof normA === 'object' && typeof normB === 'object') {
    if (normA._enc && normB._enc) {
      return normA.iv === normB.iv && normA.data === normB.data;
    }
  }
  return false;
}

 OutlineTasks.install(S, { today, uid, auth: Auth });
 OutlineWealth.install(S, {
   auth: Auth,
   categories: getDefaultWealthCategories,
   accountTypes: WEALTH_ACCOUNT_TYPES,
   currencies: WEALTH_CURRENCIES,
   transactionTypes: WEALTH_TRANSACTION_TYPES,
   text: isValidWealthText,
   number: toWealthNumber,
   date: isValidWealthDate
 });

 function compileDailySummaries() {
  const summaries = S.g('pvp_daily_summaries') || {};
  const datesSet = new Set();
  
  const taskList = S.tasks();
  taskList.forEach(t => { if (t.date) datesSet.add(t.date); });
  
  const waterMap = S.waterMap();
  Object.keys(waterMap).forEach(d => datesSet.add(d));
  
  const sleepMap = S.sleepMap();
  Object.keys(sleepMap).forEach(d => datesSet.add(d));
  
  const sessions = S.sessions();
  sessions.forEach(s => { if (s.date) datesSet.add(s.date); });
  
  const intentions = S.intentions();
  Object.keys(intentions).forEach(d => datesSet.add(d));
  
  const habits = S.habits();
  habits.forEach(h => {
    (h.logs || []).forEach(d => datesSet.add(d));
  });

  let changed = false;
  datesSet.forEach(d => {
    const dayTasks = taskList.filter(t => t.date === d);
    const totalTasks = dayTasks.length;
    const completedTasks = dayTasks.filter(t => t.done).length;
    
    const waterMl = waterMap[d] || 0;
    const sleepMins = sleepMap[d]?.mins || 0;
    const studyMins = sessions.filter(s => s.date === d).reduce((sum, s) => sum + s.mins, 0);
    const habitsCompleted = habits.filter(h => h.logs.includes(d)).length;
    const habitsTotal = habits.length;
    const score = calcScoreForDate(d);
    const intention = intentions[d] || '';

    const existing = summaries[d];
    if (!existing ||
        existing.daily_score !== score ||
        existing.tasks_total !== totalTasks ||
        existing.tasks_completed !== completedTasks ||
        existing.water_ml !== waterMl ||
        existing.sleep_minutes !== sleepMins ||
        existing.study_minutes !== studyMins ||
        existing.habits_completed !== habitsCompleted ||
        existing.habits_total !== habitsTotal ||
        !areIntentionsEqual(existing.intention, intention)) {
      
      summaries[d] = {
        date: d,
        daily_score: score,
        tasks_total: totalTasks,
        tasks_completed: completedTasks,
        water_ml: waterMl,
        sleep_minutes: sleepMins,
        study_minutes: studyMins,
        habits_completed: habitsCompleted,
        habits_total: habitsTotal,
        intention: intention
      };
      changed = true;
    }
  });

  if (changed) {
    S.sSilent('pvp_daily_summaries', summaries);
  }
}

/* ================================================================
   CONFETTI
   ================================================================ */
let confettiF=false;
function triggerConfetti(){
  if(confettiF) return; confettiF=true;
  const col=['#6366f1','#f472b6','#38bdf8','#fb923c','#fbbf24','#34d399'];
  for(let i=0;i<55;i++){
    const el=document.createElement('div');
    el.className='confetti-piece';
    el.style.cssText=`left:${Math.random()*100}vw;top:-10px;background:${col[i%col.length]};
      animation-duration:${1.2+Math.random()*1.6}s;animation-delay:${Math.random()*0.6}s;
      width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;
      border-radius:${Math.random()>0.5?'50%':'3px'};`;
    document.body.appendChild(el);
    el.addEventListener('animationend',()=>el.remove());
  }
  setTimeout(()=>confettiF=false,8000);
}

/* ================================================================
   RING COMPONENT
   ================================================================ */
function ring({size=80,sw=9,pct=0,color='#ffffff',val='',unit=''}){
  const r=(size-sw)/2,c=2*Math.PI*r,off=c*(1-clamp(pct,0,1));
  const fSize=size<70?size*0.22:size*0.21;
  return `<div class="ring-wrap" style="width:${size}px;height:${size}px;">
    <svg class="ring-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="ring-track" cx="${size/2}" cy="${size/2}" r="${r}" stroke="rgba(255,255,255,0.04)" stroke-width="${sw}"/>
      <circle class="ring-fill" cx="${size/2}" cy="${size/2}" r="${r}" stroke="${color}"
        stroke-width="${sw}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
        style="filter:drop-shadow(0 0 3px rgba(255,255,255,0.1));transition:stroke-dashoffset 0.6s ease"/>
    </svg>
    <div class="ring-inner">
      <div class="ring-val" style="font-size:${fSize}px;color:var(--text-primary);">${val}</div>
      ${unit?`<div class="ring-unit">${unit}</div>`:''}
    </div>
  </div>`;
}

/* ================================================================
   CHART FACTORY
   ================================================================ */
const chartI={};
function chartNode(name, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text) node.textContent = text;
  return node;
}

function showStorageDiagnostics() {
  const keys = ['pvp_tasks','pvp_habits','pvp_water','pvp_sessions','pvp_sleep','pvp_wealth','pvp_projects','pvp_journal','pvp_ideas'];
  const bytes = keys.reduce((total, key) => total + (localStorage.getItem(key)?.length || 0), 0);
  showToast(`${DM.fallback ? 'Browser storage' : 'File storage'} · ${keys.filter(key => localStorage.getItem(key) !== null).length}/${keys.length} stores · ${(bytes / 1024).toFixed(1)} KB`, 'info');
}

function resetOutlineData() {
  if (!confirm('Delete all Outline data from this browser? Export a backup first if you may need it.')) return;
  const keys = ['pvp_tasks','pvp_habits','pvp_water','pvp_sessions','pvp_active','pvp_sleep','pvp_intentions','pvp_daily_summaries','pvp_wealth','pvp_projects','pvp_journal','pvp_ideas','pvp_enc_salt','pvp_enc_verify','pvp_private_vault','pvp_fallback_backup','pvp_fallback_backup_previous'];
  keys.forEach(key => localStorage.removeItem(key));
  S.clearCache();
  Auth.lock();
  showToast('Outline data reset', 'success');
  renderView('dashboard');
  setTimeout(() => document.querySelector('[data-view="dashboard"]')?.focus(), 0);
}

async function importFallbackBackup(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) throw new Error('Invalid backup file');
    Object.entries(parsed.values).forEach(([key, value]) => {
      if (/^pvp_[a-z0-9_]+$/i.test(key) && typeof value === 'string') localStorage.setItem(key, value);
    });
    S.clearCache();
    DM.fallback = true;
    showToast('Browser backup imported', 'success');
    await renderView(curView);
  } catch (error) {
    console.error('Browser backup import failed:', error);
    showToast('Could not import that backup', 'error');
  } finally {
    event.target.value = '';
  }
}

async function doRotatePassword() {
  const first = $('settings-new-password')?.value || '';
  const second = $('settings-confirm-password')?.value || '';
  const error = $('settings-password-error');
  if (first.length < 6 || first !== second) {
    if (error) error.textContent = first.length < 6 ? 'Password must be at least 6 characters.' : 'Passwords do not match.';
    return;
  }
  if (!await Auth.rotatePassword(first)) {
    if (error) error.textContent = 'Unlock Outline before changing the password.';
    return;
  }
  if (error) error.textContent = '';
  $('settings-new-password').value = ''; $('settings-confirm-password').value = '';
  showToast('Password changed and vault re-encrypted', 'success');
}

async function doSetInitialPassword() {
  const first = $('settings-first-password')?.value || '';
  const second = $('settings-confirm-first-password')?.value || '';
  const error = $('settings-password-error');
  if (first.length < 6 || first !== second) {
    if (error) error.textContent = first.length < 6 ? 'Password must be at least 6 characters.' : 'Passwords do not match.';
    return;
  }
  await Auth.setPassword(first, S.g('pvp_journal') || {}, S.g('pvp_ideas') || []);
  if (error) error.textContent = '';
  showToast('Vault encryption enabled', 'success');
  renderView('settings');
}

function showBackupPreview(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const values = data.values || data;
      const size = new Blob([reader.result]).size;
      const preview = document.createElement('div');
      preview.className = 'backup-preview'; preview.setAttribute('role', 'dialog'); preview.setAttribute('aria-modal', 'true');
      preview.innerHTML = `<div class="backup-preview-card"><h2>Review backup</h2><p>Schema: ${escH(data.schemaVersion ?? 'unknown')}</p><p>Saved: ${escH(data.savedAt || data.exportedAt || 'unknown')}</p><p>Storage: ${data.values ? 'Browser storage' : 'Full Outline backup'} · ${(size / 1024).toFixed(1)} KB</p><p>Stores: ${Object.keys(values || {}).length}</p><div class="backup-preview-actions"><button class="btn btn-ghost" type="button" onclick="this.closest('.backup-preview').remove()">Cancel</button><button class="btn btn-primary" type="button" onclick="applyImportedBackup(window.__outlinePendingBackup);this.closest('.backup-preview').remove()">Restore backup</button></div></div>`;
      window.__outlinePendingBackup = data;
      document.body.appendChild(preview);
      preview.querySelector('button.btn-primary')?.focus();
    } catch { showToast('Could not read that backup file', 'error'); }
  };
  reader.readAsText(file);
}

async function applyImportedBackup(data) {
  try {
    if (data.values) {
      Object.entries(data.values).forEach(([key, value]) => { if (/^pvp_[a-z0-9_]+$/i.test(key) && typeof value === 'string') localStorage.setItem(key, value); });
    } else {
      await DM.applyToStore(data);
      if (data.journal !== undefined) localStorage.setItem('pvp_journal', JSON.stringify(data.journal));
      if (!DM.fallback) await DM._doSave();
    }
    S.clearCache(); DM.fallback = !!data.values; await renderView(curView); showToast('Backup restored', 'success');
  } catch (error) { console.error('Backup restore failed:', error); showToast('Could not restore backup', 'error'); }
}

let settingsTab = 'storage';
function setSettingsTab(tab) { settingsTab = tab; renderView('settings'); }

function vSettings() {
  const encrypted = Auth.hasPassword();
  const encryptionState = encrypted ? (Auth.isUnlocked() ? 'Unlocked · encrypted' : 'Locked · encrypted') : 'Unencrypted';
  const history = recoveryHistory();
  const checklist = localStorage.getItem('pvp_privacy_checklist_done') !== '1';
  const tabs = `<div class="settings-tabs" role="tablist"><button class="settings-tab ${settingsTab === 'storage' ? 'active' : ''}" role="tab" onclick="setSettingsTab('storage')">Storage</button><button class="settings-tab ${settingsTab === 'security' ? 'active' : ''}" role="tab" onclick="setSettingsTab('security')">Security</button><button class="settings-tab ${settingsTab === 'recovery' ? 'active' : ''}" role="tab" onclick="setSettingsTab('recovery')">Recovery</button></div>`;
  let dataStatusWidget = '';
  if (DM.currentStatus) {
    let dc = 'disconnected';
    const st = DM.currentStatus.state;
    if (st==='connected'||st==='browser') dc='connected';
    else if (st==='saving') dc='saving';
    dataStatusWidget = `<div class="data-status" style="margin-top:20px;padding-top:12px;border-top:1px solid var(--border-subtle);cursor:pointer;" id="data-status-badge" data-action="data-status" title="Click to retry saving or change data folder"><div class="data-dot ${dc}" id="data-dot"></div><div><div class="data-status-txt" id="data-status-txt">${escH(DM.currentStatus.txt)}</div><div class="data-status-sub" id="data-status-sub">${escH(DM.currentStatus.sub)}</div></div></div>`;
  }
  const storage = `<section class="card settings-card"><div class="sec-label">Storage</div><h2>${DM.fallback ? 'Browser storage' : 'File storage'}</h2><p class="settings-help">${DM.fallback ? 'Data is stored in this browser. Export backups regularly.' : `Data is stored in ${escH(DM.dirHandle?.name || 'your selected folder')}.`}</p><div class="settings-actions"><button class="btn btn-primary" type="button" onclick="DM.exportCurrentData()">Download full backup</button><button class="btn btn-ghost" type="button" onclick="$('settings-import-input').click()">Restore backup</button><input id="settings-import-input" type="file" accept="application/json" hidden onchange="showBackupPreview(this.files[0])"></div><button class="btn btn-ghost" type="button" onclick="showStorageDiagnostics()">Run storage diagnostics</button>${dataStatusWidget}</section>`;
  const security = `<section class="card settings-card"><div class="sec-label">Encryption status</div><h2>${encryptionState}</h2><p class="settings-help">${encrypted ? 'Your personal data is encrypted locally. Keep your password safe; it cannot be recovered.' : 'Set a password to encrypt personal data and require unlock access.'}</p>${encrypted ? `<input id="settings-new-password" class="input" type="password" placeholder="New password" autocomplete="new-password"><input id="settings-confirm-password" class="input" type="password" placeholder="Confirm new password" autocomplete="new-password"><button class="btn btn-primary" type="button" onclick="doRotatePassword()">Change password</button><div id="settings-password-error" class="settings-error" role="alert"></div>` : `<input id="settings-first-password" class="input" type="password" placeholder="Create password" autocomplete="new-password"><input id="settings-confirm-first-password" class="input" type="password" placeholder="Confirm password" autocomplete="new-password"><button class="btn btn-primary" type="button" onclick="doSetInitialPassword()">Enable encryption</button><div id="settings-password-error" class="settings-error" role="alert"></div>`}</section>${checklist ? `<section class="card settings-card checklist-card"><div class="sec-label">First-run privacy checklist</div><label><input type="checkbox"> I understand Outline stores data locally.</label><label><input type="checkbox"> I will export backups before resetting or changing browsers.</label><label><input type="checkbox"> I understand forgotten encryption passwords cannot be recovered.</label><button class="btn btn-primary" type="button" onclick="completePrivacyChecklist()">I understand</button></section>` : ''}`;
  const recovery = `<section class="card settings-card recovery-card"><div class="sec-label">Recovery history</div>${history.length ? `<ul>${history.map(item => `<li><strong>${escH(item.type)}</strong> — ${escH(item.message)}<span>${escH(new Date(item.at).toLocaleString())}</span></li>`).join('')}</ul>` : '<p class="settings-help">No backups or migrations have been restored yet.</p>'}</section><section class="card settings-card danger-zone"><div class="sec-label">Danger zone</div><p class="settings-help">Reset removes Outline data from this browser. Export a backup first.</p><button class="btn btn-ghost" type="button" onclick="resetOutlineData()">Reset browser data</button></section>`;
  return `<div class="view-enter"><div class="page-header"><h1 class="page-title">Settings &amp; Data</h1><p class="page-sub">Control storage, encryption, backups, and recovery.</p></div>${tabs}<div class="settings-grid">${settingsTab === 'storage' ? storage : settingsTab === 'security' ? security : recovery}</div></div>`;
}

function makeSvgChart(id, labels, data, type, unit = '') {
  const old = chartI[id];
  if (old) old.remove();
  const target = $(id);
  if (!target || !document.createElementNS) return;

  const width = 600, height = 220, left = 34, right = 8, top = 12, bottom = 28;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const values = data.map(value => Number(value) || 0);
  const max = Math.max(...values, 1);
  const svg = chartNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: 'offline-chart',
    role: 'img',
    'aria-label': `${type === 'line' ? 'Line' : 'Bar'} chart`
  });

  [0, 0.5, 1].forEach(level => {
    const y = top + plotHeight * (1 - level);
    svg.appendChild(chartNode('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: 'rgba(255,255,255,0.08)' }));
    svg.appendChild(chartNode('text', { x: left - 6, y: y + 3, 'text-anchor': 'end', fill: '#71717a', 'font-size': 10 }, `${(max * level).toFixed(1)}${unit}`));
  });

  const xFor = index => labels.length <= 1 ? left + plotWidth / 2 : left + (plotWidth * index / (labels.length - 1));
  if (type === 'line') {
    const points = values.map((value, index) => `${xFor(index)},${top + plotHeight * (1 - value / max)}`).join(' ');
    svg.appendChild(chartNode('polyline', { points, fill: 'rgba(255,255,255,0.04)', stroke: '#e4e4e7', 'stroke-width': 2 }));
  } else {
    const slot = plotWidth / Math.max(labels.length, 1);
    const barWidth = Math.max(4, slot * 0.58);
    values.forEach((value, index) => {
      const barHeight = plotHeight * value / max;
      svg.appendChild(chartNode('rect', { x: left + slot * index + (slot - barWidth) / 2, y: top + plotHeight - barHeight, width: barWidth, height: barHeight, rx: 4, fill: 'rgba(255,255,255,0.16)', stroke: '#e4e4e7' }));
    });
  }

  labels.forEach((label, index) => {
    if (labels.length > 10 && index % Math.ceil(labels.length / 10) !== 0) return;
    svg.appendChild(chartNode('text', { x: type === 'line' ? xFor(index) : left + (plotWidth / Math.max(labels.length, 1)) * (index + 0.5), y: height - 8, 'text-anchor': 'middle', fill: '#71717a', 'font-size': 10 }, String(label)));
  });
  target.replaceWith(svg);
  chartI[id] = svg;
}

function makeChart(id, labels, data, color, unit = '') { makeSvgChart(id, labels, data, 'bar', unit); }
function makeLineChart(id, labels, data, unit = '') { makeSvgChart(id, labels, data, 'line', unit); }

/* ================================================================
   WATER BOTTLE SVG
   ================================================================ */
function bottleSVG(pct){
  const p=clamp(pct,0,1),fillH=Math.round(152*p),fillY=200-fillH;
  return `<svg class="water-bottle" viewBox="0 0 90 220" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="bcl"><path d="M32 28 Q27 38 23 52 L18 178 Q18 200 45 200 Q72 200 72 178 L67 52 Q63 38 58 28 Z"/></clipPath>
      <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#d4d4d8" stop-opacity="0.95"/>
      </linearGradient>
    </defs>
    <rect x="35" y="18" width="20" height="13" rx="4" fill="var(--bg-elevated)" stroke="var(--border-default)" stroke-width="1"/>
    <path d="M32 28 Q27 38 23 52 L18 178 Q18 200 45 200 Q72 200 72 178 L67 52 Q63 38 58 28 Z"
      fill="var(--bg-card)" stroke="var(--border-default)" stroke-width="1.5"/>
    <rect x="0" y="${fillY}" width="90" height="${fillH+10}" fill="url(#wg)" clip-path="url(#bcl)"/>
    <line x1="28" y1="58" x2="25" y2="178" stroke="rgba(255,255,255,0.05)" stroke-width="5" stroke-linecap="round"/>
    <text x="45" y="${Math.max(fillY+22,150)}" text-anchor="middle" font-size="11" font-weight="700"
      fill="${p>0.15?'#000':'transparent'}" font-family="'JetBrains Mono',monospace">${Math.round(p*100)}%</text>
  </svg>`;
}

/* ================================================================
   VIEWS
   ================================================================ */
function greeting(){ const h=new Date().getHours(); return h<12?'morning':h<17?'afternoon':'evening'; }
async function doSaveIntention(val) {
  await S.setIntention(val);
  updateScore();
}
function fmtCurrency(val, currency = '₹') {
  const num = Number(val) || 0;
  return currency + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCurrencyCompact(val, currency = '₹') {
  const num = Number(val) || 0;
  if (Math.abs(num) >= 10000000) return currency + (num / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(num) >= 100000) return currency + (num / 100000).toFixed(2) + 'L';
  if (Math.abs(num) >= 1000) return currency + (num / 1000).toFixed(1) + 'K';
  return currency + num.toFixed(0);
}
function getCategoryEmoji(cat) {
  return '';
}

async function vDashboard(){
  const todayTasks=S.tasks().filter(t=>t.date===today());
  const doneTasks=todayTasks.filter(t=>t.done).length;
  const taskPct=todayTasks.length>0?doneTasks/todayTasks.length:0;
  const habits=S.habits();
  const doneH=habits.filter(h=>h.logs.includes(today())).length;
  const habitPct=habits.length>0?doneH/habits.length:0;
  const waterMl=S.waterToday(), waterPct=clamp(waterMl/3500,0,1);
  const studyMins=S.sessions().filter(s=>s.date===today()).reduce((s,x)=>s+x.mins,0);
  const sl=S.todaySleep(),slMins=sl?.mins||0;
  const score=calcScore();

  const wealthData = S.wealth();
  const netWorth = (wealthData.accounts || []).reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);
  const now = new Date();
  const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthExpenses = (wealthData.transactions || [])
    .filter(t => t.type === 'expense' && t.date && t.date.startsWith(curMonthStr))
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

  const thisStats = getStatsForDates(thisWeek());
  const lastStats = getStatsForDates(lastWeek());

  return `<div class="view-enter">
    <div class="page-header">
      <h1 class="page-title">Good ${greeting()} </h1>
      <p class="page-sub">Here's your life at a glance.</p>
    </div>

    <div class="intention-card">
      <div class="intention-label">TODAY'S INTENTION</div>
      <input type="text" id="intention-input" class="intention-input" placeholder="What is your one main focus for today?" value="${escH(await S.todayIntentionDecrypted())}" onchange="doSaveIntention(this.value)">
    </div>

    <div class="dash-grid">
      <div class="dash-card c1" onclick="navigate('tasks')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Tasks</div>
          <div class="dash-value">${doneTasks}<span style="font-family:inherit;font-size:16px;color:var(--text-muted);font-weight:500;">/${todayTasks.length}</span></div>
          <div class="dash-sub">${todayTasks.length===0?'No tasks yet':`${Math.round(taskPct*100)}% done`}</div>
        </div><div class="dash-icon"></div></div>
        <div class="pbar-wrap"><div class="pbar-fill" style="width:${taskPct*100}%;background:#ffffff;"></div></div>
      </div></div>

      <div class="dash-card c2" onclick="navigate('water')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Water</div>
          <div class="dash-value">${(waterMl/1000).toFixed(1)}<span style="font-family:inherit;font-size:14px;color:var(--text-muted);font-weight:500;">L</span></div>
          <div class="dash-sub">of 3.5L goal</div>
        </div><div class="dash-icon"></div></div>
        <div class="pbar-wrap"><div class="pbar-fill" style="width:${waterPct*100}%;background:#ffffff;"></div></div>
        <button class="water-tap-btn" onclick="event.stopPropagation();dashAddWater()" title="+250ml">+</button>
      </div></div>

      <div class="dash-card c3" onclick="navigate('habits')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Habits</div>
          <div class="dash-value">${doneH}<span style="font-family:inherit;font-size:16px;color:var(--text-muted);font-weight:500;">/${habits.length}</span></div>
          <div class="dash-sub">${Math.round(habitPct*100)}% today</div>
        </div><div class="dash-icon"></div></div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:2px;">
          ${habits.map(h=>`<div title="${escH(h.name)}" style="width:9px;height:9px;border-radius:2.5px;transition:0.2s;background:${h.logs.includes(today())?'#ffffff':'var(--border-default)'};"></div>`).join('')}
        </div>
      </div></div>

      <div class="dash-card c4" onclick="navigate('study')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Study</div>
          <div class="dash-value">${fmtDuration(studyMins)}</div>
          <div class="dash-sub">studied today</div>
        </div><div class="dash-icon"></div></div>
        ${S.activeSession()?`<div style="font-size:11px;color:var(--text-primary);background:var(--bg-elevated);border:1px solid var(--border-default);padding:3px 10px;border-radius:20px;display:inline-block;margin-top:4px;">● Session active</div>`:''}
      </div></div>

      <div class="dash-card c5" onclick="navigate('sleep')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Sleep</div>
          <div class="dash-value">${sl?fmtDuration(slMins):'—'}</div>
          <div class="dash-sub">${sl?`${sl.bed} → ${sl.wake}`:'Not logged yet'}</div>
        </div><div class="dash-icon"></div></div>
        ${sl?`<div style="display:flex;align-items:center;gap:7px;margin-top:4px;">
          <div style="flex:1;height:4px;background:var(--border-default);border-radius:2px;overflow:hidden;">
            <div style="width:${clamp(slMins/480*100,0,100)}%;height:100%;background:#ffffff;border-radius:2px;transition:0.6s;"></div>
          </div>
          <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted);">8h</span>
        </div>`:''}
      </div></div>

      <div class="dash-card c6" onclick="navigate('wealth')"><div class="dash-inner">
        <div class="dash-top"><div>
          <div class="dash-label">Wealth</div>
          <div class="dash-value">${fmtCurrencyCompact(netWorth)}</div>
          <div class="dash-sub">${thisMonthExpenses > 0 ? fmtCurrencyCompact(thisMonthExpenses) + ' spent this month' : 'Net Worth'}</div>
        </div><div class="dash-icon"></div></div>
        <div style="font-size:11px;color:var(--text-secondary);display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <span>${wealthData.accounts.length} Account${wealthData.accounts.length !== 1 ? 's' : ''}</span>
          <span style="color:var(--text-primary);font-weight:600;">Manage →</span>
        </div>
      </div></div>

      <div class="dash-card c7" style="cursor:default;"><div class="dash-inner" style="align-items:center;justify-content:center;">
        <div class="dash-label" style="position:absolute;top:18px;left:20px;">Daily Score</div>
        ${ring({size:96,sw:8,pct:score/100,color:'#ffffff',val:score,unit:'/100'})}
      </div></div>
    </div>

    <div style="margin-top: 28px;">
      <div class="sec-label">Weekly Review</div>
      <div class="weekly-card">
        <div class="weekly-header">
          <span class="weekly-title">Weekly Performance</span>
          <span class="weekly-subtitle">This week vs. Last week</span>
        </div>
        <div class="weekly-grid">
          <div class="weekly-col">
            <div class="weekly-metric-label">Daily Score</div>
            <div class="weekly-metric-val">${thisStats.scoreAvg}<span class="weekly-metric-unit">/100</span></div>
            <div class="weekly-metric-compare">${renderTrend(thisStats.scoreAvg, lastStats.scoreAvg)}</div>
          </div>
          <div class="weekly-col">
            <div class="weekly-metric-label">Habits Done</div>
            <div class="weekly-metric-val">${thisStats.habitPct}<span class="weekly-metric-unit">%</span></div>
            <div class="weekly-metric-compare">${renderTrend(thisStats.habitPct, lastStats.habitPct, '%')}</div>
          </div>
          <div class="weekly-col">
            <div class="weekly-metric-label">Study Time</div>
            <div class="weekly-metric-val">${fmtDurationShort(thisStats.studyTotal)}</div>
            <div class="weekly-metric-compare">${renderTrendStudy(thisStats.studyTotal, lastStats.studyTotal)}</div>
          </div>
          <div class="weekly-col">
            <div class="weekly-metric-label">Sleep Avg</div>
            <div class="weekly-metric-val">${thisStats.sleepAvg > 0 ? fmtDurationShort(thisStats.sleepAvg) : '—'}</div>
            <div class="weekly-metric-compare">${renderTrendSleep(thisStats.sleepAvg, lastStats.sleepAvg)}</div>
          </div>
          <div class="weekly-col">
            <div class="weekly-metric-label">Water Avg</div>
            <div class="weekly-metric-val">${(thisStats.waterAvg / 1000).toFixed(1)}<span class="weekly-metric-unit">L</span></div>
            <div class="weekly-metric-compare">${renderTrendWater(thisStats.waterAvg, lastStats.waterAvg)}</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function dashAddWater(){ S.addWater(250); updateScore(); refreshView(); }

/* ── TASKS ── */
let taskViewMode = 'today';

function setTaskViewMode(mode) {
  taskViewMode = mode === 'week' ? 'week' : 'today';
  renderView('tasks');
}

function taskViewModeButtons() {
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;">
    <button class="btn ${taskViewMode === 'today' ? 'btn-primary' : 'btn-ghost'}" style="padding:7px 11px;font-size:11.5px;" onclick="setTaskViewMode('today')">Today</button>
    <button class="btn ${taskViewMode === 'week' ? 'btn-primary' : 'btn-ghost'}" style="padding:7px 11px;font-size:11.5px;" onclick="setTaskViewMode('week')">This Week</button>
  </div>`;
}

async function vTasks(){
  if (taskViewMode === 'week') return vWeekTasks();
  const todayTasks=S.tasks().filter(t=>t.date===today());
  const done=todayTasks.filter(t=>t.done).length;
  const pct=todayTasks.length>0?Math.round(done/todayTasks.length*100):0;
  const taskItemsHTML = (await Promise.all(todayTasks.map(t => taskHTML(t)))).join('');
  return `<div class="view-enter">
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;"><div><h1 class="page-title">Tasks</h1><p class="page-sub">Today's focus list</p></div>${taskViewModeButtons()}</div>
    <div class="tasks-layout">
      <div>
        <div class="add-task-row">
          <input id="task-in" class="input" style="flex:1;" placeholder="What needs to get done?" maxlength="100" onkeydown="if(event.key==='Enter')doAddTask()">
          <select id="task-pri" class="input" style="width:auto;">
            <option value="high">High</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
          <button class="btn btn-primary" onclick="doAddTask()">+ Add</button>
        </div>
        <div class="task-list">
          ${todayTasks.length===0
            ?`<div class="empty"><div class="empty-txt">No tasks yet. Add something above.</div></div>`
            :taskItemsHTML}
        </div>
        ${todayTasks.length>0?`
          <div style="margin-top:20px;">
            <div class="pbar-labels"><span>${done}/${todayTasks.length} completed</span><span style="color:var(--tasks);font-weight:700;">${pct}%</span></div>
            <div class="pbar-wrap" style="height:7px;"><div class="pbar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--tasks),#fb7185);box-shadow:0 0 10px rgba(244,114,182,0.4);"></div></div>
          </div>`:''}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card" style="text-align:center;">
          <div class="sec-label">Completion</div>
          <div style="display:flex;justify-content:center;padding:12px 0;">${ring({size:96,sw:10,pct:pct/100,color:'var(--tasks)',val:pct+'%'})}</div>
        </div>
        <div class="card"><div class="sec-label">Priority</div>
          <div style="display:flex;flex-direction:column;gap:9px;margin-top:2px;">
            ${[['high','High'],['medium','Medium'],['low','Low']].map(([p,l])=>`
              <div style="display:flex;align-items:center;gap:9px;font-size:13px;">
                <span style="color:var(--text-secondary);">${l}</span>
                <span style="margin-left:auto;font-weight:700;color:var(--text-secondary);">${todayTasks.filter(t=>t.priority===p).length}</span>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ── PROJECTS ── */
async function vWeekTasks() {
  const week = thisWeek();
  const allTasks = S.tasks();
  const weekTasks = allTasks.filter(task => week.includes(task.date));
  const total = weekTasks.length;
  const done = weekTasks.filter(task => task.done).length;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  const dayCards = await Promise.all(week.map(async date => {
    const dayTasks = weekTasks.filter(task => task.date === date);
    const dayDone = dayTasks.filter(task => task.done).length;
    const dateObj = new Date(date + 'T12:00:00');
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const isToday = date === today();
    const items = (await Promise.all(dayTasks.map(task => taskHTML(task)))).join('');
    return `<section class="card week-day-card${isToday ? ' is-today' : ''}">
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;">
        <div><div style="font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;">${dayName}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${fmtDate(date)}${isToday ? ' · Today' : ''}</div></div>
        <span style="margin-left:auto;font-size:11px;color:${dayDone === dayTasks.length && dayTasks.length > 0 ? 'var(--success)' : 'var(--text-muted)'};font-weight:700;">${dayDone}/${dayTasks.length}</span>
      </div>
      <div class="week-day-tasks">${items || '<div class="week-empty">No tasks</div>'}</div>
    </section>`;
  }));

  return `<div class="view-enter">
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;"><div><h1 class="page-title">Tasks</h1><p class="page-sub">Your Monday–Sunday task overview</p></div>${taskViewModeButtons()}</div>
    <div class="add-task-row">
      <input id="task-in" class="input" style="flex:1;" placeholder="Add a task for today..." maxlength="100" onkeydown="if(event.key==='Enter')doAddTask()">
      <select id="task-pri" class="input" style="width:auto;"><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option></select>
      <button class="btn btn-primary" onclick="doAddTask()">+ Add</button>
    </div>
    <div class="card" style="margin-bottom:16px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
      <div style="font-size:12.5px;color:var(--text-secondary);">Week progress</div><div class="pbar-wrap" style="height:7px;flex:1;"><div class="pbar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--tasks),#fb7185);"></div></div><strong style="font-size:12px;color:var(--tasks);">${done}/${total} · ${pct}%</strong>
    </div>
    <div class="week-task-grid">${dayCards.join('')}</div>
  </div>`;
}

/* ── PROJECTS ── */
let projectViewMode = 'board';
const projectStatusLabels = { backlog: 'Backlog', todo: 'To Do', 'in-progress': 'In Progress', done: 'Done' };
function setProjectViewMode(mode) { projectViewMode = mode === 'list' ? 'list' : 'board'; refreshView(); }
function doSetProjectTaskStatus(projectId, taskId, status) { S.setProjectTaskStatus(projectId, taskId, status); refreshView(); }
async function vProjects() {
  const projects = await Promise.all(
    (S.projects() || [])
      .filter(project => project.status !== 'done')
      .map(async project => {
        const title = await Auth.decryptField(project.title, '[Locked Project]');
        const description = await Auth.decryptField(project.description, '');
        const tasks = await Promise.all((project.tasks || []).map(async task => ({
          ...task,
          decryptedTitle: await Auth.decryptField(task.title, '[Locked Task]')
        })));
        const completed = tasks.filter(task => task.done).length;
        return {
          ...project,
          decryptedTitle: title,
          decryptedDescription: description,
          tasks,
          completed,
          total: tasks.length
        };
      })
  );

  const boardTasks = await Promise.all(
    projects.flatMap(project => project.tasks.map(async task => ({
      ...task,
      projectId: project.id,
      projectTitle: project.decryptedTitle,
      decryptedSubtasks: await Promise.all((task.subtasks || []).map(async sub => ({
        ...sub,
        decryptedTitle: await Auth.decryptField(sub.title, '[Locked Subtask]')
      })))
    })))
  );
  const boardHTML = `<div class="project-board">
    ${Object.entries(projectStatusLabels).map(([status, label]) => {
      const columnTasks = boardTasks.filter(task => task.status === status);
      return `<section class="project-board-column" data-project-status="${status}">
        <div class="project-board-column-head"><span>${label}</span><strong>${columnTasks.length}</strong></div>
        <div class="project-board-items">
          ${columnTasks.length === 0 ? '<div class="project-board-empty">No tasks</div>' : columnTasks.map(task => {
            const subs = task.decryptedSubtasks || [];
            const doneSubs = subs.filter(s => s.done).length;
            const totalSubs = subs.length;
            const subsHTML = totalSubs > 0 ? `
              <div class="project-board-subtasks">
                <div class="project-board-subtasks-bar">
                  <div class="project-board-subtasks-fill" style="width:${Math.round((doneSubs/totalSubs)*100)}%"></div>
                </div>
                <span class="project-board-subtasks-count">${doneSubs}/${totalSubs} subtasks</span>
                <div class="project-board-subtasks-list">
                  ${subs.map(sub => `<label class="project-board-subtask-row${sub.done ? ' done' : ''}">
                    <div class="task-cb${sub.done ? ' checked' : ''}" style="width:14px;height:14px;font-size:8px;border-radius:3px;flex-shrink:0;" onclick="doToggleProjectSubtask(${eventArg(task.projectId)},${eventArg(task.id)},${eventArg(sub.id)})">${sub.done ? '&#10003;' : ''}</div>
                    <span>${escH(sub.decryptedTitle)}</span>
                  </label>`).join('')}
                </div>
              </div>` : '';
            return `<article class="project-board-task">
            <div class="project-board-task-project">${escH(task.projectTitle)}</div>
            <div class="project-board-task-title">${escH(task.decryptedTitle || '')}</div>
            <div class="project-board-task-meta">
              <span class="task-priority priority-${escH(task.priority || 'medium')}">${escH(task.priority || 'medium')}</span>
              <select class="project-status-select" onchange="doSetProjectTaskStatus(${eventArg(task.projectId)},${eventArg(task.id)},this.value)" aria-label="Change task status">
                ${Object.entries(projectStatusLabels).map(([value, text]) => `<option value="${value}"${value === status ? ' selected' : ''}>${text}</option>`).join('')}
              </select>
            </div>
            ${subsHTML}
          </article>`;
          }).join('')}
        </div>
      </section>`;
    }).join('')}
  </div>`;

  return `<div class="view-enter">
    <div class="page-header">
      <h1 class="page-title">Projects</h1>
      <p class="page-sub">Track only the projects you are actively working on right now.</p>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="sec-label">＋ New Project</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;align-items:center;">
        <input id="proj-title" class="input" type="text" placeholder="Project name" maxlength="120" onkeydown="if(event.key==='Enter')doAddProject()">
        <input id="proj-desc" class="input" type="text" placeholder="Short description (optional)" maxlength="200" onkeydown="if(event.key==='Enter')doAddProject()">
        <button class="btn btn-primary" style="height:38px;" onclick="doAddProject()">+ Add Project</button>
      </div>
    </div>

    <div class="project-toolbar">
      <div>
        <div class="sec-label" style="margin-bottom:3px;">Project workspace</div>
        <div class="project-toolbar-sub">Move personal work from backlog to done.</div>
      </div>
      <div class="project-view-toggle">
        <button class="btn ${projectViewMode === 'board' ? 'btn-primary' : 'btn-ghost'}" onclick="setProjectViewMode('board')">Board</button>
        <button class="btn ${projectViewMode === 'list' ? 'btn-primary' : 'btn-ghost'}" onclick="setProjectViewMode('list')">Projects</button>
      </div>
    </div>

    ${projectViewMode === 'board' ? boardHTML : projects.length === 0 ? `
      <div class="card">
        <div class="empty"><div class="empty-txt">No active projects yet. Add the first one above.</div></div>
      </div>
    ` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:16px;align-items:start;">
        ${await Promise.all(projects.map(async project => {
          const progress = project.total > 0 ? Math.round((project.completed / project.total) * 100) : 0;
          const taskItems = project.tasks.length > 0 ? (await Promise.all(project.tasks.map(task => projectTaskHTML(project.id, task)))).join('') : '';
          return `
            <div class="card" style="display:flex;flex-direction:column;gap:12px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                <div>
                  <div class="sec-label" style="margin-bottom:6px;">Current Project</div>
                  <h3 style="font-size:18px;font-weight:800;line-height:1.2;">${escH(project.decryptedTitle)}</h3>
                  ${project.decryptedDescription ? `<div style="margin-top:6px;font-size:13px;color:var(--text-secondary);line-height:1.5;">${escH(project.decryptedDescription)}</div>` : ''}
                </div>
                <button class="task-del" onclick="doCompleteProject(${eventArg(project.id)})" title="Mark project complete">✓</button>
              </div>
              <div>
                <div class="pbar-labels"><span>${project.completed}/${project.total} tasks done</span><span style="color:var(--tasks);font-weight:700;">${progress}%</span></div>
                <div class="pbar-wrap" style="height:7px;"><div class="pbar-fill" style="width:${progress}%;background:linear-gradient(90deg,var(--tasks),#fb7185);box-shadow:0 0 10px rgba(244,114,182,0.4);"></div></div>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px;">
                <div class="sec-label" style="margin-bottom:0;">Project Tasks</div>
                <div class="add-task-row" style="margin-bottom:2px;">
                  <input id="proj-task-in-${escH(project.id)}" class="input" style="flex:1;" placeholder="Add a project task" maxlength="100" onkeydown="if(event.key==='Enter')doAddProjectTask(${eventArg(project.id)})">
                  <select id="proj-task-pri-${escH(project.id)}" class="input" style="width:auto;">
                    <option value="high">High</option>
                    <option value="medium" selected>Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <button class="btn btn-primary" onclick="doAddProjectTask(${eventArg(project.id)})">+ Add</button>
                </div>
                <div class="task-list" data-project-id="${escH(project.id)}">
                  ${project.tasks.length === 0
                    ? `<div class="empty" style="padding:16px 0;"><div class="empty-txt">No project tasks yet.</div></div>`
                    : taskItems}
                </div>
              </div>
            </div>
          `;
        })).then(cards => cards.join(''))}
      </div>
    `}
  </div>`;
}

async function doAddProject() {
  const titleIn = $('proj-title');
  const descIn = $('proj-desc');
  const title = titleIn?.value?.trim();
  if (!title) return;

  await S.addProject({
    id: uid(),
    title,
    description: descIn?.value?.trim() || '',
    status: 'active',
    tasks: []
  });

  if (titleIn) titleIn.value = '';
  if (descIn) descIn.value = '';
  refreshView();
}

async function doAddProjectTask(projectId) {
  const inp = $(`proj-task-in-${projectId}`);
  const pri = $(`proj-task-pri-${projectId}`);
  const title = inp?.value?.trim();
  if (!title) return;

  await S.addProjectTask(projectId, title, pri?.value || 'medium');
  if (inp) inp.value = '';
  if (pri) pri.value = 'medium';
  refreshView();
}

function doToggleProjectTask(projectId, taskId) {
  S.toggleProjectTask(projectId, taskId);
  refreshView();
}

function doDelProjectTask(projectId, taskId) {
  S.delProjectTask(projectId, taskId);
  refreshView();
}

function doCompleteProject(projectId) {
  if (confirm('Mark this project as complete and remove it from active projects?')) {
    S.updateProject(projectId, { status: 'done' });
    refreshView();
  }
}

const activeProjectSubForms = {};

function toggleProjectSubForm(projectId, taskId) {
  const key = `${projectId}:${taskId}`;
  activeProjectSubForms[key] = !activeProjectSubForms[key];
  refreshView();
  if (activeProjectSubForms[key]) {
    setTimeout(() => $(`proj-subin-${projectId}-${taskId}`)?.focus(), 50);
  }
}

async function doAddProjectSubtask(projectId, taskId) {
  const inp = $(`proj-subin-${projectId}-${taskId}`);
  const title = inp?.value?.trim();
  if (!title) return;
  await S.addProjectSubtask(projectId, taskId, title);
  if (inp) inp.value = '';
  refreshView();
}

function doToggleProjectSubtask(projectId, taskId, subtaskId) {
  S.toggleProjectSubtask(projectId, taskId, subtaskId);
  refreshView();
}

function doDelProjectSubtask(projectId, taskId, subtaskId) {
  S.delProjectSubtask(projectId, taskId, subtaskId);
  refreshView();
}

function reorderProjectTasks(projectId, draggedTaskId, targetTaskId, after) {
  S.reorderProjectTasks(projectId, draggedTaskId, targetTaskId, after);
}

function reorderProjectSubtasks(projectId, parentTaskId, draggedSubId, targetSubId, after) {
  S.reorderProjectSubtasks(projectId, parentTaskId, draggedSubId, targetSubId, after);
}

async function projectTaskHTML(projectId, task) {
  var subtasks = task.subtasks || [];
  var doneSubs = subtasks.filter(function(subtask){ return subtask.done; }).length;
  var totalSubs = subtasks.length;
  var fractionText = totalSubs > 0 ? '<span class="task-fraction" style="font-size:11px;color:var(--text-secondary);font-weight:600;margin-left:5px;">(' + doneSubs + '/' + totalSubs + ')</span>' : '';
  var isFormOpen = activeProjectSubForms[`${projectId}:${task.id}`];
  const decryptedTitle = await Auth.decryptField(task.title, "[Locked Task]");
  var subItems = await Promise.all(subtasks.map(async function(subtask){
    const decSubTitle = await Auth.decryptField(subtask.title, "[Locked Subtask]");
    return '<div class="subtask-item ' + (subtask.done ? 'done' : '') + '" style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:12.5px;transition:var(--t);" id="proj-sti-' + escH(subtask.id) + '" draggable="true" data-type="project-subtask" data-project-id="' + escH(projectId) + '" data-parent-id="' + escH(task.id) + '" data-subtask-id="' + escH(subtask.id) + '">'
      + '<div class="task-cb ' + (subtask.done ? 'checked' : '') + '" style="width:16px;height:16px;font-size:9px;border-radius:3px;flex-shrink:0;" onclick="doToggleProjectSubtask(' + eventArg(projectId) + ',' + eventArg(task.id) + ',' + eventArg(subtask.id) + ')">' + (subtask.done ? '&#10003;' : '') + '</div>'
      + '<span class="task-title-txt" style="' + (subtask.done ? 'text-decoration:line-through;color:var(--text-muted);' : '') + ';flex:1;">' + escH(decSubTitle) + '</span>'
      + '<button class="task-del" style="font-size:11px;padding:1px 3px;background:none;border:none;color:var(--text-muted);cursor:pointer;transition:var(--t);" onmouseover="this.style.color=\'var(--danger)\'" onmouseout="this.style.color=\'var(--text-muted)\'" onclick="doDelProjectSubtask(' + eventArg(projectId) + ',' + eventArg(task.id) + ',' + eventArg(subtask.id) + ')">&#10005;</button>'
      + '</div>';
  }));
  var subtasksHTML = totalSubs > 0
    ? '<div class="subtasks-list" data-project-id="' + escH(projectId) + '" data-parent-id="' + escH(task.id) + '" style="margin-left:36px;padding-left:10px;border-left:1px dashed var(--border-default);display:flex;flex-direction:column;gap:5px;margin-top:5px;margin-bottom:8px;">' + subItems.join('') + '</div>'
    : '';
  var addForm = '<div class="add-subtask-form-container ' + (isFormOpen ? '' : 'hidden') + '" id="proj-asf-' + escH(projectId) + '-' + escH(task.id) + '" style="margin-left:36px;margin-top:5px;margin-bottom:8px;"><div style="display:flex;gap:6px;"><input type="text" id="proj-subin-' + escH(projectId) + '-' + escH(task.id) + '" class="input" style="padding:6px 10px;font-size:12.5px;flex:1;" placeholder="Add subtask..." onkeydown="if(event.key===\'Enter\')doAddProjectSubtask(' + eventArg(projectId) + ',' + eventArg(task.id) + ')"><button class="btn btn-primary" style="padding:6px 12px;font-size:12px;" onclick="doAddProjectSubtask(' + eventArg(projectId) + ',' + eventArg(task.id) + ')">Add</button><button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="toggleProjectSubForm(' + eventArg(projectId) + ',' + eventArg(task.id) + ')">Cancel</button></div></div>';
  var inner = '<div class="task-item' + (task.done ? ' done' : '') + '" id="proj-ti-' + escH(projectId) + '-' + escH(task.id) + '">'
    + '<div class="task-cb' + (task.done ? ' checked' : '') + '" onclick="doToggleProjectTask(' + eventArg(projectId) + ',' + eventArg(task.id) + ')">' + (task.done ? '&#10003;' : '') + '</div>'
    + '<div class="task-dot dot-' + (task.priority || 'medium') + '"></div>'
    + '<span class="task-title-txt" style="flex:1;">' + escH(decryptedTitle) + fractionText + '</span>'
    + '<button class="add-subtask-btn" style="margin-right:4px;" onclick="toggleProjectSubForm(' + eventArg(projectId) + ',' + eventArg(task.id) + ')" title="Add subtask">+</button>'
    + '<button class="task-del" onclick="doDelProjectTask(' + eventArg(projectId) + ',' + eventArg(task.id) + ')">&#10005;</button>'
    + '</div>';
  return '<div class="task-container" id="proj-tc-' + escH(projectId) + '-' + escH(task.id) + '" draggable="true" data-type="project-task" data-project-id="' + escH(projectId) + '" data-task-id="' + escH(task.id) + '">' + inner + subtasksHTML + addForm + '</div>';
}

const activeSubForms = {};

function toggleAddSubForm(id) {
  activeSubForms[id] = !activeSubForms[id];
  refreshView();
  if (activeSubForms[id]) {
    setTimeout(() => $(`subin-${id}`)?.focus(), 50);
  }
}

async function doAddSubtask(parentId) {
  const inp = $(`subin-${parentId}`);
  const title = inp?.value?.trim();
  if (!title) return;
  await S.addSubtask(parentId, title);
  inp.value = '';
  refreshView();
  updateScore();
  $(`subin-${parentId}`)?.focus();
}

function doToggleSubtask(parentId, subtaskId) {
  S.toggleSubtask(parentId, subtaskId);
  refreshView();
  updateScore();
}

function doDelSubtask(parentId, subtaskId) {
  S.delSubtask(parentId, subtaskId);
  refreshView();
  updateScore();
}

async function taskHTML(t){
  var subtasks=t.subtasks||[];
  var doneSubs=subtasks.filter(function(s){return s.done;}).length;
  var totalSubs=subtasks.length;
  var fractionText=totalSubs>0?'<span class="task-fraction" style="font-size:11px;color:var(--text-secondary);font-weight:600;margin-left:5px;">('+(doneSubs)+'/('+(totalSubs)+')</span>':'' ;
  var isFormOpen=activeSubForms[t.id];
  const decryptedTitle = await Auth.decryptField(t.title, "[Locked Task]");
  var subItems=await Promise.all(subtasks.map(async function(s){
    const decSubTitle = await Auth.decryptField(s.title, "[Locked Subtask]");
    return '<div class="subtask-item '+(s.done?'done':'')+'" style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;font-size:12.5px;transition:var(--t);" id="sti-'+escH(s.id)+'" draggable="true" data-type="subtask" data-subtask-id="'+escH(s.id)+'" data-parent-id="'+escH(t.id)+'">'
      +'<div class="task-cb '+(s.done?'checked':'')+'" style="width:16px;height:16px;font-size:9px;border-radius:3px;flex-shrink:0;" onclick="doToggleSubtask('+eventArg(t.id)+','+eventArg(s.id)+')">'+( s.done?'&#10003;':'')+'</div>'
      +'<span class="task-title-txt" style="'+(s.done?'text-decoration:line-through;color:var(--text-muted);':'')+';flex:1;">'+escH(decSubTitle)+'</span>'
      +'<button class="task-del" style="font-size:11px;padding:1px 3px;background:none;border:none;color:var(--text-muted);cursor:pointer;transition:var(--t);" onmouseover="this.style.color=\'var(--danger)\'" onmouseout="this.style.color=\'var(--text-muted)\'" onclick="doDelSubtask('+eventArg(t.id)+','+eventArg(s.id)+')">&#10005;</button>'
      +'</div>';
  }));
  var subtasksHTML=totalSubs>0
    ?'<div class="subtasks-list" data-parent-id="'+escH(t.id)+'" style="margin-left:36px;padding-left:10px;border-left:1px dashed var(--border-default);display:flex;flex-direction:column;gap:5px;margin-top:5px;margin-bottom:8px;">'+subItems.join('')+'</div>'
    :'';
  var addForm='<div class="add-subtask-form-container '+(isFormOpen?'':'hidden')+'" id="asf-'+escH(t.id)+'" style="margin-left:36px;margin-top:5px;margin-bottom:8px;"><div style="display:flex;gap:6px;"><input type="text" id="subin-'+escH(t.id)+'" class="input" style="padding:6px 10px;font-size:12.5px;flex:1;" placeholder="Add subtask..." onkeydown="if(event.key===\'Enter\')doAddSubtask('+eventArg(t.id)+')"><button class="btn btn-primary" style="padding:6px 12px;font-size:12px;" onclick="doAddSubtask('+eventArg(t.id)+')">Add</button><button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="toggleAddSubForm('+eventArg(t.id)+')">Cancel</button></div></div>';
  var inner='<div class="task-item'+(t.done?' done':'')+'" id="ti-'+escH(t.id)+'">'
    +'<div class="task-cb'+(t.done?' checked':'')+'" onclick="doToggleTask('+eventArg(t.id)+')">'+( t.done?'&#10003;':'')+'</div>'
    +'<div class="task-dot dot-'+(t.priority||'medium')+'"></div>'
    +'<span class="task-title-txt" style="flex:1;">'+escH(decryptedTitle)+fractionText+'</span>'
    +'<button class="add-subtask-btn" style="margin-right:4px;" onclick="toggleAddSubForm('+eventArg(t.id)+')" title="Add subtask">+</button>'
    +'<button class="task-move" style="margin-right:4px;" onclick="doMoveTaskToNextDay('+eventArg(t.id)+')" title="Move to next day">Tomorrow</button>'
    +'<button class="task-del" onclick="doDelTask('+eventArg(t.id)+')">&#10005;</button>'
    +'</div>';
  return '<div class="task-container" id="tc-'+escH(t.id)+'" draggable="true" data-type="task" data-task-id="'+escH(t.id)+'">'+inner+subtasksHTML+addForm+'</div>';
}

async function doAddTask(){
  const inp=$('task-in'),pri=$('task-pri');
  const title=inp?.value?.trim(); if(!title) return;
  await S.addTask({id:uid(),title,priority:pri.value,done:false,date:today()});
  inp.value=''; refreshView(); updateScore();
}
function doToggleTask(id){ S.toggleTask(id); refreshView(); updateScore(); }
function doMoveTaskToNextDay(id){
  const task = S.tasks().find(item => item.id === id);
  if (!task) return;
  S.moveTaskToDate(id, addDays(task.date, 1));
  refreshView();
  updateScore();
}
function doDelTask(id){ S.delTask(id); refreshView(); updateScore(); }

function reorderTasks(draggedId, targetId, after) {
  const allTasks = S.tasks();
  const draggedTask = allTasks.find(t => t.id === draggedId);
  if (!draggedTask) return;

  const remaining = allTasks.filter(t => t.id !== draggedId);
  const targetIdx = remaining.findIndex(t => t.id === targetId);

  if (targetIdx !== -1) {
    const insertIdx = after ? targetIdx + 1 : targetIdx;
    remaining.splice(insertIdx, 0, draggedTask);
  } else {
    remaining.push(draggedTask);
  }

  S.s('pvp_tasks', remaining);
}

function reorderSubtasks(parentId, draggedSubId, targetSubId, after) {
  const allTasks = S.tasks();
  const parentTask = allTasks.find(t => t.id === parentId);
  if (!parentTask || !parentTask.subtasks) return;

  const subtasks = parentTask.subtasks;
  const draggedSub = subtasks.find(s => s.id === draggedSubId);
  if (!draggedSub) return;

  const remaining = subtasks.filter(s => s.id !== draggedSubId);
  const targetIdx = remaining.findIndex(s => s.id === targetSubId);

  if (targetIdx !== -1) {
    const insertIdx = after ? targetIdx + 1 : targetIdx;
    remaining.splice(insertIdx, 0, draggedSub);
  } else {
    remaining.push(draggedSub);
  }

  parentTask.subtasks = remaining;
  S.s('pvp_tasks', allTasks);
}

/* ── HABITS ── */
function vHabits(){
  const habits=S.habits(), week=thisWeek();
  const wL=['M','T','W','T','F','S','S'];
  const delBtnText = isDeleteHabitMode ? '✓ Done' : '️ Delete Habit';
  const delBtnStyle = isDeleteHabitMode 
    ? 'border-color:var(--danger);color:var(--danger);background:rgba(239,68,68,0.05);' 
    : 'color:var(--text-muted);';

  return `<div class="view-enter">
    <div class="page-header"><h1 class="page-title">Habits</h1><p class="page-sub">Build consistency, one day at a time.</p></div>
    <div class="card" style="margin-bottom:14px;padding:12px 18px;">
      <div style="display:flex;align-items:center;">
        <span style="flex:1;font-size:12px;color:var(--text-muted);font-weight:600;">THIS WEEK</span>
        <div style="display:flex;gap:4px;margin-right:58px;">
          ${wL.map((l,i)=>`<div style="width:9px;text-align:center;font-size:10px;font-weight:700;color:${week[i]===today()?'var(--text-primary)':'var(--text-muted)'};">${l}</div>`).join('')}
        </div>
      </div>
    </div>
    <div class="habits-list">${habits.map(h=>habitHTML(h,week)).join('')}</div>
    ${isAddHabitMode ? `
    <div class="card" style="margin-top:14px;display:flex;gap:8px;padding:12px;">
      <input type="text" id="new-habit-name" class="input" placeholder="New habit name..." style="flex:1;" onkeydown="newHabitKeyDown(event)">
      <button class="btn btn-primary" onclick="submitNewHabit()">Save</button>
      <button class="btn btn-ghost" onclick="toggleAddHabitMode()">Cancel</button>
    </div>
    ` : `
    <div style="display:flex;gap:12px;margin-top:14px;">
      <button class="add-habit-dashed" style="flex:1;width:auto;" onclick="toggleAddHabitMode()">+ Add Habit</button>
      <button class="add-habit-dashed" style="flex:1;width:auto;${delBtnStyle}" onclick="toggleDeleteHabitMode()">${delBtnText}</button>
    </div>
    `}
  </div>`;
}

function habitHTML(h,week){
  var done = h.logs.includes(today());
  var streak = S.streak(h);
  var streakTxt = streak > 0 ? ('' + streak + ' day streak') : '\u25cb No streak yet';
  var weekDots = week.map(function(d){
    var on = h.logs.includes(d);
    return '<div class="wd' + (on ? ' on' : '') + '" style="' + (on ? 'background:' + h.color + ';color:' + h.color + ';' : '') + '"></div>';
  }).join('');

  var rightAction = '';
  if (isDeleteHabitMode) {
    rightAction = '<button class="habit-check" onclick="doDelHabit(' + eventArg(h.id) + ')" style="border-color:var(--danger);color:var(--danger);background:rgba(239,68,68,0.1);font-weight:bold;cursor:pointer;">&#10005;</button>';
  } else {
    var safeColor = escH(h.color);
    var checkStyle = done ? 'background:' + safeColor + ';border-color:' + safeColor + ';box-shadow:0 0 14px ' + safeColor + '55;' : '';
    rightAction = '<button class="habit-check' + (done ? ' done' : '') + '" onclick="doToggleHabit(' + eventArg(h.id) + ')" style="' + checkStyle + '">'
      + (done ? '&#10003;' : '&#9675;')
      + '</button>';
  }

  return '<div class="habit-row">'
    + '<div class="habit-icon-wrap" style="background:' + escH(h.color) + '22;">' + escH(h.icon) + '</div>'
    + '<div class="habit-info">'
      + '<div class="habit-name-txt">' + escH(h.name) + '</div>'
      + '<div class="habit-streak-txt">' + streakTxt + '</div>'
    + '</div>'
    + '<div class="habit-week-dots">' + weekDots + '</div>'
    + rightAction
    + '</div>';
}

function doToggleHabit(id){ S.toggleHabit(id); refreshView(); updateScore(); }
function toggleDeleteHabitMode(){ isDeleteHabitMode = !isDeleteHabitMode; isAddHabitMode = false; refreshView(); }
function toggleAddHabitMode(){ isAddHabitMode = !isAddHabitMode; isDeleteHabitMode = false; refreshView(); if(isAddHabitMode) setTimeout(()=>$('new-habit-name')?.focus(), 50); }
function doDelHabit(id){
  if(!confirm('Delete this habit? All its history will be lost.')) return;
  S.saveHabits(S.habits().filter(function(h){ return h.id !== id; }));
  refreshView(); updateScore();
}
function newHabitKeyDown(e) {
  if (e.key === 'Enter') submitNewHabit();
  if (e.key === 'Escape') toggleAddHabitMode();
}
function submitNewHabit(){
  const name = $('new-habit-name')?.value;
  if (!name?.trim()) { toggleAddHabitMode(); return; }
  const cols=['#fb923c','#f472b6','#a78bfa','#34d399','#38bdf8','#fbbf24'];
  const h=S.habits();
  h.push({id:uid(),name:name.trim(),icon:'',color:cols[h.length%cols.length],logs:[],isDefault:false});
  S.saveHabits(h); 
  isAddHabitMode = false;
  refreshView();
}

/* ── WATER ── */
function vWater(){
  const ml=S.waterToday(),goal=3500,pct=clamp(ml/goal,0,1);
  const l7=last7(),wMap=S.waterMap();
  const avg7=l7.reduce((s,d)=>s+(wMap[d]||0),0)/7;
  const best=Math.max(...l7.map(d=>wMap[d]||0));
  return `<div class="view-enter">
    <div class="page-header"><h1 class="page-title">Water Tracker</h1><p class="page-sub">Stay hydrated. Goal: 3.5L per day.</p></div>
    <div class="water-layout">
      <div class="card"><div class="water-main-card">
        ${bottleSVG(pct)}
        <div style="text-align:center;">
          <div class="water-big-num">${(ml/1000).toFixed(2)}</div>
          <div class="water-big-unit">Litres</div>
          <div class="water-goal-note">${ml>=goal?' Goal reached!':((goal-ml)/1000).toFixed(2)+'L remaining'}</div>
        </div>
        ${ring({size:84,sw:9,pct,color:'var(--water)',val:Math.round(pct*100)+'%',unit:'of goal'})}
        <button class="water-tap" onclick="doAddWater()"></button>
        <div class="water-tap-label">+250ml per tap</div>
        <div class="water-actions">
          <button class="water-btn-sm water-btn-remove" onclick="doRemoveWater()">−250ml</button>
          <button class="water-btn-sm water-btn-custom" onclick="doCustomWater()">Custom +</button>
          <button class="water-btn-sm water-btn-remove" onclick="doCustomRemoveWater()">Custom −</button>
          <button class="water-btn-sm water-btn-reset" onclick="doResetWater()">Reset today</button>
        </div>
      </div></div>
      <div class="card">
        <div class="sec-label">Last 7 Days</div>
        <div class="chart-box" style="height:200px;"><canvas id="water-chart"></canvas></div>
        <div class="stats-row">
          <div class="stat-box"><div class="stat-box-label">7-Day Avg</div><div class="stat-box-value" style="color:var(--water);">${(avg7/1000).toFixed(1)}L</div></div>
          <div class="stat-box"><div class="stat-box-label">Best Day</div><div class="stat-box-value" style="color:var(--water);">${(best/1000).toFixed(1)}L</div></div>
        </div>
      </div>
    </div>
  </div>`;
}
function doAddWater(){ S.addWater(250); updateScore(); refreshView(); }
function doRemoveWater(){ S.removeWater(250); updateScore(); refreshView(); }
function doCustomRemoveWater(){ const v=parseInt(prompt('Remove how many ml?')); if(!isNaN(v)&&v>0){ S.removeWater(v); updateScore(); refreshView(); } }
function doResetWater(){ if(confirm('Reset today\'s water?')){ S.resetWater(); updateScore(); refreshView(); } }
function doCustomWater(){ const v=parseInt(prompt('Amount in ml:')); if(!isNaN(v)&&v>0){ S.addWater(v); updateScore(); refreshView(); } }

/* ── STUDY ── */
let timerIv=null;
function vStudy(){
  const totalMins=S.todayStudyMins(),active=S.activeSession();
  const l7=last7(),ss=S.sessions();
  const avg7m=Math.round(l7.reduce((sum,d)=>sum+ss.filter(x=>x.date===d).reduce((s,x)=>s+x.mins,0),0)/7);
  return `<div class="view-enter">
    <div class="page-header"><h1 class="page-title">Study Tracker</h1><p class="page-sub">Track your focus sessions.</p></div>
    <div class="study-layout">

      <div class="card"><div class="study-timer-card">
        <div class="cd-label">STOPWATCH</div>
        <div class="timer-status-badge ${active?'status-active':'status-idle'}">${active?'● Recording':'○ Idle'}</div>
        <div class="timer-clock" id="timer-disp">00:00:00</div>
        <button class="timer-btn ${active?'timer-stop':'timer-start'}" onclick="doToggleTimer()">${active?'⏹ Stop Session':'▶ Start Session'}</button>
        <div class="study-today-box">
          <div class="study-today-label">Today's total</div>
          <div class="study-today-val">${fmtDuration(totalMins)}</div>
        </div>
      </div></div>

      <div class="card"><div class="countdown-card">
        <div class="cd-label" id="cd-status">${cdState.running ? (cdState.remaining<=0?"TIME'S UP!":'COUNTING DOWN') : 'FOCUS COUNTDOWN'}</div>
        <div style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:130px;height:130px;">
          <svg width="130" height="130" style="position:absolute;transform:rotate(-90deg);">
            <circle class="cd-ring-track" cx="65" cy="65" r="58" stroke-width="4"/>
            <circle class="cd-ring-fill" id="cd-arc" cx="65" cy="65" r="58" stroke-width="4"
              stroke-dasharray="${2*Math.PI*58}" stroke-dashoffset="0"/>
          </svg>
          <div class="cd-clock${cdState.running && cdState.remaining<=0 ? ' done' : ''}" id="cd-disp">${fmtCD(cdState.running ? cdState.remaining : cdState.duration)}</div>
        </div>
        <div class="cd-presets">
          ${[15,25,45,60].map(m=>`<button class="cd-preset${!cdState.running && cdState.duration===m*60?' active':''}" onclick="cdSetDuration(${m})">${m}m</button>`).join('')}
          <button class="cd-preset" onclick="cdCustomDuration()">Custom</button>
        </div>
        <button class="timer-btn ${cdState.running?'timer-stop':'timer-start'}" onclick="cdToggle()">
          ${cdState.running ? (cdState.remaining<=0?'✓ Dismiss':'⏹ Cancel') : '▶ Start'}
        </button>
      </div></div>

      <div class="card" style="padding:20px;">
        <div class="sec-label">Last 7 Days (hours)</div>
        <div class="chart-box"><canvas id="study-chart"></canvas></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;">
          <div class="stat-box"><div class="stat-box-label">7-Day Avg</div><div class="stat-box-value" style="color:var(--study);">${fmtDuration(avg7m)}</div></div>
          <div class="stat-box"><div class="stat-box-label">Total Sessions</div><div class="stat-box-value" style="color:var(--study);">${ss.length}</div></div>
        </div>
      </div>

      <div class="card" style="padding:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div class="sec-label" style="margin-bottom:0;">Today's Sessions</div>
          <span style="font-size:11px;color:var(--text-muted);">click ✕ to remove</span>
        </div>
        ${(() => {
          const todaySess = ss.filter(x => x.date === today()).sort((a,b) => new Date(b.start)-new Date(a.start));
          if (todaySess.length === 0) return `<div style="text-align:center;padding:18px 0;color:var(--text-muted);font-size:13px;">No sessions logged today</div>`;
          return `<div class="session-log">${todaySess.map(x => {
            const startFmt = new Date(x.start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
            const endFmt   = new Date(x.end).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
            return `<div class="session-row">
              <span class="session-row-time">${startFmt} → ${endFmt}</span>
              <span class="session-row-dur">${fmtDuration(x.mins)}</span>
              <button class="session-del-btn" onclick="doDelSession(${eventArg(x.id)})" title="Remove session">✕</button>
            </div>`;
          }).join('')}</div>`;
        })()}
      </div>

      <div class="card" style="padding:20px;">
        <div class="sec-label">60-Day History (hours)</div>
        <div class="chart-box-lg" style="height:220px;"><canvas id="study-chart-60"></canvas></div>
      </div>

    </div>
  </div>`;
}
function startTimerDisp(){
  if(timerIv) clearInterval(timerIv);
  const a=S.activeSession(); if(!a) return;
  const tick=()=>{
    const el=$('timer-disp'); if(!el){clearInterval(timerIv);return;}
    const e=Math.floor((Date.now()-new Date(a.start).getTime())/1000);
    el.textContent=`${String(Math.floor(e/3600)).padStart(2,'0')}:${String(Math.floor(e%3600/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
  };
  tick(); timerIv=setInterval(tick,1000);
}
function doToggleTimer(){
  if(S.activeSession()){S.stopSession();clearInterval(timerIv);timerIv=null;}
  else {
    if (cdState.running) {
      showToast('Stop the countdown before starting the stopwatch', 'info');
      return;
    }
    S.startSession();
  }
  refreshView(); updateScore();
}
function doDelSession(id){
  if(S.activeSession()) return; // don't delete while timer is running
  S.delSession(id); updateScore(); refreshView();
}

/* ── COUNTDOWN TIMER ── */
function loadCountdownState() {
  try {
    const saved = JSON.parse(localStorage.getItem('pvp_countdown') || 'null');
    if (!saved || typeof saved.duration !== 'number') return { duration: 25 * 60, remaining: 25 * 60, running: false, endTime: null };
    if (saved.running && typeof saved.endTime === 'number') {
      return { duration: saved.duration, remaining: Math.max(0, Math.round((saved.endTime - Date.now()) / 1000)), running: true, endTime: saved.endTime };
    }
    return { duration: saved.duration, remaining: saved.remaining ?? saved.duration, running: false, endTime: null };
  } catch {
    return { duration: 25 * 60, remaining: 25 * 60, running: false, endTime: null };
  }
}
function saveCountdownState() {
  localStorage.setItem('pvp_countdown', JSON.stringify(cdState));
}
let cdState = loadCountdownState();
let cdIv = null;

function fmtCD(secs) {
  if (secs <= 0) return '00:00';
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function cdSetDuration(mins) {
  if (cdState.running) return;
  cdState.duration = mins * 60;
  cdState.remaining = mins * 60;
  saveCountdownState();
  refreshView();
}

function cdCustomDuration() {
  if (cdState.running) return;
  const v = parseInt(prompt('Enter minutes:'));
  if (!isNaN(v) && v > 0 && v <= 180) {
    cdState.duration = v * 60;
    cdState.remaining = v * 60;
    saveCountdownState();
    refreshView();
  }
}

function cdToggle() {
  if (cdState.running) {
    // Stop / Dismiss
    clearInterval(cdIv); cdIv = null;
    cdState.remaining = Math.max(0, Math.round((cdState.endTime - Date.now()) / 1000));
    cdState.running = false;
    if (cdState.remaining > 0) {
      const elapsedSecs = cdState.duration - cdState.remaining;
      const mins = Math.floor(elapsedSecs / 60);
      if (mins >= 1) {
        const ss = S.sessions();
        const startTime = new Date(cdState.endTime - cdState.duration * 1000).toISOString();
        ss.push({
          id: uid(),
          date: today(),
          start: startTime,
          end: new Date().toISOString(),
          mins: mins
        });
        S.s('pvp_sessions', ss);
        updateScore();
      }
    }
    cdState.remaining = cdState.duration;
    cdState.endTime = null;
    saveCountdownState();
    refreshView();
  } else {
    // Start
    if (S.activeSession()) {
      showToast('Stop the stopwatch before starting the countdown', 'info');
      return;
    }
    if (Notification.permission === 'default') Notification.requestPermission();
    cdState.running = true;
    cdState.endTime = Date.now() + cdState.duration * 1000;
    cdState.remaining = cdState.duration;
    saveCountdownState();
    cdStartTick();
  }
}

function cdStartTick() {
  if (cdIv) clearInterval(cdIv);
  const circ = 2 * Math.PI * 58;
  const tick = () => {
    const el = $('cd-disp');
    const arc = $('cd-arc');
    const status = $('cd-status');
    if (!el) { clearInterval(cdIv); return; }
    cdState.remaining = Math.max(0, Math.round((cdState.endTime - Date.now()) / 1000));
    el.textContent = fmtCD(cdState.remaining);
    // Update ring
    const pct = cdState.duration > 0 ? cdState.remaining / cdState.duration : 0;
    if (arc) arc.setAttribute('stroke-dashoffset', circ * pct);
    if (cdState.remaining <= 0) {
      clearInterval(cdIv); cdIv = null;
      cdState.running = false;
      cdState.endTime = null;
      saveCountdownState();
      el.classList.add('done');
      if (status) status.textContent = "TIME'S UP!";
      cdNotify();
      
      const mins = Math.round(cdState.duration / 60);
      if (mins >= 1) {
        const ss = S.sessions();
        const startTime = new Date(cdState.endTime - cdState.duration * 1000).toISOString();
        ss.push({
          id: uid(),
          date: today(),
          start: startTime,
          end: new Date().toISOString(),
          mins: mins
        });
        S.s('pvp_sessions', ss);
        updateScore();
        refreshView();
      }
    }
  };
  tick();
  cdIv = setInterval(tick, 1000);
}

function cdNotify() {
  // Browser notification
  if (Notification.permission === 'granted') {
    new Notification('Outline — Timer Done', { body: `Your ${Math.round(cdState.duration/60)} minute session is complete.`, icon: '' });
  }
  // Audio beep using Web Audio API
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0.15;
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  } catch(e) { console.warn('Audio beep failed:', e); }
}

/* ── SLEEP ── */
function vSleep(){
  const sl=S.todaySleep(),l7=last7(),slMap=S.sleepMap();
  const entries=l7.map(d=>slMap[d]?.mins||0).filter(v=>v>0);
  const avg7m=entries.length>0?Math.round(entries.reduce((s,v)=>s+v,0)/entries.length):0;
  return `<div class="view-enter">
    <div class="page-header"><h1 class="page-title">Sleep Tracker</h1><p class="page-sub">Rest well. Perform better.</p></div>
    <div class="sleep-layout">
      <div class="card sleep-form-card">
        <div class="sec-label" style="margin-bottom:18px;">Log Last Night's Sleep</div>
        <div class="field-group"><label class="field-label" for="sl-bed">Bed Time</label>
          <input class="input" type="time" id="sl-bed" value="${sl?.bed||'23:00'}" oninput="updateSleepPrev()"></div>
        <div class="field-group"><label class="field-label" for="sl-wake">Wake Time</label>
          <input class="input" type="time" id="sl-wake" value="${sl?.wake||'07:00'}" oninput="updateSleepPrev()"></div>
        <div class="sleep-duration-preview">
          <div class="sleep-dur-val" id="sl-dur-val">${sl?fmtDuration(sl.mins):'—'}</div>
          <div class="sleep-dur-label">sleep duration</div>
        </div>
        <button class="btn btn-primary" onclick="doLogSleep()"
          style="width:100%;background:linear-gradient(135deg,#34d399,#059669);box-shadow:0 6px 20px rgba(52,211,153,0.28);">
          ${sl?'↻ Update Sleep':'+ Log Sleep'}
        </button>
        ${sl?`<p style="font-size:12px;color:var(--text-secondary);text-align:center;margin-top:12px;">${sl.bed} → ${sl.wake} · ${fmtDuration(sl.mins)}</p>`:''}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="card"><div class="sec-label">Last 7 Nights</div><div class="chart-box" style="height:200px;"><canvas id="sleep-chart"></canvas></div></div>
        <div class="card"><div style="display:flex;align-items:center;gap:18px;">
          ${ring({size:82,sw:9,pct:avg7m/480,color:'var(--sleep)',val:fmtDuration(avg7m),unit:'avg'})}
          <div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;font-weight:700;letter-spacing:0.6px;">7-Night Average</div>
            <div style="font-size:22px;font-weight:700;color:var(--sleep);margin-top:4px;">${fmtDuration(avg7m)}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:5px;">${avg7m>=420?'Meeting 7h goal':`${fmtDuration(420-avg7m)} short`}</div>
          </div>
        </div></div>
      </div>
    </div>
  </div>`;
}
function sleepMins(b,w){
  const[bh,bm]=b.split(':').map(Number),[wh,wm]=w.split(':').map(Number);
  let bT=bh*60+bm,wT=wh*60+wm; if(wT<=bT) wT+=1440; return wT-bT;
}
function updateSleepPrev(){
  const b=$('sl-bed')?.value,w=$('sl-wake')?.value; if(!b||!w) return;
  const el=$('sl-dur-val'); if(el) el.textContent=fmtDuration(sleepMins(b,w));
}
function doLogSleep(){
  const b=$('sl-bed')?.value,w=$('sl-wake')?.value; if(!b||!w) return;
  S.logSleep(b,w,sleepMins(b,w)); updateScore(); refreshView();
}

/* ── JOURNAL ── */
let journalSelectedDate = today();
let journalDebounceTimer = null;

function fmtFullDate(dStr) {
  const d = new Date(dStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function selectJournalOption(metric, value) {
  const d = journalSelectedDate;
  const currentText = $('journal-text-area')?.value;
  clearTimeout(journalDebounceTimer);
  S.journalMapAsync().then(async map => {
    if (!map[d]) map[d] = { mood: '', energy: '', focus: '', physical: '', text: '' };
    if (currentText !== undefined) map[d].text = currentText;
    map[d][metric] = value;
    await S.saveJournal(map);
    if (!Auth.hasPassword()) localStorage.removeItem(DM.journalDraftKey);
    refreshView();
  });
}

function updateJournalText(text) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const charCount = text.length;
  const wcEl = $('j-word-count'), ccEl = $('j-char-count'), stEl = $('j-save-status');
  if (wcEl) wcEl.textContent = wordCount;
  if (ccEl) ccEl.textContent = charCount;
  if (stEl) stEl.textContent = 'Saving changes...';

  // Keep a reload-safe local copy immediately. The durable file save remains
  // debounced below, but a page can disappear before that timer fires.
  if (!Auth.hasPassword()) {
    const d = journalSelectedDate;
    const map = S.journalMap();
    if (!map[d]) map[d] = { mood: '', energy: '', focus: '', physical: '', text: '' };
    map[d].text = text;
    S._cache['pvp_journal'] = map;
    localStorage.setItem('pvp_journal', JSON.stringify(map));
    if (!DM.fallback) {
      localStorage.setItem(DM.journalPendingKey, localStorage.getItem('pvp_journal'));
    }
    localStorage.setItem(DM.journalDraftKey, JSON.stringify({ date: d, text }));
  }

  clearTimeout(journalDebounceTimer);
  journalDebounceTimer = setTimeout(async () => {
    const d = journalSelectedDate;
    const map = await S.journalMapAsync();
    if (!map[d]) map[d] = { mood: '', energy: '', focus: '', physical: '', text: '' };
    map[d].text = text;
    await S.saveJournal(map);
    if (!Auth.hasPassword()) localStorage.removeItem(DM.journalDraftKey);
    if (stEl) stEl.textContent = 'All changes saved locally';
  }, 500);
}

function navigateJournalDate(offset) {
  const d = new Date(journalSelectedDate + 'T12:00:00');
  d.setDate(d.getDate() + offset);
  journalSelectedDate = dateKey(d);
  refreshView();
}

async function vJournal() {
  const d = journalSelectedDate;
  const map = await S.journalMapAsync();
  const entry = map[d] || { mood: '', energy: '', focus: '', physical: '', text: '' };
  
  const moodOptions = [
    { value: 'Great', emoji: '' },
    { value: 'Good', emoji: '' },
    { value: 'Okay', emoji: '' },
    { value: 'Bad', emoji: '' },
    { value: 'Stressed', emoji: '' }
  ];
  
  const energyOptions = [
    { value: 'High', emoji: '' },
    { value: 'Medium', emoji: '' },
    { value: 'Low', emoji: '' }
  ];

  const focusOptions = [
    { value: 'Flow', emoji: '' },
    { value: 'Focused'},
    { value: 'Distracted', emoji: '' }
  ];

  const physicalOptions = [
    { value: 'Energetic'},
    { value: 'Okay', emoji: '' },
    { value: 'Tired', emoji: '' },
    { value: 'Sick', emoji: '' }
  ];

  const makeCapsules = (options, currentVal, metricName) => {
    return options.map(opt => {
      const active = opt.value === currentVal ? ' active' : '';
      return `<div class="j-capsule${active}" onclick="selectJournalOption('${metricName}', '${opt.value}')">
        <span>${opt.emoji}</span><span>${opt.value}</span>
      </div>`;
    }).join('');
  };

  const wordCount = entry.text ? entry.text.trim().split(/\s+/).filter(Boolean).length : 0;
  const charCount = entry.text ? entry.text.length : 0;

  return `<div class="view-enter">
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;">
      <div>
        <h1 class="page-title">Daily Journal</h1>
        <p class="page-sub">Reflect on your day, log your metrics, and capture your thoughts.</p>
      </div>
      <button class="lock-page-btn" onclick="lockAndNavigate('journal')" title="Lock Journal">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Lock
      </button>
    </div>

    <div class="journal-date-bar">
      <button class="j-date-btn" onclick="navigateJournalDate(-1)" title="Previous Day">◀</button>
      <span class="j-date-txt" id="j-date-display">${fmtFullDate(d)}</span>
      <button class="j-date-btn" onclick="navigateJournalDate(1)" title="Next Day">▶</button>
    </div>

    <div class="journal-layout">
      <div class="card j-capsule-grid">
        <div class="sec-label">How is your mood?</div>
        <div class="j-capsule-group">
          ${makeCapsules(moodOptions, entry.mood, 'mood')}
        </div>

        <div class="sec-label" style="margin-top: 10px;">Energy Level</div>
        <div class="j-capsule-group">
          ${makeCapsules(energyOptions, entry.energy, 'energy')}
        </div>

        <div class="sec-label" style="margin-top: 10px;">Focus Level</div>
        <div class="j-capsule-group">
          ${makeCapsules(focusOptions, entry.focus, 'focus')}
        </div>

        <div class="sec-label" style="margin-top: 10px;">Physical State</div>
        <div class="j-capsule-group">
          ${makeCapsules(physicalOptions, entry.physical, 'physical')}
        </div>
      </div>

      <div>
        <textarea id="journal-text-area" class="j-textarea" placeholder="Start writing here... What did you do today? What are you grateful for?" oninput="updateJournalText(this.value)">${escH(entry.text || '')}</textarea>
        <div class="j-meta">
          <span id="j-save-status">All changes saved locally</span>
          <span><span id="j-word-count">${wordCount}</span> words &middot; <span id="j-char-count">${charCount}</span> characters</span>
        </div>
      </div>
    </div>
  </div>`;
}

/* ── IDEAS ── */
let activeIdeaEditId = null;

function toggleAddIdeaForm(show) {
  const btn = $('ai-btn'), form = $('ai-form');
  if (!btn || !form) return;
  if (show) {
    btn.classList.add('hidden');
    form.classList.remove('hidden');
    $('ai-title')?.focus();
  } else {
    btn.classList.remove('hidden');
    form.classList.add('hidden');
    $('ai-title').value = '';
    $('ai-desc').value = '';
  }
}

async function doAddIdea() {
  const titleIn = $('ai-title'), descIn = $('ai-desc');
  const title = titleIn?.value?.trim();
  if (!title) return;
  const desc = descIn?.value?.trim() || '';
  await S.addIdea(title, desc);
  refreshView();
}

function toggleEditIdea(id) {
  activeIdeaEditId = id;
  refreshView();
  if (id) {
    $(`edit-title-${id}`)?.focus();
  }
}

async function doSaveIdeaEdit(id) {
  const tIn = $(`edit-title-${id}`), dIn = $(`edit-desc-${id}`);
  const title = tIn?.value?.trim();
  if (!title) return;
  const desc = dIn?.value?.trim() || '';
  await S.updateIdea(id, { title, desc });
  toggleEditIdea(null);
}

async function reorderIdeas(draggedId, targetColumnId, targetSiblingId, after) {
  const allIdeas = await S.ideasAsync();
  const draggedIdea = allIdeas.find(i => i.id === draggedId);
  if (!draggedIdea) return;

  draggedIdea.column = targetColumnId;

  const remaining = allIdeas.filter(i => i.id !== draggedId);
  const targetIdx = remaining.findIndex(i => i.id === targetSiblingId);

  if (targetIdx !== -1) {
    const insertIdx = after ? targetIdx + 1 : targetIdx;
    remaining.splice(insertIdx, 0, draggedIdea);
  } else {
    remaining.push(draggedIdea);
  }

  await S._saveIdeas(remaining);
}

async function doDelIdea(id) {
  if (confirm('Delete this idea card?')) {
    await S.delIdea(id);
    refreshView();
  }
}

function ideaCardHTML(i) {
  const isEditing = activeIdeaEditId === i.id;
  
  if (isEditing) {
    return `<div class="idea-card editing" onclick="event.stopPropagation()">
      <input type="text" id="edit-title-${escH(i.id)}" class="idea-edit-in" style="font-weight:700;" value="${escH(i.title)}">
      <textarea id="edit-desc-${escH(i.id)}" class="idea-edit-in" style="height:80px;resize:vertical;">${escH(i.desc || '')}</textarea>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px;">
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px;" onclick="toggleEditIdea(null)">Cancel</button>
        <button class="btn btn-primary" style="padding:4px 10px;font-size:11px;" onclick="doSaveIdeaEdit(${eventArg(i.id)})">Save</button>
      </div>
    </div>`;
  }

  return `<div class="idea-card" onclick="toggleEditIdea(${eventArg(i.id)})" draggable="true" data-type="idea" data-idea-id="${escH(i.id)}">
    <div class="idea-title">${escH(i.title)}</div>
    ${i.desc ? `<div class="idea-desc">${escH(i.desc)}</div>` : ''}
    <div class="idea-actions" onclick="event.stopPropagation()">
      <button class="idea-btn del" style="margin-left:auto;" onclick="doDelIdea(${eventArg(i.id)})" title="Delete">✕</button>
    </div>
  </div>`;
}

async function vIdeas() {
  const ideas = await S.ideasAsync();
  const columns = [
    { id: 'inbox',    title: 'Inbox',    emoji: '', list: ideas.filter(i => i.column === 'inbox') },
    { id: 'refining', title: 'Refining', emoji: '', list: ideas.filter(i => i.column === 'refining') },
    { id: 'archived', title: 'Archived', emoji: '', list: ideas.filter(i => i.column === 'archived') }
  ];

  return `<div class="view-enter">
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;">
      <div>
        <h1 class="page-title">Ideas Board</h1>
        <p class="page-sub">Brainstorm, refine, and archive your projects and thoughts.</p>
      </div>
      <button class="lock-page-btn" onclick="lockAndNavigate('ideas')" title="Lock Ideas">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Lock
      </button>
    </div>

    <div class="ideas-board">
      ${columns.map(col => `
        <div class="ideas-column" data-column-id="${col.id}">
          <div class="ideas-column-header">
            <span class="ideas-column-title">${col.emoji} &nbsp;${col.title}</span>
            <span class="ideas-column-count">${col.list.length}</span>
          </div>
          
          ${col.id === 'inbox' ? `
            <div style="margin-bottom: 8px;">
              <div class="add-idea-inline" id="ai-btn" onclick="toggleAddIdeaForm(true)">
                ＋ New Idea
              </div>
              <div id="ai-form" class="card hidden" style="padding:14px;display:flex;flex-direction:column;gap:8px;">
                <input type="text" id="ai-title" class="idea-edit-in" placeholder="Idea title..." style="margin-bottom:4px;">
                <textarea id="ai-desc" class="idea-edit-in" placeholder="Short description..." style="height:60px;resize:none;margin-bottom:8px;"></textarea>
                <div style="display:flex;gap:6px;justify-content:flex-end;">
                  <button class="btn btn-ghost" style="padding:5px 10px;font-size:11.5px;" onclick="toggleAddIdeaForm(false)">Cancel</button>
                  <button class="btn btn-primary" style="padding:5px 12px;font-size:11.5px;" onclick="doAddIdea()">Add</button>
                </div>
              </div>
            </div>
          ` : ''}

          <div style="display:flex;flex-direction:column;gap:10px;overflow-y:auto;max-height:600px;padding-right:2px;min-height:250px;">
            ${col.list.length === 0 && col.id !== 'inbox' ? `
              <div style="text-align:center;padding:24px 10px;color:var(--text-muted);font-size:12px;border:1px dashed var(--border-default);border-radius:var(--r-btn);">
                Empty column
              </div>
            ` : ''}
            ${col.list.map(idea => ideaCardHTML(idea)).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  </div>`;
}

/* ================================================================
   ROUTER
   ================================================================ */
let curView=null;
let isDeleteHabitMode = false;
let isAddHabitMode = false;
function navigate(v){
  if (v !== 'habits') {
    isDeleteHabitMode = false;
    isAddHabitMode = false;
  }
  // Always re-render journal/ideas (lock state may have changed)
  const alwaysRender = v==='journal' || v==='ideas';
  if(alwaysRender || curView!==v){ curView=v; renderView(v); }
}
function refreshView(){ renderView(curView); }

/* ── LOCK SCREEN ─────────────────────────────────────────────── */
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

function lockAndNavigate(view) {
  Auth.lock();
  S._cache['pvp_journal_dec'] = undefined;
  S._cache['pvp_ideas_dec']   = undefined;
  curView = view; // stay on same view so refreshView works correctly
  renderView(view);
}

function vLockScreen(section) {
  const label = section === 'journal' ? 'Daily Journal' : section === 'ideas' ? 'Ideas Board' : 'Outline';
  const isFirstTime = !Auth.hasPassword();
  return `<div class="lock-screen">
    <div class="lock-card" id="lock-card">
      <div class="lock-icon-wrap">${LOCK_SVG}</div>
      <div class="lock-title">${isFirstTime ? 'Protect ' + label : label + ' is Locked'}</div>
      <div class="lock-sub">${isFirstTime
        ? 'Set a master password to encrypt your personal Outline data.'
        : 'Enter your password to access this section.'}</div>

      ${isFirstTime ? `
        <div class="lock-confirm-wrap">
          <div class="lock-input-wrap">
            <input class="lock-input" type="password" id="lock-pw1" placeholder="Create password…" autocomplete="new-password"
              onkeydown="if(event.key==='Enter')$('lock-pw2').focus()">
            <button class="lock-eye" onclick="toggleLockEye('lock-pw1',this)" tabindex="-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="lock-input-wrap">
            <input class="lock-input" type="password" id="lock-pw2" placeholder="Confirm password…" autocomplete="new-password"
              onkeydown="if(event.key==='Enter')doSetPassword('${section}')">
            <button class="lock-eye" onclick="toggleLockEye('lock-pw2',this)" tabindex="-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="lock-error" id="lock-err"></div>
          <button class="lock-btn" onclick="doSetPassword('${section}')">Set Password &amp; Unlock</button>
        </div>
        <p class="lock-hint">If you forget your password, your Journal &amp; Ideas data cannot be recovered.</p>
      ` : `
        <div class="lock-input-wrap" style="width:100%">
          <input class="lock-input" type="password" id="lock-pw1" placeholder="Enter password…" autocomplete="current-password"
            onkeydown="if(event.key==='Enter')doUnlock('${section}')">
          <button class="lock-eye" onclick="toggleLockEye('lock-pw1',this)" tabindex="-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <div class="lock-error" id="lock-err"></div>
        <button class="lock-btn" id="lock-btn" onclick="doUnlock('${section}')">Unlock</button>
      `}
      <span class="lock-badge">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        AES-256 encrypted
      </span>
    </div>
  </div>`;
}

function toggleLockEye(inputId, btn) {
  const inp = $(inputId);
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.style.color = 'var(--text-primary)';
  } else {
    inp.type = 'password';
    btn.style.color = '';
  }
}

async function doSetPassword(section) {
  const pw1 = $('lock-pw1')?.value || '';
  const pw2 = $('lock-pw2')?.value || '';
  const errEl = $('lock-err');
  if (pw1.length < 6) { if(errEl) errEl.textContent = 'Password must be at least 6 characters.'; shakeLockCard(); return; }
  if (pw1 !== pw2)    { if(errEl) errEl.textContent = 'Passwords do not match.'; shakeLockCard(); return; }
  if (errEl) errEl.textContent = '';
  // Grab any existing plaintext data before encrypting
  const existingJournal = S.g('pvp_journal') || {};
  const existingIdeas   = S.g('pvp_ideas')   || [];
  await Auth.setPassword(pw1, existingJournal, existingIdeas);
  renderView(section);
}

async function doUnlock(section) {
  const pw = $('lock-pw1')?.value || '';
  const errEl = $('lock-err');
  const btn   = $('lock-btn');
  if (btn) { btn.textContent = 'Unlocking…'; btn.disabled = true; }
  const ok = await Auth.unlock(pw);
  if (ok) {
    S._cache['pvp_journal_dec'] = undefined;
    S._cache['pvp_ideas_dec']   = undefined;
    renderView(section);
  } else {
    if (errEl) errEl.textContent = 'Wrong password. Try again.';
    if (btn) { btn.textContent = 'Unlock'; btn.disabled = false; }
    shakeLockCard();
    if ($('lock-pw1')) { $('lock-pw1').value = ''; $('lock-pw1').focus(); }
  }
}

function shakeLockCard() {
  const card = $('lock-card');
  if (!card) return;
  card.classList.remove('lock-shake');
  void card.offsetWidth; // reflow to restart animation
  card.classList.add('lock-shake');
}

/* ================================================================
   WEALTH MANAGEMENT
   ================================================================ */
let wealthActiveTab = 'overview';

function setWealthSubTab(tab) {
  wealthActiveTab = tab;
  refreshView();
}

async function vWealth() {
  const data = S.wealth();
  const accounts = await Promise.all((data.accounts || []).map(async a => {
    const name = await Auth.decryptField(a.name, "[Locked Account]");
    return { ...a, decryptedName: name };
  }));

  const transactions = await Promise.all((data.transactions || []).map(async t => {
    const note = await Auth.decryptField(t.note, "[Locked Note]");
    return { ...t, decryptedNote: note };
  }));

  const budgets = data.budgets || {};
  const categories = data.categories || getDefaultWealthCategories();

  const netWorth = accounts.reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);

  const now = new Date();
  const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthTxns = transactions.filter(t => t.date && t.date.startsWith(curMonthStr));

  const monthIncome = monthTxns.filter(t => t.type === 'income').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const monthExpense = monthTxns.filter(t => t.type === 'expense').reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const savingsRate = monthIncome > 0 ? Math.max(0, Math.round(((monthIncome - monthExpense) / monthIncome) * 100)) : 0;

  const tabsHTML = `
    <div class="wealth-nav-tabs">
      <button class="wealth-tab ${wealthActiveTab === 'overview' ? 'active' : ''}" onclick="setWealthSubTab('overview')"> Overview</button>
      <button class="wealth-tab ${wealthActiveTab === 'transactions' ? 'active' : ''}" onclick="setWealthSubTab('transactions')">Transactions (${transactions.length})</button>
      <button class="wealth-tab ${wealthActiveTab === 'accounts' ? 'active' : ''}" onclick="setWealthSubTab('accounts')">Accounts (${accounts.length})</button>
      <button class="wealth-tab ${wealthActiveTab === 'budgets' ? 'active' : ''}" onclick="setWealthSubTab('budgets')">Budgets</button>
    </div>
  `;

  let contentHTML = '';

  if (wealthActiveTab === 'overview') {
    const recentTxns = [...transactions].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);

    contentHTML = `
      <div class="wealth-summary-grid">
        <div class="wealth-summary-card">
          <div class="wealth-card-label">Net Worth</div>
          <div class="wealth-card-val">${fmtCurrency(netWorth)}</div>
          <div class="wealth-card-sub">${accounts.length} total account${accounts.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="wealth-summary-card">
          <div class="wealth-card-label">This Month Income</div>
          <div class="wealth-card-val" style="color:var(--success);">${fmtCurrency(monthIncome)}</div>
          <div class="wealth-card-sub">Inflow for ${now.toLocaleString('default', { month: 'short' })}</div>
        </div>
        <div class="wealth-summary-card">
          <div class="wealth-card-label">This Month Expense</div>
          <div class="wealth-card-val" style="color:var(--danger);">${fmtCurrency(monthExpense)}</div>
          <div class="wealth-card-sub">Outflow for ${now.toLocaleString('default', { month: 'short' })}</div>
        </div>
        <div class="wealth-summary-card">
          <div class="wealth-card-label">Savings Rate</div>
          <div class="wealth-card-val">${savingsRate}%</div>
          <div class="wealth-card-sub">${monthIncome >= monthExpense ? 'Net surplus' : 'Net deficit'}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start;">
        <div style="display:flex;flex-direction:column;gap:20px;">
          <div class="card">
            <div class="sec-label">Monthly Expense Breakdown (${now.toLocaleString('default', { month: 'short' })})</div>
            <div class="chart-box" style="height:220px;"><canvas id="wealth-cat-chart"></canvas></div>
          </div>
          <div class="card">
            <div class="sec-label">Recent Activity</div>
            ${recentTxns.length === 0 ? `
              <div class="empty"><div class="empty-txt">No transactions logged yet.</div></div>
            ` : `
              <div class="wealth-txn-list">
                ${recentTxns.map(t => {
                  const acct = accounts.find(a => a.id === t.accountId);
                  const dstAcct = t.type === 'transfer' ? accounts.find(a => a.id === t.toAccountId) : null;
                  const isInc = t.type === 'income';
                  const isExp = t.type === 'expense';
                  const accountLabel = t.type === 'transfer'
                    ? `${acct ? acct.decryptedName : 'Account'} → ${dstAcct ? dstAcct.decryptedName : 'Destination'}`
                    : (acct ? acct.decryptedName : 'Account');
                  return `
                    <div class="wealth-txn-row">
                      <div class="txn-left">
                        <div class="txn-icon">${getCategoryEmoji(t.category)}</div>
                        <div>
                          <div style="font-size:13.5px;font-weight:600;color:var(--text-primary);">${escH(t.decryptedNote || t.category)}</div>
                          <div style="font-size:11.5px;color:var(--text-muted);">${escH(t.date)} · ${escH(accountLabel)}</div>
                        </div>
                      </div>
                      <div class="${isInc ? 'txn-amt-pos' : isExp ? 'txn-amt-neg' : 'txn-amt-neu'}">
                        ${t.type === 'transfer' ? '↔' : isInc ? '+' : isExp ? '−' : ''}${fmtCurrency(t.amount)}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
        </div>

        <div class="card">
          <div class="sec-label">Accounts Summary</div>
          ${accounts.length === 0 ? `
            <div class="empty" style="padding:20px;"><div class="empty-txt">No accounts added.</div><button class="btn btn-primary" style="margin-top:10px;" onclick="setWealthSubTab('accounts')">＋ Add Account</button></div>
          ` : `
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${accounts.map(a => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:8px;">
                  <div>
                    <div style="font-size:13px;font-weight:600;">${escH(a.decryptedName)}</div>
                    <span class="acct-type-badge">${escH(a.type || 'Bank')}</span>
                  </div>
                  <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;">${fmtCurrency(a.balance, a.currency || '₹')}</div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;
  } else if (wealthActiveTab === 'transactions') {
    const acctOptions = accounts.map(a => `<option value="${escH(a.id)}">${escH(a.decryptedName)} (${fmtCurrency(a.balance, a.currency || '₹')})</option>`).join('');
    const sortedTxns = [...transactions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    contentHTML = `
      <div class="card" style="margin-bottom:20px;">
        <div class="sec-label">＋ Log New Transaction</div>
        ${accounts.length === 0 ? `
          <div style="font-size:13px;color:var(--text-muted);">Please add an account first before logging transactions. <button class="btn btn-primary" style="margin-left:8px;padding:4px 10px;font-size:12px;" onclick="setWealthSubTab('accounts')">Add Account</button></div>
        ` : `
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;align-items:center;">
            <select id="wtxn-type" class="input" onchange="updateWealthCatOptions()">
              <option value="expense" selected>Expense</option>
              <option value="income">Income</option>
              <option value="transfer"> Transfer</option>
            </select>

            <select id="wtxn-acct" class="input">
              ${acctOptions}
            </select>

            <select id="wtxn-to" class="input hidden">
              <option value="">Destination account</option>
              ${acctOptions}
            </select>

            <select id="wtxn-cat" class="input">
              ${categories.expense.map(c => `<option value="${escH(c)}">${getCategoryEmoji(c)} ${escH(c)}</option>`).join('')}
            </select>

            <input type="number" id="wtxn-amt" class="input" placeholder="Amount (₹)" step="0.01" min="0">

            <input type="date" id="wtxn-date" class="input" value="${today()}">

            <input type="text" id="wtxn-note" class="input" placeholder="Note (optional)" style="grid-column: span 2;">

            <button class="btn btn-primary" style="height:38px;" onclick="doAddWealthTransaction()">+ Save</button>
          </div>
        `}
      </div>

      <div class="card">
        <div class="sec-label">All Transactions</div>
        ${sortedTxns.length === 0 ? `
          <div class="empty"><div class="empty-txt">No transactions logged yet.</div></div>
        ` : `
          <div class="wealth-txn-list">
            ${sortedTxns.map(t => {
              const acct = accounts.find(a => a.id === t.accountId);
              const dstAcct = t.type === 'transfer' ? accounts.find(a => a.id === t.toAccountId) : null;
              const isInc = t.type === 'income';
              const isExp = t.type === 'expense';
              const accountLabel = t.type === 'transfer'
                ? `${acct ? acct.decryptedName : 'Account'} → ${dstAcct ? dstAcct.decryptedName : 'Destination'}`
                : (acct ? acct.decryptedName : 'Account');
              return `
                <div class="wealth-txn-row">
                  <div class="txn-left">
                    <div class="txn-icon">${getCategoryEmoji(t.category)}</div>
                    <div>
                      <div style="font-size:13.5px;font-weight:600;color:var(--text-primary);">${escH(t.decryptedNote || t.category)}</div>
                          <div style="font-size:11.5px;color:var(--text-muted);">${escH(t.date)} · ${escH(accountLabel)} · <span style="text-transform:capitalize;">${escH(t.type)}</span></div>
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:14px;">
                    <div class="${isInc ? 'txn-amt-pos' : isExp ? 'txn-amt-neg' : 'txn-amt-neu'}">
                      ${t.type === 'transfer' ? '↔' : isInc ? '+' : isExp ? '−' : ''}${fmtCurrency(t.amount)}
                    </div>
                    <button class="task-del" onclick="doDelWealthTransaction(${eventArg(t.id)})" title="Delete transaction">&#10005;</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;
  } else if (wealthActiveTab === 'accounts') {
    contentHTML = `
      <div class="card" style="margin-bottom:20px;">
        <div class="sec-label">＋ Add New Account</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px;align-items:center;">
          <input type="text" id="wacc-name" class="input" placeholder="Account name (e.g. HDFC Bank)">

          <select id="wacc-type" class="input">
            <option value="bank" selected>Bank Account</option>
            <option value="cash"> Cash / Wallet</option>
            <option value="credit">Credit Card</option>
            <option value="investment">Investment</option>
          </select>

          <input type="number" id="wacc-bal" class="input" placeholder="Initial Balance (₹)" step="0.01">

          <select id="wacc-curr" class="input">
            <option value="₹" selected>₹ INR</option>
            <option value="$">$ USD</option>
            <option value="€">€ EUR</option>
            <option value="£">£ GBP</option>
          </select>

          <button class="btn btn-primary" style="height:38px;" onclick="doAddWealthAccount()">+ Add Account</button>
        </div>
      </div>

      <div class="wealth-acct-grid">
        ${accounts.length === 0 ? `
          <div class="card" style="grid-column:1/-1;"><div class="empty"><div class="empty-txt">No accounts created yet. Add your bank, cash, or investment accounts above.</div></div></div>
        ` : `
          ${accounts.map(a => `
            <div class="wealth-acct-card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:8px;">
                  <div>
                    <span class="acct-type-badge">${escH(a.type || 'bank')}</span>
                    <h3 style="font-size:16px;font-weight:700;margin-top:6px;">${escH(a.decryptedName)}</h3>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
                    <button class="btn btn-primary" style="padding:5px 10px;font-size:11px;height:auto;" onclick="doAddMoneyToAccount(${eventArg(a.id)})">＋ Add Money</button>
                    <button class="task-del" onclick="doDelWealthAccount(${eventArg(a.id)})" title="Delete account">&#10005;</button>
                  </div>
                </div>
              <div style="font-family:'Outfit',sans-serif;font-size:26px;font-weight:800;color:var(--text-primary);margin-top:10px;">
                ${fmtCurrency(a.balance, a.currency || '₹')}
              </div>
            </div>
          `).join('')}
        `}
      </div>
    `;
  } else if (wealthActiveTab === 'budgets') {
    contentHTML = `
      <div class="card" style="margin-bottom:20px;">
        <div class="sec-label">Set / Update Monthly Category Budget</div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:center;">
          <select id="wbud-cat" class="input">
            ${categories.expense.map(c => `<option value="${escH(c)}">${getCategoryEmoji(c)} ${escH(c)}</option>`).join('')}
          </select>
          <input type="number" id="wbud-amt" class="input" placeholder="Monthly Limit (₹)" step="100" min="0">
          <button class="btn btn-primary" style="height:38px;" onclick="doSetWealthBudget()">Set Budget</button>
        </div>
      </div>

      <div class="card">
        <div class="sec-label">Monthly Expense Budgets (${now.toLocaleString('default', { month: 'long' })})</div>
        <div style="display:flex;flex-direction:column;gap:16px;margin-top:14px;">
          ${categories.expense.map(cat => {
            const limit = budgets[cat] || 0;
            const spent = monthTxns.filter(t => t.type === 'expense' && t.category === cat).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
            const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
            const barClass = pct >= 100 ? 'budget-over' : pct >= 75 ? 'budget-warn' : 'budget-ok';

            return `
              <div style="background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:10px;padding:14px 16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:18px;">${getCategoryEmoji(cat)}</span>
                    <span style="font-size:14px;font-weight:600;">${escH(cat)}</span>
                  </div>
                  <div style="font-family:'JetBrains Mono',monospace;font-size:13px;">
                    <span style="font-weight:700;color:${spent > limit && limit > 0 ? 'var(--danger)' : 'var(--text-primary)'};">${fmtCurrency(spent)}</span>
                    <span style="color:var(--text-muted);">${limit > 0 ? ' / ' + fmtCurrency(limit) : ' (No budget)'}</span>
                  </div>
                </div>
                ${limit > 0 ? `
                  <div class="budget-bar-wrap">
                    <div class="budget-bar-fill ${barClass}" style="width:${pct}%;"></div>
                  </div>
                  <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:6px;">
                    <span>${pct}% used</span>
                    <span>${spent > limit ? 'Over by ' + fmtCurrency(spent - limit) : fmtCurrency(limit - spent) + ' remaining'}</span>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  return `
    <div class="view-enter">
      <div class="page-header">
        <h1 class="page-title">Wealth Management </h1>
        <p class="page-sub">Track accounts, monitor income &amp; expenses, and manage monthly budgets offline.</p>
      </div>

      <div class="wealth-layout">
        ${tabsHTML}
        ${contentHTML}
      </div>
    </div>
  `;
}

function updateWealthCatOptions() {
  const typeEl = $('wtxn-type');
  const catEl = $('wtxn-cat');
  const toEl = $('wtxn-to');
  if (!typeEl || !catEl) return;
  const type = typeEl.value;
  const data = S.wealth();
  const categories = data.categories || getDefaultWealthCategories();

  if (type === 'transfer') {
    catEl.innerHTML = '<option value="Transfer"> Transfer</option>';
    catEl.disabled = true;
  } else {
    const list = type === 'income' ? categories.income : categories.expense;
    catEl.innerHTML = list.map(c => `<option value="${escH(c)}">${getCategoryEmoji(c)} ${escH(c)}</option>`).join('');
    catEl.disabled = false;
  }

  if (toEl) {
    toEl.classList.toggle('hidden', type !== 'transfer');
  }
}

async function doAddWealthAccount() {
  const nameIn = $('wacc-name');
  const typeIn = $('wacc-type');
  const balIn = $('wacc-bal');
  const currIn = $('wacc-curr');

  const name = nameIn?.value?.trim();
  if (!name) return;

  const type = typeIn?.value || 'bank';
  const balance = balIn?.value === '' ? 0 : Number(balIn.value);
  const currency = currIn?.value || '₹';

  const added = await S.addWealthAccount({
    id: uid(),
    name,
    type,
    balance,
    currency
  });

  if (!added) {
    showWealthValidationError('Enter a valid account name and balance.');
    return;
  }

  if (nameIn) nameIn.value = '';
  if (balIn) balIn.value = '';

  refreshView();
}

function doDelWealthAccount(id) {
  if (confirm('Are you sure you want to delete this account?')) {
    if (!S.delWealthAccount(id)) {
      showWealthValidationError('This account cannot be deleted while it has transactions.');
      return;
    }
    refreshView();
  }
}

async function doAddMoneyToAccount(accountId) {
  const data = S.wealth();
  const acct = (data.accounts || []).find(account => account.id === accountId);
  if (!acct) return;

  const accountLabel = await Auth.decryptField(acct.name, 'account');
  const amountInput = prompt(`Amount to add to ${accountLabel}:`);
  const amount = Number(amountInput);
  if (amountInput === null || !Number.isFinite(amount) || amount <= 0) {
    showWealthValidationError('Enter a positive valid amount.');
    return;
  }

  const note = prompt('Note (optional):') || 'Deposit';

  const added = await S.addWealthTransaction({
    id: uid(),
    type: 'income',
    accountId,
    category: 'Deposit',
    amount,
    date: today(),
    note
  });

  if (!added) {
    showWealthValidationError('The money could not be added to this account.');
    return;
  }

  refreshView();
}

async function doAddWealthTransaction() {
  const typeIn = $('wtxn-type');
  const acctIn = $('wtxn-acct');
  const catIn = $('wtxn-cat');
  const amtIn = $('wtxn-amt');
  const dateIn = $('wtxn-date');
  const noteIn = $('wtxn-note');

  const type = typeIn?.value || 'expense';
  const accountId = acctIn?.value;
  const toAccountId = $('wtxn-to')?.value;
  const category = type === 'transfer' ? 'Transfer' : (catIn?.value || 'Other');
  const amount = amtIn?.value === '' ? 0 : Number(amtIn.value);
  const date = dateIn?.value || today();
  const note = noteIn?.value?.trim() || '';

  if (!accountId || !Number.isFinite(amount) || amount <= 0) {
    showWealthValidationError('Select an account and enter a positive valid amount.');
    return;
  }
  if (type === 'transfer' && (!toAccountId || toAccountId === accountId)) {
    showWealthValidationError('Choose a different destination account for transfers.');
    return;
  }

  const added = await S.addWealthTransaction({
    id: uid(),
    type,
    accountId,
    toAccountId: type === 'transfer' ? toAccountId : undefined,
    category,
    amount,
    date,
    note
  });

  if (!added) {
    showWealthValidationError('Check the transaction details and try again.');
    return;
  }

  if (amtIn) amtIn.value = '';
  if (noteIn) noteIn.value = '';
  const toIn = $('wtxn-to');
  if (toIn) toIn.value = '';

  refreshView();
}

function doDelWealthTransaction(id) {
  if (confirm('Delete this transaction? Account balance will be restored.')) {
    if (!S.delWealthTransaction(id)) {
      showWealthValidationError('This transaction could not be deleted safely.');
      return;
    }
    refreshView();
  }
}

function doSetWealthBudget() {
  const catIn = $('wbud-cat');
  const amtIn = $('wbud-amt');
  const category = catIn?.value;
  const amount = amtIn?.value === '' ? 0 : Number(amtIn.value);
  if (!category || !Number.isFinite(amount) || amount < 0) {
    showWealthValidationError('Choose a category and enter a valid non-negative budget.');
    return;
  }

  if (!S.setWealthBudget(category, amount)) {
    showWealthValidationError('Choose a valid expense category.');
    return;
  }
  if (amtIn) amtIn.value = '';
  refreshView();
}

function initWealthCharts() {
  if (wealthActiveTab !== 'overview') return;
  const data = S.wealth();
  const transactions = data.transactions || [];
  const now = new Date();
  const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthTxns = transactions.filter(t => t.type === 'expense' && t.date && t.date.startsWith(curMonthStr));

  const catMap = {};
  monthTxns.forEach(t => {
    catMap[t.category] = (catMap[t.category] || 0) + (parseFloat(t.amount) || 0);
  });

  const labels = Object.keys(catMap);
  const chartData = Object.values(catMap);

  if (labels.length > 0) {
    makeChart('wealth-cat-chart', labels, chartData, '#ffffff', '₹');
  }
}

async function renderView(v){
  curView=v||'dashboard';
  if(timerIv&&v!=='study'){clearInterval(timerIv);timerIv=null;}
  const c=$('content'); if(!c) return;

  // Protect the complete personal vault whenever a password is configured.
  if (Auth.hasPassword() && !Auth.isUnlocked()) {
    c.innerHTML = vLockScreen(curView);
    c.scrollTop = 0;
    document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===curView));
    setTimeout(() => $('lock-pw1')?.focus(), 80);
    return;
  }

  // Async-capable view map
  const { sync: syncMap, async: asyncMap } = OutlineViews.registry({
    vHabits, vWater, vStudy, vSleep, vJournal, vIdeas, vDashboard,
    vTasks, vProjects, vWealth, vSettings
  });

  let html;
  if (asyncMap[curView]) {
    html = await asyncMap[curView]();
  } else if (syncMap[curView]) {
    html = syncMap[curView]();
  } else {
    html = await vDashboard();
  }
  c.innerHTML = html;
  c.scrollTop=0;
  if(curView==='water'){
    const l7=last7(),wMap=S.waterMap();
    makeChart('water-chart',l7.map(fmtDate),l7.map(d=>((wMap[d]||0)/1000).toFixed(2)),'#38bdf8','L');
  }
  if(curView==='study'){
    const l7=last7(),ss=S.sessions();
    makeChart('study-chart',l7.map(fmtDate),l7.map(d=>+(ss.filter(x=>x.date===d).reduce((s,x)=>s+x.mins,0)/60).toFixed(2)),'#a78bfa','h');
    const d60=Array.from({length:60},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(59-i));return dateKey(d);});
    const d60Labels=d60.map(d=>{const p=d.split('-');return `${p[1]}/${p[2]}`;});
    const d60Data=d60.map(d=>+(ss.filter(x=>x.date===d).reduce((s,x)=>s+x.mins,0)/60).toFixed(2));
    makeLineChart('study-chart-60',d60Labels,d60Data,'h');
    startTimerDisp();
    if(cdState.running && cdState.remaining > 0) cdStartTick();
    if(cdState.running && cdState.remaining <= 0) cdStartTick();
  }
  if(curView==='sleep'){
    const l7=last7(),slMap=S.sleepMap();
    makeChart('sleep-chart',l7.map(fmtDate),l7.map(d=>(slMap[d]?.mins?+(slMap[d].mins/60).toFixed(2):0)),'#34d399','h');
  }
  if(curView==='wealth'){
    initWealthCharts();
  }
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===curView));
}


/* ================================================================
   DATE
   ================================================================ */
function initDate(){
  const n=new Date();
  const tb=$('tb-date'); if(tb) tb.textContent=n.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  const td=$('tb-day');  if(td) td.textContent='· '+n.toLocaleDateString('en-US',{weekday:'long'});
  const sd=$('sidebar-date-txt'); if(sd) sd.textContent=n.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
}

/* ================================================================
   KEYBOARD SHORTCUTS
   ================================================================ */
document.addEventListener('keydown',e=>{
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if(e.key==='t'||e.key==='T'){navigate('tasks');setTimeout(()=>$('task-in')?.focus(),120);}
  if(e.key==='p'||e.key==='P'){navigate('projects');setTimeout(()=>$('proj-title')?.focus(),120);}
  if(e.key==='w'||e.key==='W'){S.addWater(250);updateScore();if(curView==='water')refreshView();if(curView==='dashboard')navigate('dashboard');}
  if(e.key==='s'||e.key==='S'){navigate('study');setTimeout(doToggleTimer,120);}
  if(e.key==='1')navigate('dashboard');
  if(e.key==='2')navigate('tasks');
  if(e.key==='3')navigate('habits');
  if(e.key==='4')navigate('water');
  if(e.key==='5')navigate('study');
  if(e.key==='6')navigate('sleep');
  if(e.key==='?')showHelp();
});

/* ================================================================
   KEYBOARD HELP MODAL
   ================================================================ */
const SHORTCUT_GROUPS = [
  {
    label: 'Navigation',
    shortcuts: [
      { key: '1', desc: 'Dashboard' },
      { key: '2', desc: 'Tasks' },
      { key: '3', desc: 'Habits' },
      { key: '4', desc: 'Water' },
      { key: '5', desc: 'Study' },
      { key: '6', desc: 'Sleep' },
    ]
  },
  {
    label: 'Quick Actions',
    shortcuts: [
      { key: 'T', desc: 'Go to Tasks & focus input' },
      { key: 'P', desc: 'Go to Projects & focus input' },
      { key: 'W', desc: 'Log 250 ml water' },
      { key: 'S', desc: 'Go to Study & start/stop timer' },
      { key: '?', desc: 'Show this help' },
      { key: 'Esc', desc: 'Close dialogs' },
    ]
  }
];

function showHelp() {
  const existing = document.querySelector('.help-modal');
  if (existing) { existing.remove(); return; }
  const rows = SHORTCUT_GROUPS.map(group => `
    <div class="help-modal-group">
      <div class="help-modal-group-label">${escH(group.label)}</div>
      ${group.shortcuts.map(s => `
        <div class="help-modal-row">
          <kbd class="help-kbd">${escH(s.key)}</kbd>
          <span class="help-modal-desc">${escH(s.desc)}</span>
        </div>`).join('')}
    </div>`).join('');
  const el = document.createElement('div');
  el.className = 'help-modal';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Keyboard shortcuts');
  el.innerHTML = `
    <div class="help-modal-card">
      <div class="help-modal-header">
        <span class="help-modal-title">Keyboard Shortcuts</span>
        <button class="help-modal-close" onclick="closeHelp()" aria-label="Close">✕</button>
      </div>
      <div class="help-modal-body">${rows}</div>
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) closeHelp(); });
  document.body.appendChild(el);
  el.querySelector('.help-modal-close')?.focus();
}

function closeHelp() {
  document.querySelector('.help-modal')?.remove();
}

/* ================================================================
   APP INIT
   ================================================================ */
// Recover any stale study session left running from a previous visit
function recoverStaleSession() {
  const a = S.activeSession();
  if (!a) return;

  const lastTick = Number(localStorage.getItem('pvp_last_tick'));
  if (lastTick) {
    const gap = Date.now() - lastTick;
    if (gap > 180000) { // more than 3 minutes gap
      console.log(`Recovered stale session retrospectively using heartbeat tick (${Math.round(gap/1000)}s gap)`);
      S.stopSession(lastTick);
      return;
    }
  }

  const MAX_SESSION_MINS = 240; // 4 hour cap
  const elapsedMins = Math.round((Date.now() - new Date(a.start).getTime()) / 60000);
  if (elapsedMins > MAX_SESSION_MINS) {
    // Session was left running too long — auto-stop it with capped duration
    const mins = MAX_SESSION_MINS;
    const ss = S.sessions();
    const sessionDate = dateKey(new Date(a.start)); // use the local date it was started
    ss.push({id:uid(), date:sessionDate, start:a.start, end:new Date().toISOString(), mins});
    S.s('pvp_sessions', ss);
    S.s('pvp_active', null);
    localStorage.removeItem('pvp_last_tick');
    console.log(`Recovered stale session (${elapsedMins}min elapsed, capped to ${mins}min)`);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) {
      const view = event.target.closest('[data-view]')?.dataset.view;
      if (view) navigate(view);
      return;
    }
    if (action === 'pick-folder') pickFolder(false);
    if (action === 'fallback-mode') useFallbackMode();
    if (action === 'restore-permission') restorePermission();
    if (action === 'data-status') handleDataStatusClick();
    if (action === 'show-help') showHelp();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const dialog = document.querySelector('.backup-preview');
      if (dialog) { dialog.remove(); $('settings-import-input')?.focus(); }
      closeHelp();
    }
  });
  initDate();
  recoverStaleSession();

  const state = await DM.init();

  if (state === 'setup') {
    // First time — show setup overlay
    $('setup-overlay').classList.remove('hidden');
  } else if (state === 'ready') {
    // Auto-restored (permission already granted)
    $('setup-overlay').classList.add('hidden');
    $('restore-banner').classList.add('hidden');
    renderView('dashboard');
    updateScore();
  } else if (state === 'restore') {
    // Has a stored handle but needs a user gesture for permission.
    // Skip the banner — just load from localStorage and silently
    // reconnect file saving on the user's first click.
    $('setup-overlay').classList.add('hidden');
    $('restore-banner').classList.add('hidden');
    renderView('dashboard');
    updateScore();
    DM.setStatus('browser', 'Reconnecting…', 'Click anywhere');

    // One-shot: on first user interaction, silently request permission
    let restorePending = true;
    let restoreTimeout;
    const finishFallback = (message = 'File access unavailable') => {
      if (!restorePending) return;
      restorePending = false;
      clearTimeout(restoreTimeout);
      document.removeEventListener('click', silentRestore, true);
      document.removeEventListener('keydown', silentRestore, true);
      DM.fallback = true;
      DM.setStatus('browser', 'Browser storage', message);
    };
    const silentRestore = async () => {
      if (!restorePending) return;
      document.removeEventListener('click', silentRestore, true);
      document.removeEventListener('keydown', silentRestore, true);
      try {
        const ok = await DM.requestPermission();
        if (!ok) { finishFallback('File access denied · using browser storage'); return; }
        await DM.loadAll();
        restorePending = false;
        clearTimeout(restoreTimeout);
        DM.setConnectedStatus(DM.dirHandle.name);
        refreshView();
      } catch (error) {
        console.warn('Reconnect failed:', error);
        finishFallback('Reconnect failed · using browser storage');
      }
    };
    document.addEventListener('click', silentRestore, true);
    document.addEventListener('keydown', silentRestore, true);
    restoreTimeout = setTimeout(() => finishFallback('Reconnect timed out · using browser storage'), 8000);
  } else {
    // Fallback mode
    $('setup-overlay').classList.add('hidden');
    renderView('dashboard');
    updateScore();
  }

  setInterval(updateScore, 30000);

  /* ── AUTO-STOP TIMER ON TAB CLOSE / LAPTOP SLEEP ─────────────── */
  // Fires when the tab or browser window is closed.
  window.addEventListener('beforeunload', () => {
    if (S.activeSession()) {
      S.stopSession();
    }
    DM.flushAll();
  });

  window.addEventListener('pagehide', () => {
    DM.flushAll();
  });

  // Check heartbeat on visibility change to catch sleep/wake cycles instantly.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      DM.flushAll();
      return;
    }
    if (document.visibilityState === 'visible' && S.activeSession()) {
      const lastTick = Number(localStorage.getItem('pvp_last_tick'));
      if (lastTick) {
        const gap = Date.now() - lastTick;
        if (gap > 180000) { // more than 3 minutes gap
          console.log(`Study timer gap detected on wake (${Math.round(gap/1000)}s). Retrospectively stopping session.`);
          S.stopSession(lastTick);
          if (curView === 'study') {
            clearInterval(timerIv);
            timerIv = null;
            refreshView();
          }
          updateScore();
        }
      }
    }
  });

  // Global background heartbeat tick for the study timer.
  // Updates the last tick timestamp every 10 seconds. If a large gap is detected (e.g. sleep/freeze),
  // stops the session retrospectively at the last heartbeat timestamp.
  setInterval(() => {
    const a = S.activeSession();
    if (!a) return;
    
    const now = Date.now();
    const lastTick = Number(localStorage.getItem('pvp_last_tick') || now);
    const gap = now - lastTick;
    
    if (gap > 180000) { // 3 minutes gap
      console.log(`Study timer gap detected via heartbeat (${Math.round(gap/1000)}s). Retrospectively stopping session.`);
      S.stopSession(lastTick);
      if (curView === 'study') {
        clearInterval(timerIv);
        timerIv = null;
        refreshView();
      }
      updateScore();
    } else {
      localStorage.setItem('pvp_last_tick', String(now));
    }
  }, 10000);

  /* ── DRAG AND DROP ───────────────────────────────────────── */
  // Create a persistent drop indicator line element
  const dropIndicator = document.createElement('div');
  dropIndicator.id = 'drop-indicator';
  document.body.appendChild(dropIndicator);

  let activeDragType  = null;
  let activeDragId    = null;
  let activeParentId  = null;
  let activeProjectId = null;
  // Stores the resolved drop target: { el, after }
  let dropTarget = null;

  function showIndicator(refEl, after) {
    const rect = refEl.getBoundingClientRect();
    const y = (after ? rect.bottom : rect.top) + window.scrollY;
    dropIndicator.style.display = 'block';
    dropIndicator.style.top   = (y - 1) + 'px';
    dropIndicator.style.left  = (rect.left + window.scrollX) + 'px';
    dropIndicator.style.right = 'auto';
    dropIndicator.style.width = rect.width + 'px';
  }

  // Only hides the visual line — does NOT clear dropTarget
  function hideIndicatorLine() {
    dropIndicator.style.display = 'none';
  }

  function hideIndicator() {
    dropIndicator.style.display = 'none';
    dropTarget = null;
  }

  document.addEventListener('dragstart', (e) => {
    const projectSubtaskItem = e.target.closest('[data-type="project-subtask"]');
    const projectTaskContainer = e.target.closest('[data-type="project-task"]');
    const subtaskItem   = e.target.closest('[data-type="subtask"]');
    const taskContainer = e.target.closest('[data-type="task"]');
    const ideaCard      = e.target.closest('[data-type="idea"]');

    if (projectSubtaskItem) {
      activeDragType = 'project-subtask';
      activeDragId   = projectSubtaskItem.dataset.subtaskId;
      activeParentId = projectSubtaskItem.dataset.parentId;
      activeProjectId = projectSubtaskItem.dataset.projectId;
      setTimeout(() => projectSubtaskItem.classList.add('dragging'), 0);
    } else if (projectTaskContainer) {
      activeDragType = 'project-task';
      activeDragId   = projectTaskContainer.dataset.taskId;
      activeProjectId = projectTaskContainer.dataset.projectId;
      setTimeout(() => projectTaskContainer.classList.add('dragging'), 0);
    } else if (subtaskItem) {
      activeDragType = 'subtask';
      activeDragId   = subtaskItem.dataset.subtaskId;
      activeParentId = subtaskItem.dataset.parentId;
      // Defer adding the class so the browser can capture the ghost first
      setTimeout(() => subtaskItem.classList.add('dragging'), 0);
    } else if (taskContainer) {
      activeDragType = 'task';
      activeDragId   = taskContainer.dataset.taskId;
      setTimeout(() => taskContainer.classList.add('dragging'), 0);
    } else if (ideaCard) {
      activeDragType = 'idea';
      activeDragId   = ideaCard.dataset.ideaId;
      setTimeout(() => ideaCard.classList.add('dragging'), 0);
    } else {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', activeDragId);
  });

  document.addEventListener('dragover', (e) => {
    if (!activeDragType) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTarget = null;

    if (activeDragType === 'project-task') {
      let el = e.target;
      while (el && el !== document.body) {
        if (el.dataset && el.dataset.type === 'project-task'
            && el.dataset.projectId === activeProjectId
            && el.dataset.taskId !== activeDragId) {
          const rect  = el.getBoundingClientRect();
          const after = (e.clientY - rect.top) > (rect.height / 2);
          dropTarget  = { el, after, projectId: activeProjectId };
          showIndicator(el, after);
          return;
        }
        el = el.parentElement;
      }
      const taskList = e.target.closest(`.task-list[data-project-id="${activeProjectId}"]`);
      if (taskList) {
        const children = taskList.querySelectorAll('[data-type="project-task"]');
        if (children.length > 0) {
          const lastChild = children[children.length - 1];
          if (lastChild.dataset.taskId !== activeDragId) {
            dropTarget = { el: lastChild, after: true, projectId: activeProjectId };
            showIndicator(lastChild, true);
            return;
          }
        }
      }
      hideIndicator();

    } else if (activeDragType === 'project-subtask') {
      let el = e.target;
      while (el && el !== document.body) {
        if (el.dataset && el.dataset.type === 'project-subtask'
            && el.dataset.projectId === activeProjectId
            && el.dataset.parentId === activeParentId
            && el.dataset.subtaskId !== activeDragId) {
          const rect  = el.getBoundingClientRect();
          const after = (e.clientY - rect.top) > (rect.height / 2);
          dropTarget  = { el, after, projectId: activeProjectId, parentId: activeParentId };
          showIndicator(el, after);
          return;
        }
        el = el.parentElement;
      }
      const subtaskList = e.target.closest(`.subtasks-list[data-project-id="${activeProjectId}"][data-parent-id="${activeParentId}"]`);
      if (subtaskList) {
        const children = subtaskList.querySelectorAll('[data-type="project-subtask"]');
        if (children.length > 0) {
          const lastChild = children[children.length - 1];
          if (lastChild.dataset.subtaskId !== activeDragId) {
            dropTarget = { el: lastChild, after: true, projectId: activeProjectId, parentId: activeParentId };
            showIndicator(lastChild, true);
            return;
          }
        }
      }
      hideIndicator();

    } else if (activeDragType === 'task') {
      // Walk up from the hovered element to find a task-container
      let el = e.target;
      while (el && el !== document.body) {
        if (el.dataset && el.dataset.type === 'task' && el.dataset.taskId !== activeDragId) {
          const rect  = el.getBoundingClientRect();
          const after = (e.clientY - rect.top) > (rect.height / 2);
          dropTarget  = { el, after };
          showIndicator(el, after);
          return;
        }
        el = el.parentElement;
      }
      // Fallback: hovering the task-list container itself
      const taskList = e.target.closest('.task-list');
      if (taskList) {
        const children = taskList.querySelectorAll('[data-type="task"]');
        if (children.length > 0) {
          const lastChild = children[children.length - 1];
          if (lastChild.dataset.taskId !== activeDragId) {
            dropTarget = { el: lastChild, after: true };
            showIndicator(lastChild, true);
            return;
          }
        }
      }
      hideIndicator();

    } else if (activeDragType === 'subtask') {
      let el = e.target;
      while (el && el !== document.body) {
        if (el.dataset && el.dataset.type === 'subtask'
            && el.dataset.parentId === activeParentId
            && el.dataset.subtaskId !== activeDragId) {
          const rect  = el.getBoundingClientRect();
          const after = (e.clientY - rect.top) > (rect.height / 2);
          dropTarget  = { el, after };
          showIndicator(el, after);
          return;
        }
        el = el.parentElement;
      }
      // Fallback: hovering the subtasks-list container of the same parent task
      const subtaskList = e.target.closest(`.subtasks-list[data-parent-id="${activeParentId}"]`);
      if (subtaskList) {
        const children = subtaskList.querySelectorAll('[data-type="subtask"]');
        if (children.length > 0) {
          const lastChild = children[children.length - 1];
          if (lastChild.dataset.subtaskId !== activeDragId) {
            dropTarget = { el: lastChild, after: true };
            showIndicator(lastChild, true);
            return;
          }
        }
      }
      hideIndicator();

    } else if (activeDragType === 'idea') {
      const column = e.target.closest('.ideas-column');
      if (!column) { hideIndicator(); return; }
      document.querySelectorAll('.ideas-column').forEach(c => c.classList.remove('drag-over'));
      column.classList.add('drag-over');

      // Find which idea card we're hovering over
      let el = e.target;
      while (el && el !== column) {
        if (el.dataset && el.dataset.type === 'idea' && el.dataset.ideaId !== activeDragId) {
          const rect  = el.getBoundingClientRect();
          const after = (e.clientY - rect.top) > (rect.height / 2);
          dropTarget  = { el, after, columnId: column.dataset.columnId };
          showIndicator(el, after);
          return;
        }
        el = el.parentElement;
      }
      // Hovering the column itself (no card under cursor) — drop at end
      dropTarget = { el: null, after: true, columnId: column.dataset.columnId };
      hideIndicatorLine();
    }
  });

  document.addEventListener('dragleave', (e) => {
    if (activeDragType === 'idea') {
      const column = e.target.closest('.ideas-column');
      if (column && !column.contains(e.relatedTarget)) {
        column.classList.remove('drag-over');
        hideIndicatorLine(); // hide visual only, keep dropTarget
      }
    }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!activeDragType) return;

    // Snapshot dropTarget BEFORE hiding (hideIndicator would null it)
    const resolved = dropTarget;
    hideIndicatorLine();
    document.querySelectorAll('.ideas-column').forEach(c => c.classList.remove('drag-over'));

    if (activeDragType === 'project-task' && resolved) {
      const targetId = resolved.el.dataset.taskId;
      S.reorderProjectTasks(resolved.projectId, activeDragId, targetId, resolved.after);
      refreshView();

    } else if (activeDragType === 'project-subtask' && resolved) {
      const targetSubId = resolved.el.dataset.subtaskId;
      S.reorderProjectSubtasks(resolved.projectId, resolved.parentId, activeDragId, targetSubId, resolved.after);
      refreshView();

    } else if (activeDragType === 'task' && resolved) {
      const targetId = resolved.el.dataset.taskId;
      reorderTasks(activeDragId, targetId, resolved.after);
      refreshView();

    } else if (activeDragType === 'subtask' && resolved) {
      const targetSubId = resolved.el.dataset.subtaskId;
      reorderSubtasks(activeParentId, activeDragId, targetSubId, resolved.after);
      refreshView();

    } else if (activeDragType === 'idea' && resolved) {
      const targetSiblingId = resolved.el ? resolved.el.dataset.ideaId : null;
      await reorderIdeas(activeDragId, resolved.columnId, targetSiblingId, resolved.after);
      refreshView();
    }
  });

  document.addEventListener('dragend', () => {
    hideIndicator();
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.ideas-column').forEach(el => el.classList.remove('drag-over'));
    activeDragType  = null;
    activeDragId    = null;
    activeParentId  = null;
    activeProjectId = null;
  });
});
