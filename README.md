# Inline Tasks for Todoist

An Obsidian plugin that mirrors every checkbox in your notes to Todoist with **two-way sync**, and shows each synced task inline as a chip (like Jira issues in Confluence).

```markdown
- [ ] Call Bob about the contract 📅 2026-11-10 %%td:6Xg4Qm2pR%%
```

renders as

> ☐ Call Bob about the contract `■ #Work  Nov 10  P1`

**Status:** pre-release (0.1.0). Tested against the live Todoist API on Obsidian desktop (Windows) and Android, with Obsidian Sync between them. Not yet tested on iOS. See [CHANGELOG.md](CHANGELOG.md).

## How it works

- **Every open checkbox** in an eligible note becomes a Todoist task. The plugin appends a hidden `%%td:<id>%%` marker to the line.
- **Two-way sync** of the task text, its completion and its due date (`📅 YYYY-MM-DD`, compatible with the Tasks plugin):
  - Tick a task on your phone and the checkbox in your note is ticked.
  - Edit the text in Obsidian and Todoist updates.
  - If both sides edited the same field, the most recent edit wins.
- **The chip** shows project, due date (red when overdue, ↻ when recurring), priority and labels.
  - Click it to open the task in Todoist. Click the project to move the task to another one, a label to change its labels, or the `↳` subtask count to add missing subtasks.
  - To see or edit the raw marker, move the cursor onto it with the arrow keys, or click just beside the chip.
- **Never deletes anything:**
  - Deleting a line in Obsidian only unlinks the task.
  - Deleting a task in Todoist strikes through the chip.
