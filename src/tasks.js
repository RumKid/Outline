(function (root) {
  function install(store, { today, uid, auth }) {
    const recurrenceTypes = new Set(['daily', 'weekdays', 'weekly', 'custom']);
    function normalizeRecurrence(value) {
      if (!value || typeof value !== 'object' || !recurrenceTypes.has(value.type)) return null;
      const days = Array.isArray(value.days) ? [...new Set(value.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b) : [];
      if (value.type === 'custom' && days.length === 0) return null;
      return { type: value.type, days };
    }
    function nextRecurringDate(date, recurrence, currentDate) {
      const normalized = normalizeRecurrence(recurrence);
      if (!normalized || !date) return null;
      const start = new Date(`${date < currentDate ? currentDate : date}T12:00:00`);
      for (let offset = 1; offset <= 370; offset++) {
        const candidate = new Date(start);
        candidate.setDate(candidate.getDate() + offset);
        const day = candidate.getDay();
        const matches = normalized.type === 'daily'
          || (normalized.type === 'weekdays' && day >= 1 && day <= 5)
          || (normalized.type === 'weekly' && day === new Date(`${date}T12:00:00`).getDay())
          || (normalized.type === 'custom' && normalized.days.includes(day));
        if (matches) return candidate.toISOString().slice(0, 10);
      }
      return null;
    }
    function makeNextOccurrence(task, currentDate) {
      const recurrence = normalizeRecurrence(task.recurrence);
      const nextDate = nextRecurringDate(task.date, recurrence, currentDate);
      if (!nextDate) return null;
      return {
        ...task,
        id: uid(),
        seriesId: task.seriesId || task.id,
        date: nextDate,
        done: false,
        subtasks: (task.subtasks || []).map(subtask => ({ ...subtask, id: uid(), done: false })),
        createdAt: new Date().toISOString()
      };
    }
    Object.assign(store, {
      tasks() {
        const list = this.g('pvp_tasks') || [];
        return list.map(task => ({ ...task, subtasks: Array.isArray(task.subtasks) ? task.subtasks : [] }));
      },
      async addTask(task) {
        task.title = await auth.encryptField(task.title);
        const tasks = this.tasks();
        tasks.push(task);
        this.s('pvp_tasks', tasks);
      },
      async updateTask(id, updates) {
        const tasks = this.tasks();
        const index = tasks.findIndex(task => task.id === id);
        if (index === -1 || !updates || typeof updates !== 'object') return false;
        const next = { ...updates };
        if (typeof next.title === 'string') {
          next.title = await auth.encryptField(next.title.trim());
          if (!next.title) return false;
        }
        if (typeof next.notes === 'string') next.notes = await auth.encryptField(next.notes);
        if (next.priority !== undefined && !['high', 'medium', 'low'].includes(next.priority)) return false;
        if (next.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) return false;
        if (next.dueTime !== undefined && next.dueTime !== '' && !/^\d{2}:\d{2}$/.test(next.dueTime)) return false;
        if (next.estimateMinutes !== undefined && next.estimateMinutes !== '' && (!Number.isFinite(Number(next.estimateMinutes)) || Number(next.estimateMinutes) < 0)) return false;
        if (next.recurrence !== undefined) {
          next.recurrence = next.recurrence ? normalizeRecurrence(next.recurrence) : null;
          if (updates.recurrence && !next.recurrence) return false;
        }
        tasks[index] = { ...tasks[index], ...next };
        this.s('pvp_tasks', tasks);
        return true;
      },
      toggleTask(id) {
        const tasks = this.tasks();
        let completedTask = null;
        const updated = tasks.map(task => {
          if (task.id !== id) return task;
          const done = !task.done;
          const next = { ...task, done, subtasks: (task.subtasks || []).map(subtask => ({ ...subtask, done })) };
          if (done && task.recurrence) completedTask = next;
          return next;
        });
        if (completedTask) {
          const nextOccurrence = makeNextOccurrence(completedTask, today());
          if (nextOccurrence && !updated.some(task => task.seriesId === nextOccurrence.seriesId && task.date === nextOccurrence.date)) {
            updated.push(nextOccurrence);
          }
        }
        this.s('pvp_tasks', updated);
      },
      moveTaskToDate(id, date) {
        this.s('pvp_tasks', this.tasks().map(task => task.id === id ? { ...task, date } : task));
      },
      delTask(id) {
        this.s('pvp_tasks', this.tasks().filter(task => task.id !== id));
      },
      async addSubtask(parentId, title) {
        const encryptedTitle = await auth.encryptField(title);
        this.s('pvp_tasks', this.tasks().map(task => {
          if (task.id !== parentId) return task;
          const subtasks = task.subtasks || [];
          subtasks.push({ id: uid(), title: encryptedTitle, done: false });
          return { ...task, subtasks, done: false };
        }));
      },
      toggleSubtask(parentId, subtaskId) {
        this.s('pvp_tasks', this.tasks().map(task => {
          if (task.id !== parentId) return task;
          const subtasks = (task.subtasks || []).map(subtask => subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask);
          return { ...task, subtasks, done: subtasks.every(subtask => subtask.done) };
        }));
      },
      delSubtask(parentId, subtaskId) {
        this.s('pvp_tasks', this.tasks().map(task => {
          if (task.id !== parentId) return task;
          const subtasks = (task.subtasks || []).filter(subtask => subtask.id !== subtaskId);
          const done = subtasks.length > 0 ? subtasks.every(subtask => subtask.done) : task.done;
          return { ...task, subtasks, done };
        }));
      }
    });
    return store;
  }

  root.OutlineTasks = { install };
  if (root !== globalThis) globalThis.OutlineTasks = root.OutlineTasks;
})(typeof window === 'object' ? window : globalThis);
