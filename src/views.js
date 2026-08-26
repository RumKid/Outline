(function (root) {
  function registry(renderers) {
    return {
      sync: {
        habits: renderers.vHabits,
        water: renderers.vWater,
        study: renderers.vStudy,
        sleep: renderers.vSleep
      },
      async: {
        journal: renderers.vJournal,
        ideas: renderers.vIdeas,
        dashboard: renderers.vDashboard,
        tasks: renderers.vTasks,
        projects: renderers.vProjects,
        wealth: renderers.vWealth,
        settings: renderers.vSettings
      }
    };
  }

  root.OutlineViews = { registry };
  if (root !== globalThis) globalThis.OutlineViews = root.OutlineViews;
})(typeof window === 'object' ? window : globalThis);
