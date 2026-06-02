# Outline

A minimal, local-first productivity dashboard. It has a high-contrast dark theme, daily focus tracking, and keeps your data completely offline.

This project was fully **vibe coded** with an AI assistant.

Live demo: [rumkid.github.io/Outline](https://rumkid.github.io/Outline/)

---

## How it works

Instead of syncing to a database or uploading your logs to the cloud, Outline reads and writes your data directly on your computer's local drive as a single JSON file (`outline-data.json`). It uses the browser's native File System Access API to do this.

None of your tracking data is uploaded or tracked in this Git repository.

## Features

- Grayscale dashboard with monospace values.
- Focus lists & habit streak tracking.
- Study session timer.
- Hydration & sleep logs.
- Daily Intention (focus checklist).
- Weekly Review (current week vs previous week stats and trend comparisons).

## Setup

1. Open [rumkid.github.io/Outline](https://rumkid.github.io/Outline/) in your browser.
2. Select a folder on your machine where you want your data to live.
3. That's it. Everything runs client-side in the browser.
