# Inline Tasks for Todoist

An Obsidian plugin that mirrors every checkbox in your notes to Todoist with **two-way sync**, and shows each synced task inline as a chip (like Jira issues in Confluence).

```markdown
- [ ] Call Bob about the contract 📅 2026-11-10 %%td:6Xg4Qm2pR%%
```

renders as

> ☐ Call Bob about the contract `■ #Work  Nov 10  P1`

**Status:** pre-release (0.1.0). Tested on Obsidian desktop (Windows) against the live Todoist API. Not yet tested on mobile. See [CHANGELOG.md](CHANGELOG.md).

## How it works

- **Every open checkbox** in an eligible note becomes a Todoist task. The plugin appends a hidden `%%td:<id>%%` marker to the line.
- **Two-way sync** of the task text, its completion and its due date (`📅 YYYY-MM-DD`, compatible with the Tasks plugin):
  - Tick a task on your phone and the checkbox in your note is ticked.
  - Edit the text in Obsidian and Todoist updates.
  - If both sides edited the same field, the most recent edit wins.
- **The chip** shows project, due date (red when overdue, ↻ when recurring), priority and labels.
  - Click it to open the task in Todoist.
  - To see or edit the raw marker, move the cursor onto it with the arrow keys, or click just beside the chip.
- **Never deletes anything:**
  - Deleting a line in Obsidian only unlinks the task.
  - Deleting a task in Todoist strikes through the chip.
- **New tasks** go to the Inbox. To send them elsewhere:
  - Map folders to projects in settings.
  - Set `todoist_project: Work` in a note's frontmatter.
- **When sync runs:**
  - Pushes happen about 3s after you stop typing. A new task on the line you're still editing is held back until you move off it.
  - Pulls happen every 5 minutes, whenever Obsidian regains focus, and on **Sync now**.

### What the chip shows

| Chip | Meaning |
|---|---|
| `#Work` | Todoist project (hidden for the Inbox) |
| `Nov 10`, `Today`, `Tomorrow` | Due date; red when overdue, `↻` when recurring |
| `P1` `P2` `P3` | Priority (P4 is not shown) |
| `@label` | Todoist labels |
| grey icon | Task is completed |
| *syncing…* | Create is in flight |
| ~~deleted in Todoist~~ | Task was deleted in Todoist. Remove the marker to unlink it. |

### Excluding things
- **Folders or notes** listed in settings (defaults to `Templates`). An entry matches a folder and everything inside it, or a single note by its path, e.g. `Journal/Private.md`.
- **A whole note:** `todoist: false` in its frontmatter.
- **A single line:** add `#notodoist`.
- Checkboxes in code blocks, empty checkboxes, and checkboxes already ticked before they were ever synced.

### First run
After you add your API token, a **backfill preview** shows how many existing open checkboxes would be created, grouped by folder. Sync stays paused until you confirm.

> [!WARNING]
> Check the counts before you confirm. Every folder in the preview will be created in Todoist, including private notes. If a folder shouldn't sync, click **Not now**, add it to **Excluded folders**, and run **Review backfill of existing checkboxes** again.

When you later remove an exclusion, checkboxes in that folder aren't picked up until each note is edited. Run **Review backfill of existing checkboxes** to sync them all at once.

### Multiple devices (Obsidian Sync)
Creation is crash- and retry-safe:
1. A pending marker `%%td:new-<uuid>%%` is written to the note before the task is sent.
2. The same uuid is used as the Todoist command id, so Todoist de-duplicates a retried create.
3. If you still see duplicates, turn off **This device creates tasks** on secondary devices. That setting is stored per device.

## Install

