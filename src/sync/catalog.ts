import { labelRef } from "../parse/taskLine";
import { labelKey, projectKey } from "./engine";
import { projectTree } from "./projects";
import type { SyncState } from "./state";

/** The note's file name when no location is set: it goes in the vault's config folder. */
export const CATALOG_FILE = "todoist-projects-and-labels.md";

export interface CatalogSettings {
  excludedFolders: string[];
  folderProjects: { folder: string; project: string }[];
}

/**
 * The projects and labels note: what's in Todoist and how to write a line that files a task there,
 * for agents and scripts that write tasks into notes without a Todoist connection of their own.
 * Its frontmatter keeps it from syncing, since its example is a checkbox.
 */
export function catalogNote(state: SyncState, settings: CatalogSettings): string {
  const out = [
    "---",
    "todoist: false",
    "---",
    "# Todoist projects and labels",
    "",
    "Written by the Inline Tasks for Todoist plugin each time it syncs. Don't edit this note: changes are overwritten.",
    "",
    "## Filing a task",
    "",
    "Write a checkbox in a note, with references after the task's text:",
    "",
    "```markdown",
    "- [ ] Get tiling quotes #[Home Reno] @[Waiting For] p2 next friday",
    "```",
    "",
    "The plugin creates the task in Todoist and removes the references from the line.",
    "",
    "- **Project:** `#[Name]`, one per line, written as listed under Projects. A subproject is named on its own, without its parents. Without a reference, the task goes to its folder's project (see below) or the Inbox.",
    "- **Labels:** `@name`, or `@[Label name]` for a name with spaces or punctuation, written as listed under Labels. Any number per line.",
    "- **Priority:** `p1` (urgent) to `p4` (none).",
    "- **Due date:** `📅 YYYY-MM-DD`, or words such as `today`, `tomorrow`, `friday`, `next week` or `every month`.",
    "- **Use these names exactly.** A project or label that isn't listed is created. Matching ignores case and extra spaces.",
    "- **Subtasks:** indent a checkbox under another to make it a subtask, in its parent's project.",
    "- **Timing:** a task written by a script or agent is created about 2 minutes after the note was last changed.",
    `- **Not synced:** notes in ${excludedText(settings.excludedFolders)}, notes with \`todoist: false\` in their frontmatter, lines with \`#notodoist\`, and checkboxes in code blocks.`,
    "",
    "## Projects",
    "",
  ];

  const projects = projectTree(state);
  const projectCount = countBy(projects.map((p) => projectKey(p.name)));
  for (const p of projects) {
    const why = p.name.includes("]") ? "can't be named in a reference, because of the `]`" : projectCount.get(projectKey(p.name))! > 1 ? "another project has the same name, so a reference may file it in either" : "";
    out.push(`${"  ".repeat(p.depth)}- ${code(`#[${p.name}]`)}${why ? ` (${why})` : ""}`);
  }
  if (!projects.length) out.push("None yet.");

  out.push("", "## Labels", "");
  const labels = labelList(state);
  for (const name of labels) {
    out.push(name.includes("]") ? `- ${code(`@[${name}]`)} (can't be named in a reference, because of the \`]\`)` : `- ${code(labelRef(name))}`);
  }
  if (!labels.length) out.push("None yet.");

  if (settings.folderProjects.length) {
    out.push("", "## Default project by folder", "", "A task without a project reference goes to the project of the longest matching folder. A note's `todoist_project:` frontmatter overrides this.", "");
    out.push("| Folder | Project |", "|---|---|");
    for (const m of settings.folderProjects) out.push(`| ${cell(m.folder)} | ${cell(m.project)} |`);
  }

  out.push("");
  return out.join("\n");
}

/** Label names in Todoist's order, each once. */
function labelList(state: SyncState): string[] {
  const seen = new Set<string>();
  return Object.values(state.labels)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name))
    .map((l) => l.name)
    .filter((name) => !seen.has(labelKey(name)) && !!seen.add(labelKey(name)));
}

function excludedText(folders: string[]): string {
  if (!folders.length) return "no excluded folders";
  return `${folders.length === 1 ? "this folder" : "these folders"}: ${folders.map(code).join(", ")}`;
}

function countBy(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** Inline code that holds any text, backticks included. */
function code(s: string): string {
  const fence = s.includes("`") ? "``" : "`";
  const pad = fence.length > 1 ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
}
