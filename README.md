# Outline

Outline is a local-first personal manager for tasks, habits, water, study, sleep, journal, projects, and wealth. It has no accounts, server, analytics, or online runtime dependencies.

## Features

- Today dashboard, daily tasks, subtasks, next-day task moves, and weekly task view.
- Personal Jira-style project boards with project tasks, subtasks, statuses, and progress.
- Study timer and session history, habits, hydration, sleep, journal, and ideas.
- Wealth accounts, add-money actions, transactions, transfers, budgets, and summaries.
- Optional AES-256 encrypted vault with locked writes and password rotation.
- Durable file saves with rotating backups and recovery.
- Browser-storage fallback with rotating backups plus JSON export/import.

## Running

Open `index.html` directly in a modern browser. For file-backed storage, choose a data folder when prompted. If the File System Access API is unavailable, choose browser storage instead.

For development checks:

```bash
npm test
node --check app.js
npm run test:e2e
```

The test suite covers local dates, offline behavior, rendering smoke tests, escaping, task/project/wealth behavior, encryption, durable saves, backups, schema handling, and fallback recovery.

## Data and privacy

File mode stores `outline-data.json` and `outline-journal.json` in the selected folder, with rotating backup files. Browser mode stores data in this browser's `localStorage`; use **Export backup** regularly. Setting a password encrypts personal data locally with Web Crypto. No data is uploaded by Outline.

## Task model

Personal Tasks and Project Tasks are separate contexts. Personal Tasks are stored in the top-level pvp_tasks store and are organized around dates and daily focus. Project Tasks are stored inside their owning project in pvp_projects and use the project board statuses backlog, todo, in-progress, and done. They share interaction patterns such as compact rows, subtasks, and task details, but one type is never automatically converted into or assigned to the other.

Task detail metadata is optional for compatibility with existing data. Personal Tasks use their existing date plus optional notes, due time, and estimated minutes. Project Tasks use optional notes, due date, due time, and estimated minutes while retaining their project status. All edits continue through the existing local storage cache and file-backed save pipeline.

Recurring Personal Tasks keep each completed occurrence as history and create one next occurrence when completed. Daily, weekday, weekly, and custom weekday schedules are supported. Completing an overdue occurrence schedules the next occurrence after today, preventing a backlog of missed copies. The recurrence settings are copied to the next occurrence; editing a completed occurrence does not rewrite prior history, and subtasks are copied as incomplete. Recurrence is not available for Project Tasks.

## Recovery tools

Use **Export backup** before moving browsers or resetting data. **Import backup** restores a browser-mode JSON export. **Diagnostics** shows the active storage mode and approximate local store size. **Reset data** permanently deletes Outline data from the current browser after confirmation.

## CI

GitHub Actions runs the test suite, JavaScript syntax check, and whitespace validation on pushes and pull requests.
