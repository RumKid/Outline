(function (root) {
  function install(store, { today, uid, auth }) {
    Object.assign(store, {
      tasks() {
        const list = this.g('pvp_tasks') || [];
        const currentDate = today();
        let changed = false;
        const updated = list.map(task => {
          let changedTask = false;
          if (!task.subtasks) { task.subtasks = []; changedTask = true; }
          if (!task.done && task.date < currentDate) { task.date = currentDate; changedTask = true; }
          if (changedTask) changed = true;
          return task;
        });
        if (changed) this.s('pvp_tasks', updated);
        return updated;
      },
      async addTask(task) {
        task.title = await auth.encryptField(task.title);
        const tasks = this.tasks();
        tasks.push(task);
        this.s('pvp_tasks', tasks);
      },
      toggleTask(id) {
        this.s('pvp_tasks', this.tasks().map(task => {
          if (task.id !== id) return task;
          const done = !task.done;
          return { ...task, done, subtasks: (task.subtasks || []).map(subtask => ({ ...subtask, done })) };
        }));
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
