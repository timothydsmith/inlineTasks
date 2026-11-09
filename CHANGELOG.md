# Changelog

All notable changes to Inline Tasks for Todoist are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Add new entries under **Unreleased** as you work on `dev`, grouped as Added, Changed, Fixed or Removed. When you release, rename **Unreleased** to the version and date, and start a fresh **Unreleased** section above it. The full steps are in the README under [Branches and releases](README.md#branches-and-releases).

## [Unreleased]

### Added
- Tasks plugin fields stay on the line and out of the Todoist title: `⏳ 🛫 ➕ ✅ ❌` dates, `🔁` repeats, the priorities `🔺 ⏫ 🔼 🔽 ⏬`, `🆔`, `⛔`, `🏁`, and a `^block-link` at the end. Tasks' other spellings of the due date, `📆` and `🗓`, are read as `📅`.
- **Write Tasks plugin fields** setting, off by default. When on:
  - Each task's Todoist priority is written on its line as a Tasks priority (🔺 p1, ⏫ p2, 🔼 p3, nothing for p4), and changing either one changes the other.
  - `p1`–`p4` typed on a line, or a priority picked on the chip, becomes the Tasks priority.
  - A task completed in Todoist gets `✅` and the date it was completed, and one ticked in the note gets today's date. Unticking removes the date.
  - Imported tasks come with their priority.
- **Projects and labels note** setting, off by default. When on, the plugin keeps a note listing your Todoist projects and labels, how to write a line that files a task in them, and your folder mappings and excluded folders, so agents and scripts can add tasks to your notes without a Todoist connection of their own. It's rewritten whenever a sync changes it. It goes in the vault's config folder (`.obsidian/todoist-projects-and-labels.md`) unless you set another location.

### Changed
- The `%%td:…%%` marker goes after the task's text and before its dates and other fields, so the Tasks plugin can read them. Each device moves the marker on existing lines once, the first time it starts this version.
- Only `[x]`, `[X]` and `[-]` (cancelled) complete the Todoist task. Other statuses, such as Tasks' `[/]` (in progress), leave it open and are kept on the line. New tasks are made from `[ ]` and `[/]` lines only.

## [0.3.0] - 2026-11-06

### Added
- `p1`–`p4` on a checkbox line sets the task's Todoist priority, on create or later (`p4` clears it). The word is removed from the line once applied, since the chip shows the priority.
- Due dates in words: `today`, `tomorrow`, weekdays, `next friday`, `next week`, `every month` and other repeats, and `15/11`. Todoist works out the date, and the words are replaced on the line by `📅 YYYY-MM-DD`. `every …` makes a repeating task.
- **Import task from Todoist** command: search your open Todoist tasks and insert one at the cursor, optionally with its open subtasks indented beneath it. The lines are linked straight away and sync both ways.
- **Import subtasks** setting: ask each time (the default), always import or never import a task's subtasks.
- A new checkbox nested under another checkbox is created as its subtask in Todoist, in the parent's project. A new task and its new subtasks are created together. A `#[Project]` on a nested line makes it a top-level task in that project instead, and moves its line out of the block.
- The chip shows how many open subtasks a task has in Todoist, such as `↳ 2`, counting ones that aren't in a note.
- **Add missing subtasks from Todoist** command, also run by clicking the `↳` count: adds a task's open subtasks that aren't in a note yet beneath it, each where Todoist has it.
- Subtask order syncs both ways: reordering subtasks in a note reorders them in Todoist, and reordering them in Todoist rearranges their lines in the note. The note wins if both were reordered.
- Indenting, outdenting or moving a synced line changes which task it's a subtask of in Todoist, or makes it a top-level task. Moving a task in Todoist, under another task in the same note or out to the top level, moves its line to match. The note wins if a task was moved in both.
- Clicking the project on a chip opens a project picker to move the task to another project, or to a new one. A subtask moved this way also moves out of its block.
- Label picker, like Todoist's label menu: every label with a tick box, the task's own labels ticked, and several can be ticked or unticked at once. Opened by clicking a label on a chip, or by typing `@` on a checkbox line. Unticking a label removes it from the task, which typed references can't do. Closing it without ticking or unticking anything cancels, and a label is only created by choosing **Create label**.
- Clicking the priority on a chip opens a priority picker, like Todoist's. Priority 4 clears it.
- Clicking the due date on a chip opens a date picker, like Todoist's scheduler: Today, Tomorrow, the weekend, next week or no date, or any date typed in words for Todoist to work out.

### Changed
- The chip shows `#Inbox` for tasks in the Inbox, rather than no project.
- The project on a chip is shown in the project's Todoist colour.
- A chip with two or more labels shows a tag icon and how many, rather than every label. Hover to see them.
- The project menus (`#[` and the chip's project picker) list projects in Todoist's order, with subprojects nested under their parents and each project's colour, rather than alphabetically.
- Typing `@` on a checkbox line opens the label picker, rather than a menu that inserts one label reference.

### Fixed
- Words in a title set in Todoist, such as "today", "friday" or "p1", are no longer read as a due date or priority when the task is pulled or imported. Only words typed after a synced title count as references.
- A `@` inside a bracketed project name, such as `#[Errands @home]`, no longer also adds a label.
- In reading view, chips in a list with a blank line between items no longer drop onto a line of their own.

## [0.2.0] - 2026-11-05

### Added
- `@label` or `@[Label name]` on a checkbox line adds that Todoist label to the task, on create or later. A missing label is created. The reference is removed from the line once applied, since the chip shows the labels.
- Typing `@` on a checkbox line opens a menu of your Todoist labels to pick from, or offers to create a new one.

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

[Unreleased]: https://github.com/timothydsmith/inlineTasks/compare/0.3.0...dev
[0.3.0]: https://github.com/timothydsmith/inlineTasks/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/timothydsmith/inlineTasks/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/timothydsmith/inlineTasks/releases/tag/0.1.0