- **New tasks** go to the Inbox. To send them elsewhere:
  - Type `#[` on the checkbox line and pick a project (see [Filing a task in a project](#filing-a-task-in-a-project)).
  - Map folders to projects in settings.
  - Set `todoist_project: Work` in a note's frontmatter.
- **When sync runs:**
  - Pushes happen a few seconds after you stop typing, once Obsidian has saved the note. A new task on the line you're still editing is held back until you move off it. **Sync now** and **Sync current note** save the note first and push straight away.
  - Changes that arrive from another device or app are pushed after a 2-minute wait (see [Multiple devices](#multiple-devices-obsidian-sync)).
  - Pulls happen every 5 minutes, whenever Obsidian regains focus, and on **Sync now**.

### What the chip shows

| Chip | Meaning |
|---|---|
| `#Work`, `#Inbox` | Todoist project. Click it to move the task to another project; see [Filing a task in a project](#filing-a-task-in-a-project). |
| `Nov 10`, `Today`, `Tomorrow` | Due date; red when overdue, `↻` when recurring |
| `P1` `P2` `P3` | Priority (P4 is not shown) |
| `@label` | Todoist labels. Click one to change the task's labels; see [Labels](#labels). |
| `↳ 2` | Open subtasks in Todoist, whether or not they're in a note (hidden when there are none). Only direct subtasks count, not theirs. Click it to add the ones that aren't in a note yet; see [Subtasks](#subtasks). |
| grey icon | Task is completed |
| *syncing…* | Create is in flight |
| ~~deleted in Todoist~~ | Task was deleted in Todoist. Remove the marker to unlink it. |

### Filing a task in a project

Type `#[` on a checkbox line to open a menu of your Todoist projects, then keep typing to filter. Picking one inserts a project reference:

```markdown
- [ ] Get tiling quotes #[Home Reno]
```

When the task next syncs, it's filed in that project and the reference is removed from the line. The chip shows the project from then on.

- **New task:** created directly in that project.
- **Already-synced task:** moved to that project. Add another reference later to move it again, or click the project on the chip and pick one: that adds the reference for you and syncs straight away.
- **Project doesn't exist:** keep typing the new name, and the menu offers **Create project “…”**. A reference you type by hand to a missing project also creates it.
- **Matching** ignores case and extra spaces. Archived projects are skipped, so naming one creates a new active project with the same name.
- **Timing:** like new tasks, the reference is applied once you move off the line, or straight away with **Sync now**.
- **Precedence:** a reference beats folder mappings and `todoist_project:` frontmatter.
- **Ordinary tags are unaffected.** Only `#[` opens the project menu, so `#tags` get Obsidian's usual tag suggestions and never file a task.

### Labels

Type `@` on a checkbox line, as a word of its own, to open the label picker. It lists your Todoist labels with tick boxes, like Todoist's label menu, with the task's own labels ticked. Clicking a label on a task's chip opens the same picker.

- **Pick:** type to filter, then press Enter or click to tick or untick a label. The picker stays open so you can pick several, and the search clears after each one.
- **Apply:** press Esc or click outside the picker when you're done.
  - **Synced task:** its labels change in Todoist straight away, including any you unticked, and the `@` is removed. The picker works from the task's labels as Todoist has them at that moment, so a label added in Todoist meanwhile isn't lost.
  - **Line not synced yet:** the `@` is replaced by references to the labels you ticked, applied when the task is created. Unticking a label removes its reference from the line.
  - **Nothing ticked or unticked:** anything typed in the search box is left on the line after the `@`, as if you'd typed it there.
- **Label doesn't exist:** keep typing the new name, and the picker offers **Create label “…”**.

You can also type label references by hand. Names with spaces or punctuation are bracketed:

```markdown
- [ ] Ring the plumber @PhoneCall @[Waiting For]
```

When the task next syncs, the labels are added to it and the references are removed from the line. The chip shows the task's labels from then on.

- **Adding only:** typed references add labels and never remove any. Use the picker to remove one.
- **Label doesn't exist:** a reference to a missing label creates it.
- **Matching** ignores case and extra spaces, and uses the label's own spelling in Todoist.
- **Where `@` counts:** only at the start of the line or after a space, so `bob@example.com` is left alone. A bare `@name` stops at a space and doesn't include a trailing full stop or comma. Use `@[…]` for anything else.
- **Timing:** like project references, labels are applied once you move off the line, or straight away with **Sync now**. A task linked on another device waits until this device has fetched its current labels, so none are dropped.
- **Mentions:** any `@word` on a synced checkbox line becomes a label, so write `at Sarah's` rather than `@Sarah` unless you mean the label.

### Setting a priority

Type `p1`, `p2`, `p3` or `p4` anywhere on a checkbox line, as in Todoist: `p1` is urgent and `p4` is none.

```markdown
- [ ] Call the dentist p1
```

When the task next syncs, its priority is set and the word is removed from the line. The chip shows P1–P3 from then on, and follows any change made in Todoist.

- **New or synced tasks:** a new task is created with that priority, and a synced task's priority is changed. `p4` clears it.
- **A word of its own:** `mp3`, `#p1`, `p1st` and `(p1)` don't count. The last one on the line wins.
- **In a title:** a separate `p1`–`p4` word is always read as a priority, so "Review p2 draft" becomes "Review draft" at p2. Write it another way, such as "Review P-2 draft", to keep it. This also applies to a title changed in Todoist: it's read on the next sync from this note.
- **Timing:** like project and label references, it's applied once you move off the line, or straight away with **Sync now**.

### Setting a due date in words

Instead of typing `📅 YYYY-MM-DD`, write the date in words anywhere on a checkbox line:

```markdown
- [ ] Send the invoice next friday
- [ ] Pay rent every month
- [ ] Renew passport 15/11
```

When the task next syncs, the words are sent to Todoist, which works out the date the way its Quick Add does. A few seconds later the date comes back, and the words are replaced on the line by `📅 YYYY-MM-DD`.

| You can write | Means |
|---|---|
| `today`, `tomorrow` | That day |
| `monday` … `sunday`, `next friday` | The coming weekday |
| `next week` | Next Monday (Todoist's meaning) |
| `every day`, `every weekday`, `every week`, `every month`, `every year`, `every monday` … | A repeating task (↻ on the chip) |
| `15/11`, `15/11/27`, `15/11/2027` | That date, read in your Todoist date format (Settings → General) |

- **New or synced tasks:** a new task is created with that date, and a synced task's date is changed. Words beat a `📅` on the same line.
- **Phrases of their own:** each must be separate words. Weekdays are full names only, so "sun", "sat" and "wed" are left alone, as are "Fridays" and "15/11x". The last date on the line wins.
- **In a title:** on a line you type, a separate date word is read as a date, so "Call Bob today about it" becomes "Call Bob about it", due today. The same goes for `24/7` or `1/2`. Write it another way to keep it, such as "Call Bob (today) about it".
- **Titles from Todoist are kept:** once a task is synced, the words of its title stay part of the title. A task renamed in Todoist to "Call Bob today", or imported with that title, keeps "today" in its title, and the same goes for `p1` or `@home` in a title. Only words typed after the title are read as references. If you edit the title in the middle of the line, the whole line is read again, as a new line would be.
- **Timing:** like other references, it's applied once you move off the line, or straight away with **Sync now**. It needs a connection, since Todoist works out the date.

### Subtasks

A new checkbox nested under another checkbox is created as its subtask in Todoist:

```markdown
- [ ] Plan trip
	- [ ] Book flights
		- [ ] Pick seats
	- [ ] Book hotel
```

- **Its parent** is the nearest line above it that's indented less, if that's a synced or syncing checkbox. Nested under a plain bullet, a heading or a `#notodoist` line, it's a task of its own.
- **Project:** a subtask goes in its parent's project, whatever the note's folder maps to. A `#[Project]` on a nested line wins, new or synced: since a subtask can't be in another project than its parent, it becomes a top-level task in that project, and its line moves out of the block to just below it, with the indent removed and its own subtasks still under it.
- **New parent and subtasks together:** they're created in one go. A subtask whose parent is still being typed waits for it, so it's never created on its own first.
- **Indenting and moving:** indent a synced line under another task and it becomes that task's subtask, in its project. Outdent it to the top level and it becomes a top-level task in the project it's in. Move it under a different task and it moves there. Its own subtasks move with it, as their lines do.
- **Moves made in Todoist:** move a task under another task in Todoist, or out to the top level, and its line moves to match in the note, with everything nested under it, re-indented and placed by Todoist's order. If it's moved under a task that isn't in the same note, the line stays where it is (the sync log says so).
- **Changes, not differences:** a move is copied from whichever side it was made on since the last sync, not because the note and Todoist differ; if it was moved in both, the note wins. So an imported or pasted line is taken as it's placed.
- **Waits when needed:** a completed task isn't moved; the change is sent if you untick it. A line moved under a task that's still being created is moved once that task exists.
- **Subtasks added in Todoist:** they don't appear in the note on their own. To bring them in, click the `↳` count on the task's chip, or put the cursor on the task's line and run **Add missing subtasks from Todoist**. Its open subtasks that aren't in any note yet are added beneath it, each where Todoist has it among the subtasks already there, and each with its own open subtasks. Subtasks already in a note, this one or another, are left where they are.
- **Order, both ways:** reorder a task's subtasks in the note and they're reordered in Todoist; reorder them in Todoist and their lines are rearranged in the note, each with the lines nested under it. If both were reordered since the last sync, the note's order wins. Only the tasks that moved are changed in Todoist, and subtasks that aren't in the note keep their places there. A subtask typed between two others goes there in Todoist too.
- **When the note isn't rearranged:** if anything other than subtasks sits among a task's subtasks, such as a line of text, a plain bullet or a blank line, a reorder in Todoist leaves the note as it is (the sync log says so), since there'd be no telling where that line belongs. Reordering in the note still works. Completed subtasks aren't part of the order.

### Importing a task from Todoist

Run **Import task from Todoist** in a note to pick any open Todoist task and insert it at the cursor. Its open subtasks can come with it, indented beneath it in Todoist's order.

- **Finding it:** type to search the task's title, project and due date. With nothing typed, tasks are listed by due date, soonest first. Each shows its project, due date and number of subtasks. Tasks already linked to a line in your vault aren't offered.
- **Where it goes:** on an empty line or an empty list item, the task replaces it. Otherwise it goes on the next line, indented like the current list item.
- **Linked straight away:** the lines carry the tasks' markers, so they sync like any other: the chip shows each task's project, labels and priority, and edits on either side sync both ways. Nothing is created or changed in Todoist by the import.
- **Subtasks:** the **Import subtasks** setting decides whether they come too. Set to **Ask each time** (the default), importing a task that has open subtasks asks whether to bring them: **With subtasks** or **Task only**. Press Esc to cancel the import. **Always import** and **Never import** skip the question. A subtask already linked to a line elsewhere is left out, along with its own subtasks. A subtask you leave behind can be imported on its own later.

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
Each device pushes the changes made on it:
- **Typed here:** a change made in this device's editor is pushed within seconds.
- **Arrived from elsewhere:** a change delivered by Obsidian Sync, OneDrive or another app is pushed only after the note has been unchanged for 2 minutes. By then the device you typed on has usually created the task, and its marker has synced across, so nothing is created twice and half-typed lines from the other device are never created.
- **Written by a script or agent:** notes written directly to disk count as arriving from elsewhere, so their tasks appear in Todoist about 2 minutes later.
- **Who creates those:** after the wait, edits to tasks that are already linked are pushed by whichever device sees them. New checkboxes that arrived from elsewhere are created only by devices with **Create tasks for changes from other devices or apps** turned on. It's on for desktop and off for mobile by default, so a note written by an agent is created once, not once per device. Keep it on for exactly one device. If it's on for none, tasks written by a script won't be created until you edit the line.

Creation is also crash- and retry-safe:
1. A pending marker `%%td:new-<uuid>%%` is written to the note before the task is sent.
2. The same uuid is used as the Todoist command id, so Todoist de-duplicates a retried create.

If you still see duplicates, for example from editing the same note on two devices at once, turn off **This device creates tasks** on secondary devices. That setting is stored per device.

## Install

Needs Obsidian 1.8.7 or later, on desktop or mobile.

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
| Folder → project | none | One `Folder = Project` per line. The longest matching folder wins. A note's `todoist_project:` frontmatter overrides it, and a `#[Project]` reference on a line overrides both. Unknown project names fall back to the Inbox. |
| Pull interval (minutes) | 5 | Minimum 1. |
| Import subtasks | Ask each time | Whether **Import task from Todoist** brings a task's open subtasks: **Ask each time**, **Always import** or **Never import**. |
| This device creates tasks | on | Stored per device, not in `data.json`. Off means this device never creates tasks, even ones typed here. |
| Create tasks for changes from other devices or apps | on for desktop, off for mobile | Stored per device. See [Multiple devices](#multiple-devices-obsidian-sync). |
| Backfill existing checkboxes | — | Opens the backfill preview. |

## Commands

| Command | What it does |
|---|---|
| **Sync now** | Pushes every pending change, including the line you're on, then pulls. |
| **Sync current note** | Pushes the active note immediately. |
| **Import task from Todoist** | Inserts an open Todoist task, with its subtasks, at the cursor. See [Importing a task](#importing-a-task-from-todoist). |
| **Add missing subtasks from Todoist** | On a synced task's line: adds its open subtasks that aren't in a note yet beneath it. Same as clicking the `↳` count on its chip. |
| **Review backfill of existing checkboxes** | Shows how many unsynced open checkboxes would be created, and creates them on confirm. |
| **Save sync log to a note** | Writes this device's recent sync decisions to `Inline Tasks sync log (desktop).md` (or `android`, `ios`), so you can compare what each device did. |

## Privacy

- Task text and due dates are sent to Todoist.
- Each task's description gets an `obsidian://open` link that contains your vault name and the note's path.
- Your API token is stored in plain text in `<vault>/.obsidian/plugins/inline-tasks/data.json`, along with your settings. Don't commit that file or share your vault's `.obsidian` folder.
- Each device keeps its own sync state (which tasks are linked, the last synced values, cached project names) in Obsidian's local storage for the vault, not in `data.json`, so devices sharing a vault through Obsidian Sync don't overwrite each other's. A device that starts with none, such as a new phone, links the `%%td:…%%` markers already in its notes and fetches their details from Todoist.

## Troubleshooting

- **Unlink one task:** delete its `%%td:…%%` marker. The Todoist task is left alone.
- **Stop a note syncing:** add `todoist: false` to its frontmatter, or add its folder to **Excluded folders**. Edits in the note stop being pushed, but lines that already have a marker still receive changes made in Todoist. Delete those markers to unlink them completely.
- **Nothing syncs:** check that the token works (**Test** in settings) and that the backfill has been confirmed.
- **Logs:** open the developer console (Ctrl+Shift+I, or Cmd+Opt+I on macOS) and filter for `[inline-tasks]`. Rejected commands and merge conflicts are logged there. On mobile, use **Save sync log to a note** instead.

## Known limitations

- **Due times:** a time set in Todoist is shown as a date only. Changing the date in Obsidian replaces the due date with a date-only one, so the time is lost.
- **Recurring tasks:** ticking one in Obsidian completes the current occurrence. Todoist moves it to the next date, and the checkbox unticks with the new date (not yet tested against the live API). Changing a recurring task's date in Obsidian ends the recurrence.
- **Projects:** references name a project only, not a section. Two active projects with the same name can't be told apart; the first one found is used, and the chip's project picker won't move a task to either. Nor will it move one to a project whose name contains `]`.
- **Labels:** typed references only add labels; removing one needs the picker. If a label is added in Todoist after this device last pulled and before a typed `@label` is applied here, that newer label is dropped, because Todoist takes a task's labels as a whole list. A pull every few minutes keeps that window short. The picker pulls first, so it doesn't have this problem. A task with no labels has none on its chip to click: type `@` on its line instead.
- **Subtasks:** a subtask added in Todoist to a task in a note appears only when you add it (see [Subtasks](#subtasks)). A task moved in Todoist under a task in another note, or in no note, keeps its place; lines aren't moved between notes.
- **Order:** only subtasks are kept in order. The order of top-level tasks in a note isn't synced, since one note can hold tasks from several projects. The first time a task's subtasks are seen after updating, their order is just recorded: if the note and Todoist disagree then, they're left until one side is reordered. Lines synced before this version are taken as they're nested the first time each note syncs.
- **Not yet supported:** Todoist query blocks.

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
| `src/ui/*` | Live-preview chip (CodeMirror 6), reading-view chip, `#` project picker, backfill modal |
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
