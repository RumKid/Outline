(function (root) {
  function install(store, { uid, auth }) {
    Object.assign(store, {
      projects() {
        const list = this.g('pvp_projects') || [];
        return list.map(project => ({
          tasks: [], status: 'active', ...project,
          tasks: (Array.isArray(project.tasks) ? project.tasks : []).map(task => ({
            ...task,
            status: task.done ? 'done' : ['backlog', 'todo', 'in-progress'].includes(task.status) ? task.status : 'backlog'
          }))
        }));
      },
      async addProject(project) {
        const copy = { ...project, status: project.status || 'active', tasks: Array.isArray(project.tasks) ? project.tasks : [] };
        copy.title = await auth.encryptField(copy.title);
        if (copy.description) copy.description = await auth.encryptField(copy.description);
        const list = this.projects(); list.push(copy); this.s('pvp_projects', list);
      },
      async updateProject(id, updates) {
        const list = this.projects(); const index = list.findIndex(project => project.id === id);
        if (index === -1) return;
        const next = { ...list[index], ...updates };
        if (typeof updates.title === 'string') next.title = await auth.encryptField(updates.title);
        if (updates.description !== undefined) next.description = updates.description ? await auth.encryptField(updates.description) : '';
        list[index] = next; this.s('pvp_projects', list);
      },
      delProject(id) { this.s('pvp_projects', this.projects().filter(project => project.id !== id)); },
      async addProjectTask(projectId, title, priority = 'medium') {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        project.tasks = Array.isArray(project.tasks) ? project.tasks : [];
        project.tasks.push({ id: uid(), title: await auth.encryptField(title), priority, status: 'backlog', done: false, subtasks: [], createdAt: new Date().toISOString() });
        this.s('pvp_projects', list);
      },
      toggleProjectTask(projectId, taskId) {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        project.tasks = (project.tasks || []).map(task => {
          if (task.id !== taskId) return task;
          const done = !task.done;
          return { ...task, status: done ? 'done' : 'backlog', done, subtasks: (task.subtasks || []).map(subtask => ({ ...subtask, done })) };
        }); this.s('pvp_projects', list);
      },
      delProjectTask(projectId, taskId) {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        project.tasks = (project.tasks || []).filter(task => task.id !== taskId); this.s('pvp_projects', list);
      },
      setProjectTaskStatus(projectId, taskId, status) {
        if (!['backlog', 'todo', 'in-progress', 'done'].includes(status)) return;
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        project.tasks = (project.tasks || []).map(task => task.id === taskId ? { ...task, status, done: status === 'done', subtasks: status === 'done' ? (task.subtasks || []).map(subtask => ({ ...subtask, done: true })) : task.subtasks } : task);
        this.s('pvp_projects', list);
      },
      async addProjectSubtask(projectId, parentTaskId, title) {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        const parent = (project.tasks || []).find(task => task.id === parentTaskId); if (!parent) return;
        parent.subtasks = Array.isArray(parent.subtasks) ? parent.subtasks : [];
        parent.subtasks.push({ id: uid(), title: await auth.encryptField(title), done: false }); parent.done = false; this.s('pvp_projects', list);
      },
      toggleProjectSubtask(projectId, parentTaskId, subtaskId) {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        const parent = (project.tasks || []).find(task => task.id === parentTaskId); if (!parent) return;
        parent.subtasks = (parent.subtasks || []).map(subtask => subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask);
        parent.done = parent.subtasks.length > 0 ? parent.subtasks.every(subtask => subtask.done) : parent.done; this.s('pvp_projects', list);
      },
      delProjectSubtask(projectId, parentTaskId, subtaskId) {
        const list = this.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
        const parent = (project.tasks || []).find(task => task.id === parentTaskId); if (!parent) return;
        parent.subtasks = (parent.subtasks || []).filter(subtask => subtask.id !== subtaskId);
        parent.done = parent.subtasks.length > 0 ? parent.subtasks.every(subtask => subtask.done) : parent.done; this.s('pvp_projects', list);
      },
      reorderProjectTasks(projectId, draggedTaskId, targetTaskId, after) { reorder(this, projectId, draggedTaskId, targetTaskId, after, false); },
      reorderProjectSubtasks(projectId, parentTaskId, draggedSubId, targetSubId, after) { reorder(this, projectId, draggedSubId, targetSubId, after, true, parentTaskId); }
    });
    return store;
  }
  function reorder(store, projectId, draggedId, targetId, after, subtasks, parentId) {
    const list = store.projects(); const project = list.find(item => item.id === projectId); if (!project) return;
    const parent = subtasks ? (project.tasks || []).find(task => task.id === parentId) : project;
    const items = subtasks ? parent?.subtasks : project.tasks; if (!items) return;
    const dragged = items.find(item => item.id === draggedId); if (!dragged) return;
    const remaining = items.filter(item => item.id !== draggedId); const target = remaining.findIndex(item => item.id === targetId);
    remaining.splice(target === -1 ? remaining.length : target + (after ? 1 : 0), 0, dragged);
    if (subtasks) parent.subtasks = remaining; else project.tasks = remaining; store.s('pvp_projects', list);
  }
  root.OutlineProjects = { install }; if (root !== globalThis) globalThis.OutlineProjects = root.OutlineProjects;
})(typeof window === 'object' ? window : globalThis);
