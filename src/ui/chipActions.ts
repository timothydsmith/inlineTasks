/** What clicking a part of a chip does, other than opening the task in Todoist. */
export interface ChipActions {
  /** The `↳ N` count: add the task's missing subtasks to the note. */
  subtasks(id: string): void;
  /** The project: pick another project to move the task to. */
  project(id: string): void;
}

/** The action for a click on `target` inside a chip, if it landed on a part that has one. */
export function chipAction(target: EventTarget | null, actions: ChipActions): ((id: string) => void) | undefined {
  const el = target as HTMLElement | null;
  if (el?.closest(".inline-tasks-subtasks")) return (id) => actions.subtasks(id);
  if (el?.closest(".inline-tasks-project")) return (id) => actions.project(id);
  return undefined;
}