### From a release
1. Download `main.js`, `manifest.json` and `styles.css` from the latest [GitHub release](https://github.com/timothydsmith/inlineTasks/releases).
2. Copy them into `<vault>/.obsidian/plugins/inline-tasks/`.
3. Enable **Inline Tasks for Todoist** in Settings → Community plugins.
4. Paste your token from Todoist → Settings → Integrations → Developer, then click **Test**.

### From source
Needs Node.js 18 or later.
```sh
npm install
npm run build
mkdir -p <vault>/.obsidian/plugins/inline-tasks
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/inline-tasks/
```
Then follow steps 3–4 above. After copying a new build over an installed one, turn the plugin off and on again so it loads.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Todoist API token | — | **Test** checks the connection and opens the backfill preview on first run. |
| Excluded folders | `Templates` | One folder or note path per line. |
| Folder → project | none | One `Folder = Project` per line. The longest matching folder wins. A note's `todoist_project:` frontmatter overrides it. Unknown project names fall back to the Inbox. |
| Pull interval (minutes) | 5 | Minimum 1. |
| This device creates tasks | on | Stored per device, not in `data.json`. |
| Backfill existing checkboxes | — | Opens the backfill preview. |

## Commands

| Command | What it does |
|---|---|
| **Sync now** | Pushes every pending change, including the line you're on, then pulls. |
| **Sync current note** | Pushes the active note immediately. |
| **Review backfill of existing checkboxes** | Shows how many unsynced open checkboxes would be created, and creates them on confirm. |

## Privacy

- Task text and due dates are sent to Todoist.
- Each task's description gets an `obsidian://open` link that contains your vault name and the note's path.
- Your API token is stored in plain text in `<vault>/.obsidian/plugins/inline-tasks/data.json`, along with the sync state. Don't commit that file or share your vault's `.obsidian` folder.

## Troubleshooting

- **Unlink one task:** delete its `%%td:…%%` marker. The Todoist task is left alone.
- **Stop a note syncing:** add `todoist: false` to its frontmatter, or add its folder to **Excluded folders**. Edits in the note stop being pushed, but lines that already have a marker still receive changes made in Todoist. Delete those markers to unlink them completely.
- **Nothing syncs:** check that the token works (**Test** in settings) and that the backfill has been confirmed.
- **Logs:** open the developer console (Ctrl+Shift+I, or Cmd+Opt+I on macOS) and filter for `[inline-tasks]`. Rejected commands and merge conflicts are logged there.

## Known limitations

- **Due times:** a time set in Todoist is shown as a date only. Changing the date in Obsidian replaces the due date with a date-only one, so the time is lost.
- **Recurring tasks:** ticking one in Obsidian completes the current occurrence. Todoist moves it to the next date, and the checkbox unticks with the new date (not yet tested against the live API). Changing a recurring task's date in Obsidian ends the recurrence.
- **Not yet supported:** nested checkboxes as subtasks, editing priority or labels inline, and Todoist query blocks.

## Development

```sh
npm run dev    # watch build
npm test       # vitest: parser, merge rules, sync engine against a fake Todoist
npm run build  # type-check and production build
```

Layout:
| Path | Purpose |
|---|---|
| `src/parse/taskLine.ts` | Parse and serialise checkbox lines and markers |
| `src/sync/merge.ts` | Three-way field merge |
| `src/sync/engine.ts` | Push and pull against a `VaultAdapter`, independent of Obsidian |
| `src/todoist/client.ts` | Todoist unified API v1 `/sync` client |
| `src/ui/*` | Live-preview chip (CodeMirror 6), reading-view chip, backfill modal |
| `src/main.ts` | Obsidian wiring |

### Branches and releases

- **`dev`** is where work happens. Commit or merge feature branches here.
- **`main`** holds released versions only. Every commit on `main` is a release.

To cut a release:
1. On `dev`, move the **Unreleased** entries in [CHANGELOG.md](CHANGELOG.md) under a new version heading with today's date.
2. Bump `version` in `manifest.json` and `package.json`. Add the version to `versions.json`, mapped to `minAppVersion`.
3. Run `npm test` and `npm run build`, then commit.
4. Merge `dev` into `main`, and tag the merge with the bare version, e.g. `0.1.0`. Obsidian requires the tag to match `manifest.json` exactly, with no `v` prefix.
5. Push `main` and the tag. Then create a GitHub release for that tag, with that version's changelog section as its notes and `main.js`, `manifest.json` and `styles.css` attached.

## License

MIT. See [LICENSE](LICENSE).
