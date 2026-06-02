# Outline 🔳

A beautiful, minimalist, local-first personal productivity dashboard. Designed for high focus, deep tracking, and absolute data privacy.

Live URL: **[rumkid.github.io/Outline](https://rumkid.github.io/Outline/)**

---

## Key Features

- **🔳 Minimal Monochromatic Design:** High-contrast grayscale aesthetic using typography tailored for legibility (Outfit, Plus Jakarta Sans) and tabular data tracking (JetBrains Mono).
- **🔒 Local-First Privacy:** Saves your tracking metrics as a raw JSON file directly in a local directory of your choice on your system (utilizing the File System Access API). Your data never touches the cloud.
- **📈 Weekly Performance Review:** Automatically aggregates statistics for the current week and compares them against the previous week (Daily Score, Habit completion rate, Study duration, Sleep, and Hydration) with visual trend indicators (`▲` / `▼`).
- **🎯 Daily Intention:** Set a single, primary objective every morning to maintain distraction-free alignment.
- **⏱ Study Timer:** A focus stopwatch to record your active study or deep work blocks.
- **💧 Hydration & 🌙 Sleep Logs:** Easy logging interfaces for daily water intake and sleep durations.
- **🔥 Habits & ☑️ Tasks:** Interactive widgets to checklist daily tasks and streak habits.

---

## Technical Details

- **Vanilla Stack:** Built with pure HTML, Javascript, and standard CSS rules (no heavy node packages or builds).
- **ChartJS:** Clean monochrome data visualization.
- **No Tracking/Cookies:** Zero cookies, telemetry, or server-side sync trackers.

---

## Setup & Running

1. Simply clone the repository or open the live website at **[rumkid.github.io/Outline](https://rumkid.github.io/Outline/)**.
2. Click **Select Data Folder** and choose a folder on your local machine (e.g. `/Desktop/MyOwnTaskManager/data`).
3. Outline will create and maintain your data inside `outline-data.json` inside that folder.

*Note: Your personal logging data folder (`data/`) is ignored by Git, ensuring your commits stay clean and your data stays private.*
