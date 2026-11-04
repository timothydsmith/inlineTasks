# Changelog

All notable changes to Inline Tasks for Todoist are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Add new entries under **Unreleased** as you work on `dev`, grouped as Added, Changed, Fixed or Removed. When you release, rename **Unreleased** to the version and date, and start a fresh **Unreleased** section above it. The full steps are in the README under [Branches and releases](README.md#branches-and-releases).

## [Unreleased]

## [0.1.0] - 2026-11-04

First release. Needs Obsidian 1.8.7 or later.

### Added
- Two-way sync between every open checkbox in the vault and Todoist, using the unified API v1 `/sync` endpoint. Syncs task text, completion and due date (`📅 YYYY-MM-DD`).
- When both sides edited the same field, the most recent edit wins.
- Hidden `%%td:<id>%%` marker on each synced line. A pending `%%td:new-<uuid>%%` marker and an idempotent command id make creation safe against crashes and retries.
- Inline chip in live preview and reading view, showing project, due date, recurrence, priority and labels. Clicking it opens the task in Todoist.
- Exclusions by folder or note path, by `todoist: false` frontmatter, and by `#notodoist` on a line. Code blocks, empty checkboxes and already-ticked checkboxes are never synced.
- Folder → project mapping and `todoist_project:` frontmatter. Everything else goes to the Inbox.
- `#[Project name]` on a checkbox line files the task in that project: a new task is created there, and a synced task is moved. A missing project is created. The reference is removed from the line once applied, since the chip shows the project.
- Typing `#[` on a checkbox line opens a menu of Todoist projects to pick from, or offers to create a new one. Ordinary `#tags` keep Obsidian's tag suggestions.
- First-run backfill preview, grouped by folder. Sync stays paused until you confirm.
- Nothing is ever deleted: removing a line unlinks the task, and a task deleted in Todoist shows as a struck-through chip.
- Multi-device safety with Obsidian Sync: each device pushes changes typed in its own editor straight away, and waits 2 minutes before pushing changes that arrived from another device or app. This stops duplicate tasks, and half-typed lines from another device being created.
- New checkboxes that arrive from another device or app are created only by devices with **Create tasks for changes from other devices or apps** on (desktop by default, not mobile), so a note written by a script or agent is created once.
- Each device keeps its own sync state in local storage, so Obsidian Sync can't make devices overwrite each other's. `data.json` holds only settings and whether the backfill was confirmed. A device with no sync state links the markers already in the vault; a task linked on another device gets its project and due date fetched.
- Per-device **This device creates tasks** setting, as a fallback for Obsidian Sync setups.
- Commands: **Sync now**, **Sync current note**, **Review backfill of existing checkboxes**, **Save sync log to a note**.
- Works on mobile as well as desktop: uses only Obsidian's `requestUrl`, with no Node APIs. Tested on Android; not yet on iOS.

[Unreleased]: https://github.com/timothydsmith/inlineTasks/compare/0.1.0...dev
[0.1.0]: https://github.com/timothydsmith/inlineTasks/releases/tag/0.1.0
