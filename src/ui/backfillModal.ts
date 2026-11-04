import { App, Modal, Setting } from "obsidian";

/** First-run preview of how many existing checkboxes will be created in Todoist. */
export class BackfillModal extends Modal {
  constructor(app: App, private counts: Record<string, number>, private onConfirm: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Sync existing tasks to Todoist?");
    const total = Object.values(this.counts).reduce((a, b) => a + b, 0);

    contentEl.createEl("p", {
      text:
        total === 0
          ? "No open checkboxes found. Enabling sync will mirror new checkboxes as you write them."
          : `${total} open checkbox${total === 1 ? "" : "es"} will be created in Todoist. Completed checkboxes are ignored. Exclude folders in settings first if needed.`,
    });

    if (total) {
      const list = contentEl.createEl("ul", { cls: "inline-tasks-backfill-list" });
      for (const [folder, n] of Object.entries(this.counts).sort((a, b) => b[1] - a[1])) {
        list.createEl("li", { text: `${folder}: ${n}` });
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Not now").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(total ? `Create ${total} tasks and enable sync` : "Enable sync")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Syncing…");
            await this.onConfirm();
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
