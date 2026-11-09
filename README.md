# Inline Tasks for Todoist

An Obsidian plugin that mirrors every checkbox in your notes to Todoist with **two-way sync**, and shows each synced task inline as a chip (like Jira issues in Confluence).

```markdown
- [ ] Call Bob about the contract %%td:6Xg4Qm2pR%% ⏳ 2026-11-10 📅 2026-11-14
```

renders as

> ☐ Call Bob about the contract `■ #Work  Nov 10  P1`

**Status:** pre-release (0.1.0). Tested against the live Todoist API on Obsidian desktop (Windows) and Android, with Obsidian Sync between them. Not yet tested on iOS. See [CHANGELOG.md](CHANGELOG.md).

## How it works

- **Every open checkbox** in an eligible note becomes a Todoist task. The plugin adds a hidden `%%td:<id>%%` marker to the line, after the task's text and before any dates.
- **Two-way sync** of the task text, its completion, its date and its deadline (see [Dates and deadlines](#dates-and-deadlines)):
  - Tick a task on your phone and the checkbox in your note is ticked.
  - Edit the text in Obsidian and Todoist updates.
  - If both sides edited the same field, the most recent edit wins.
- **The chip** shows project, date (red when overdue, ↻ when recurring), deadline, priority and labels.
  - Click it to open the task in Todoist. Click the project to move the task to another one, a label to change its labels, the priority or date to change it, or the `↳` subtask count to add missing subtasks.
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
| `#Work`, `#Inbox` | Todoist project, in its Todoist colour. Click it to move the task to another project; see [Filing a task in a project](#filing-a-task-in-a-project). |
| `Nov 10`, `Today`, `Tomorrow` | Date; red when overdue, `↻` when recurring. Click it to change it; see [Changing a date from the chip](#changing-a-date-from-the-chip). |
| ◎ `Nov 14` | Deadline; red when overdue. Change it with the line's `📅`. |
| `P1` `P2` `P3` | Priority (P4 is not shown). Click it to change it; see [Setting a priority](#setting-a-priority). |
| `@label`, or a tag icon and count | Todoist labels: the label itself when there's one, or how many when there are more (hover to see them). Click to change the task's labels; see [Labels](#labels). |
| `↳ 2` | Open subtasks in Todoist, whether or not they're in a note (hidden when there are none). Only direct subtasks count, not theirs. Click it to add the ones that aren't in a note yet; see [Subtasks](#subtasks). |
| grey icon | Task is completed |
| *syncing…* | Create is in flight |
| ~~deleted in Todoist~~ | Task was deleted in Todoist. Remove the marker to unlink it. |

### Filing a task in a project

Type `#[` on a checkbox line to open a menu of your Todoist projects, listed as Todoist's sidebar lists them: the Inbox first, then in your order, with subprojects nested under their parents. Keep typing to filter; matches show their parent projects beneath them. Picking one inserts a project reference:

```markdown
- [ ] Get tiling quotes #[Home Reno]
```

When the task next syncs, it's filed in that project and the reference is removed from the line. The chip shows the project from then on.

- **New task:** created directly in that project.
- **Already-synced task:** moved to that project. Add another reference later to move it again, or click the project on the chip and pick one: that adds the reference for you and syncs straight away.
- **Project doesn't exist:** keep typing the new name, and the menu offers **Create project “…”**. A reference you type by hand to a missing project also creates it.
- **Nested projects:** name a project by its path, with `/` between the names:

  ```markdown
  - [ ] Draft the proposal #[Work/Clients/Acme]
  ```

  This files the task in Acme, under Clients, under Work. Any of them that doesn't exist is created in its place, and the menu says which. The first name can be a project at any level, so `#[Clients/Acme]` works too. A project whose own name contains a `/` still matches by that name first.
- **Projects with the same name:** the menus and the chip name such a project by its path, such as `#[Home/Admin]`, so the task goes to the one you picked.
- **Matching** ignores case and extra spaces, also around `/`. Archived projects are skipped, so naming one creates a new active project with the same name.
- **Timing:** like new tasks, the reference is applied once you move off the line, or straight away with **Sync now**.
- **Precedence:** a reference beats folder mappings and `todoist_project:` frontmatter.
- **Ordinary tags are unaffected.** Only `#[` opens the project menu, so `#tags` get Obsidian's usual tag suggestions and never file a task.

### Labels

Type `@` on a checkbox line, as a word of its own, to open the label picker. It lists your Todoist labels with tick boxes, like Todoist's label menu, with the task's own labels ticked. Clicking a label on a task's chip opens the same picker.

- **Pick:** type to filter, then press Enter or click to tick or untick a label. The picker stays open so you can pick several, and the search clears after each one.
- **Apply:** press Esc or click outside the picker when you're done.
  - **Synced task:** its labels change in Todoist straight away, including any you unticked, and the `@` is removed. The picker works from the task's labels as Todoist has them at that moment, so a label added in Todoist meanwhile isn't lost.
  - **Line not synced yet:** the `@` is replaced by references to the labels you ticked, applied when the task is created. Unticking a label removes its reference from the line.
  - **Nothing ticked or unticked:** nothing changes. The `@` is removed and anything typed in the search box is dropped.
- **Label doesn't exist:** keep typing the new name, and the picker offers **Create label “…”**. Only choosing that creates a label, and only if it's still ticked when the picker closes.

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
- **From the chip:** click P1–P3 on a chip to pick another priority, or Priority 4 to clear it. Type a number to jump to it. It adds the word for you and syncs straight away. A task with no priority has none on its chip to click: type the word instead.
- **A word of its own:** `mp3`, `#p1`, `p1st` and `(p1)` don't count. The last one on the line wins.
- **In a title:** a separate `p1`–`p4` word is always read as a priority, so "Review p2 draft" becomes "Review draft" at p2. Write it another way, such as "Review P-2 draft", to keep it. This also applies to a title changed in Todoist: it's read on the next sync from this note.
- **Timing:** like project and label references, it's applied once you move off the line, or straight away with **Sync now**.

### Dates and deadlines

Todoist has two dates, and so does the Tasks plugin. They pair up like this:

| On the line | Todoist | Tasks plugin |
|---|---|---|
| `⏳ 2026-11-10` | Date: when you plan to do it | Scheduled date |
| `📅 2026-11-14` | Deadline: when it must be done | Due date |

- **Both sync both ways.** Change either on the line or in Todoist and the other side follows. Delete one from the line to remove it in Todoist.
- **Words** such as `friday` set the date (`⏳`), as in Todoist's Quick Add. Type a deadline as `📅 YYYY-MM-DD`.
- **The chip** shows the date, and the deadline after a ◎. Clicking the date changes it; to change the deadline, edit the line's `📅`.
- **Lines from earlier versions** wrote the Todoist date as `📅`. Each device rewrites those as `⏳` once, the first time it starts this version, and then fetches every task's deadline from Todoist.

### Changing a date from the chip

Click the date on a task's chip to open the date picker, like Todoist's scheduler:

- **Quick choices:** Today, Tomorrow, This weekend (Saturday; Next weekend at the weekend), Next week (Monday), and No date. Each shows the day it means.
- **Anything else:** type it, such as `next friday`, `20 nov`, `in 3 days` or `every month`, and choose **Set to “…”**. Todoist works out the date, as its Quick Add does, so this takes more than the words a line understands.
- **Applied straight away:** the task's date changes in Todoist, and the line's `⏳` follows a moment later. It needs a connection.
- **Repeating tasks:** picking a date or No date ends the repeat, unlike rescheduling in Todoist, and the picker says so. Type `every …` to set a new one.

A task without a date has none on its chip to click: type the date on its line instead, as below.

### Setting a date in words

Instead of typing `⏳ YYYY-MM-DD`, write the date in words anywhere on a checkbox line:

```markdown
- [ ] Send the invoice next friday
- [ ] Pay rent every month
- [ ] Renew passport 15/11
```

When the task next syncs, the words are sent to Todoist, which works out the date the way its Quick Add does. A few seconds later the date comes back, and the words are replaced on the line by `⏳ YYYY-MM-DD`.

| You can write | Means |
|---|---|
| `today`, `tomorrow` | That day |
| `monday` … `sunday`, `next friday` | The coming weekday |
| `next week` | Next Monday (Todoist's meaning) |
| `every day`, `every weekday`, `every week`, `every month`, `every year`, `every monday` … | A repeating task (↻ on the chip) |
| `15/11`, `15/11/27`, `15/11/2027` | That date, read in your Todoist date format (Settings → General) |

- **New or synced tasks:** a new task is created with that date, and a synced task's date is changed. Words beat a `⏳` on the same line.
- **Phrases of their own:** each must be separate words. Weekdays are full names only, so "sun", "sat" and "wed" are left alone, as are "Fridays" and "15/11x". The last date on the line wins.
- **In a title:** on a line you type, a separate date word is read as a date, so "Call Bob today about it" becomes "Call Bob about it", due today. The same goes for `24/7` or `1/2`. Write it another way to keep it, such as "Call Bob (today) about it".
- **Titles from Todoist are kept:** once a task is synced, the words of its title stay part of the title. A task renamed in Todoist to "Call Bob today", or imported with that title, keeps "today" in its title, and the same goes for `p1` or `@home` in a title. Only words typed after the title are read as references. If you edit the title in the middle of the line, the whole line is read again, as a new line would be.
- **Timing:** like other references, it's applied once you move off the line, or straight away with **Sync now**. It needs a connection, since Todoist works out the date.

### Using it with the Tasks plugin

Lines are written so the [Tasks plugin](https://github.com/obsidian-tasks-group/obsidian-tasks) can read them. Tasks reads its fields from the end of the line, so the marker goes before them:

```markdown
- [ ] Water the plants %%td:6Xg4Qm2pR%% ⏫ 🔁 every week ⏳ 2026-11-08 📅 2026-11-10
```

- **Tasks' fields stay on the line and out of the Todoist title:** `🛫` start, `➕` created, `✅` done and `❌` cancelled dates, `🔁` repeats, the priorities `🔺 ⏫ 🔼 🔽 ⏬`, `🆔`, `⛔` and `🏁`, and a `^block-link` at the end. When the plugin rewrites a line, it writes them in the order Tasks does.
- **`⏳` and `📅` sync** with Todoist's date and deadline (see [Dates and deadlines](#dates-and-deadlines)). The other dates are kept in the note only.
- **Repeating tasks** stay one task in Todoist, even when Tasks adds a line for the next occurrence; see [Repeating tasks](#repeating-tasks).
- **Priorities and done dates:** turn on **Write Tasks plugin fields** in settings so Tasks queries can use them:
  - Each task's Todoist priority is written on its line as a Tasks priority, and changing either one changes the other. Todoist has four priorities and Tasks six, so they pair up like this:

    | Todoist | Tasks |
    |---|---|
    | p1 | 🔺 highest |
    | p2 | ⏫ high |
    | p3 | 🔼 medium |
    | p4 | normal (nothing written), 🔽 low or ⏬ lowest |

  - `p1`–`p4` typed on a line, or a priority picked on the chip, is written as the Tasks priority.
  - A task completed in Todoist gets `✅` and the date it was completed. One ticked in the note gets today's date, unless Tasks already added one. Unticking removes the date. Cancelled `[-]` tasks don't get one.
  - A `🔁` repeat makes the Todoist task repeat, and a repeating Todoist task gets a `🔁`.
  - Turning it on runs a full sync, which writes every open task's priority and repeat to its line. Tasks completed before then don't get a done date.
- **Statuses:** `[x]` and `[X]` (done) and `[-]` (cancelled) complete the Todoist task. Any other status, such as Tasks' `[/]` (in progress), leaves it open. New Todoist tasks are made from `[ ]` and `[/]` lines only, so `[?]` and other custom statuses aren't sent to Todoist.
- **Lines from earlier versions** had the marker last, which hides their fields from Tasks. Each device moves it in front of the fields once, the first time it starts this version, and any line it missed moves the next time its note syncs.

#### Repeating tasks

A repeating task is one task in Todoist, whichever side it repeats from:

- **Ticked with Tasks:** Tasks adds a line for the next occurrence and keeps the ticked one. The plugin completes that occurrence in Todoist and moves the task to the new line's date. The marker stays on the new line; the ticked line loses it and stays in the note as a record.

  ```markdown
  - [ ] Water the plants %%td:6Xg4Qm2pR%% 🔁 every week ⏳ 2026-11-17
  - [x] Water the plants 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10
  ```

- **Completed in Todoist,** or ticked in the note without Tasks: Todoist moves it to its next date, and the line unticks with that date.
- **With Write Tasks plugin fields on,** the repeat itself syncs: a `🔁` on a line makes the Todoist task repeat, from the line's `⏳` date, and a repeat set in Todoist is written as `🔁`. Changing or removing either one changes the other.
- **Rules both understand** are synced: `every day`, `every 3 days`, `every weekday`, `every week`, `every 2 weeks`, `every week on Monday, Friday`, `every month`, `every month on the 15th`, `every month on the last`, `every year`, and any of these `when done` (Todoist's `every!`). Others, such as `every 3rd friday`, stay where they were written: the line or Todoist. A start or end date and a time in Todoist's repeat aren't written to the line.
- **Changing the date** on the line moves the next occurrence and keeps the repeat.

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
- **Telling an agent your projects and labels:** turn on **Projects and labels note** (see [Notes for agents](#notes-for-agents)).
- **Who creates those:** after the wait, edits to tasks that are already linked are pushed by whichever device sees them. New checkboxes that arrived from elsewhere are created only by devices with **Create tasks for changes from other devices or apps** turned on. It's on for desktop and off for mobile by default, so a note written by an agent is created once, not once per device. Keep it on for exactly one device. If it's on for none, tasks written by a script won't be created until you edit the line.

Creation is also crash- and retry-safe:
1. A pending marker `%%td:new-<uuid>%%` is written to the note before the task is sent.
2. The same uuid is used as the Todoist command id, so Todoist de-duplicates a retried create.

If you still see duplicates, for example from editing the same note on two devices at once, turn off **This device creates tasks** on secondary devices. That setting is stored per device.

### Notes for agents
An agent or script that writes tasks into your notes doesn't need its own Todoist connection: it writes checkbox lines with references, and the plugin files them. To tell it which projects and labels exist, turn on **Projects and labels note** in settings. The plugin then keeps a note with:

- your active projects as `#[Name]` references, nested as in Todoist, and your labels as `@label` references,
- how to write a line with a project, labels, a priority and a due date,
- your folder mappings and excluded folders.

It's rewritten whenever a sync brings a change, so it follows projects and labels added or renamed in Todoist. Don't edit it: changes are overwritten. Its frontmatter has `todoist: false`, so its example line never becomes a task.

- **Where it goes:** `.obsidian/todoist-projects-and-labels.md` (in your vault's config folder) unless you set **Projects and labels note location**. Set a path like `Agents/Todoist.md` to put it with your notes instead.
- **In the config folder:** the note stays out of Obsidian's file list, search and graph, but also out of reach of agents that read the vault through Obsidian (such as one using a REST API plugin), and of search tools that skip hidden folders by default. Give the agent its path, for example in its instructions file.
- **Each device writes it:** with the setting on and the note in a synced folder, every device writes the same text, and only when it changes.

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
| Write Tasks plugin fields | off | Writes each task's Todoist priority on its line as a Tasks priority and its repeat as `🔁`, both synced both ways, and adds `✅` done dates. See [Using it with the Tasks plugin](#using-it-with-the-tasks-plugin). |
| Projects and labels note | off | Keeps a note listing your Todoist projects and labels for agents. See [Notes for agents](#notes-for-agents). |
| Projects and labels note location | `.obsidian/todoist-projects-and-labels.md` | A path in the vault; `.md` is added if missing. |
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
- **Repeating tasks:** picking a date on the chip ends the repeat (see [Changing a date from the chip](#changing-a-date-from-the-chip)); changing `⏳` on the line keeps it. Repeat rules sync only with **Write Tasks plugin fields** on, and only those both Tasks and Todoist understand (see [Repeating tasks](#repeating-tasks)).
- **Projects:** references name a project only, not a section. Two active projects with the same name can't be told apart; the first one found is used, and the chip's project picker won't move a task to either. Nor will it move one to a project whose name contains `]`.
- **Labels:** typed references only add labels; removing one needs the picker. If a label is added in Todoist after this device last pulled and before a typed `@label` is applied here, that newer label is dropped, because Todoist takes a task's labels as a whole list. A pull every few minutes keeps that window short. The picker pulls first, so it doesn't have this problem. A task with no labels has none on its chip to click: type `@` on its line instead.
- **Subtasks:** a subtask added in Todoist to a task in a note appears only when you add it (see [Subtasks](#subtasks)). A task moved in Todoist under a task in another note, or in no note, keeps its place; lines aren't moved between notes.
- **Order:** only subtasks are kept in order. The order of top-level tasks in a note isn't synced, since one note can hold tasks from several projects. The first time a task's subtasks are seen after updating, their order is just recorded: if the note and Todoist disagree then, they're left until one side is reordered. Lines synced before this version are taken as they're nested the first time each note syncs.
- **Tasks plugin:** dates other than `⏳` and `📅` stay in the note. Priorities sync only with **Write Tasks plugin fields** on, and 🔽 and ⏬ both count as p4.
- **The same marker on two lines** (a copied line): the first line is the task, and the other is left alone. A repeating task ticked with Tasks is the exception (see [Repeating tasks](#repeating-tasks)).
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
