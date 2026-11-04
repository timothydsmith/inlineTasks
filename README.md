# Inline Tasks for Todoist

An Obsidian plugin that mirrors every checkbox in your notes to Todoist with **two-way sync**, and shows each synced task inline as a chip (like Jira issues in Confluence).

```markdown
- [ ] Call Bob about the contract 📅 2026-11-10 %%td:6Xg4Qm2pR%%
```

renders as

> ☐ Call Bob about the contract `■ #Work  Nov 10  P1`

## How it works

- **Every open checkbox** in an eligible note becomes a Todoist task. The plugin appends a hidden `%%td:<id>%%` marker to the line.
- **Two-way sync** of the task text, its completion and its due date (`📅 YYYY-MM-DD`, compatible with the Tasks plugin):
  - Tick a task on your phone and the checkbox in your note is ticked.
  - Edit the text in Obsidian and Todoist updates.
  - If both sides edited the same field, the most recent edit wins.
- **The chip** shows project, due date (red when overdue, ↻ when recurring), priority and labels. Click it to open the task in Todoist. Put the cursor on the chip to see or edit the raw marker.
- **Never deletes anything:**
  - Deleting a line in Obsidian only unlinks the task.
  - Deleting a task in Todoist strikes through the chip.
- **New tasks** go to the Inbox. To send them elsewhere:
  - Map folders to projects in settings.
  - Set `todoist_project: Work` in a note's frontmatter.
- **When sync runs:**
  - Pushes happen about 3s after you stop typing. A new task on the line you're still editing is held back until you move off it.
  - Pulls happen every 5 minutes, whenever Obsidian regains focus, and on **Sync now**.

### Excluding things
- Folders listed in settings (defaults to `Templates`).
- A whole note: `todoist: false` in its frontmatter.
- A single line: add `#notodoist`.
- Checkboxes in code blocks, empty checkboxes, and checkboxes already ticked before they were ever synced.

### First run
After you add your API token, a **backfill preview** shows how many existing open checkboxes would be created, grouped by folder. Sync stays paused until you confirm.

### Multiple devices (Obsidian Sync)
Creation is crash- and retry-safe:
1. A pending marker `%%td:new-<uuid>%%` is written to the note before the task is sent.
2. The same uuid is used as the Todoist command id, so Todoist de-duplicates a retried create.
3. If you still see duplicates, turn off **This device creates tasks** on secondary devices. That setting is stored per device.

## Install (manual)
```sh
npm install
npm run build
mkdir -p <vault>/.obsidian/plugins/inline-tasks
cp main.js manifest.json styles.css <vault>/.obsidian/plugins/inline-tasks/
```
Enable **Inline Tasks for Todoist** in Settings → Community plugins. Then paste your token from Todoist → Settings → Integrations → Developer.

## Development
```sh
npm run dev    # watch build
npm test       # vitest: parser, merge rules, sync engine against a fake Todoist
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

Not yet supported: nested checkboxes as subtasks, editing priority or labels inline, and Todoist query blocks.
