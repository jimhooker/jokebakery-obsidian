import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BakerWriterSyncPlugin from "./main";
import { BakerWriterApi } from "./api";

export class BakerWriterSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: BakerWriterSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Your BakerWriter address, e.g. https://bakerwriter.vercel.app")
      .addText((t) =>
        t
          .setPlaceholder("https://bakerwriter.vercel.app")
          .setValue(s.serverUrl)
          .onChange(async (v) => {
            s.serverUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Access token")
      .setDesc("Create one in BakerWriter under Settings → Obsidian sync.")
      .addText((t) => {
        t.setPlaceholder("bw_…")
          .setValue(s.token)
          .onChange(async (v) => {
            s.token = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Check the URL and token are valid.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const api = new BakerWriterApi(s.serverUrl, s.token);
          try {
            const who = await api.whoami();
            new Notice(`Connected ✓ (token: ${who.tokenName})`);
          } catch (err) {
            new Notice(
              `Connection failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc(
        "Where synced files live. Sprints go in <folder>/Sprints, jokes in <folder>/Jokes, lists in <folder>/Lists."
      )
      .addText((t) =>
        t
          .setPlaceholder("BakerWriter")
          .setValue(s.folder)
          .onChange(async (v) => {
            s.folder = v.replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync automatically")
      .setDesc("Sync on startup and on a timer.")
      .addToggle((tg) =>
        tg.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.restartAutoSync();
        })
      );

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("How often to sync when automatic sync is on.")
      .addText((t) =>
        t
          .setValue(String(s.syncIntervalMin))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n >= 1) {
              s.syncIntervalMin = n;
              await this.plugin.saveSettings();
              this.plugin.restartAutoSync();
            }
          })
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Run a two-way sync immediately.")
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Sync now")
          .onClick(() => this.plugin.runSync())
      );

    new Setting(containerEl)
      .setName("Full resync")
      .setDesc(
        "Re-pull everything from the server, including items missed by earlier " +
          "syncs (e.g. lists created before this device started syncing them). " +
          "Safe: existing files are left untouched."
      )
      .addButton((b) =>
        b.setButtonText("Full resync").onClick(() => this.plugin.forceResync())
      );

    const note = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    note.setText(
      "Tip: create a new sprint by adding a note in <folder>/Sprints named " +
        "after its date (e.g. 2026-06-10.md); create a joke by adding a note " +
        "in <folder>/Jokes; create a list by adding a note in <folder>/Lists. " +
        "Deleting a synced file removes it in BakerWriter too."
    );
  }
}
