import { Plugin, type TAbstractFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type BakerWriterSyncSettings,
} from "./types";
import { SyncEngine } from "./sync";
import { BakerWriterSettingTab } from "./settings";

export default class BakerWriterSyncPlugin extends Plugin {
  settings!: BakerWriterSyncSettings;
  private statusBar?: HTMLElement;
  private autoSyncTimer?: number;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new BakerWriterSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync BakerWriter", () => this.runSync());

    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle");

    this.addCommand({
      id: "bakerwriter-sync-now",
      name: "Sync now (two-way)",
      callback: () => this.runSync(),
    });

    // Track vault deletes/renames of synced files so deletions propagate and
    // renames don't orphan a record. (Our own sync writes clear the record
    // before deleting, so these handlers ignore plugin-driven changes.)
    this.registerEvent(
      this.app.vault.on("delete", (file) => void this.handleLocalDelete(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        void this.handleLocalRename(file, oldPath)
      )
    );

    // Kick off once the workspace is ready so a startup sync doesn't race the
    // vault still indexing files.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync) {
        void this.runSync({ silent: true });
        this.restartAutoSync();
      }
    });
  }

  onunload(): void {
    if (this.autoSyncTimer) window.clearInterval(this.autoSyncTimer);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<BakerWriterSyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data ?? {}),
      // Nested collections need explicit fallbacks so an older data.json (or a
      // partial one) doesn't leave them undefined.
      records: data?.records ?? {},
      pendingDeletes: data?.pendingDeletes ?? [],
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  restartAutoSync(): void {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
    }
    if (!this.settings.autoSync) return;
    const ms = Math.max(1, this.settings.syncIntervalMin) * 60_000;
    this.autoSyncTimer = window.setInterval(() => {
      void this.runSync({ silent: true });
    }, ms);
    this.registerInterval(this.autoSyncTimer);
  }

  async runSync(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.setStatus("syncing");
    try {
      const engine = new SyncEngine(
        this.app,
        this.settings,
        () => this.saveSettings()
      );
      const summary = await engine.syncNow({ silent: opts.silent });
      this.setStatus(summary.errors.length ? "error" : "idle");
    } catch {
      this.setStatus("error");
    } finally {
      this.syncing = false;
    }
  }

  /** A synced file was deleted in the vault → queue its server-side deletion. */
  private async handleLocalDelete(file: TAbstractFile): Promise<void> {
    const record = Object.values(this.settings.records).find(
      (r) => r.path === file.path
    );
    if (!record) return;
    if (!this.settings.pendingDeletes.some((d) => d.id === record.id)) {
      this.settings.pendingDeletes.push({ type: record.type, id: record.id });
    }
    delete this.settings.records[record.id];
    await this.saveSettings();
  }

  /** A synced file was renamed/moved → keep its record pointing at the file. */
  private async handleLocalRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    const record = Object.values(this.settings.records).find(
      (r) => r.path === oldPath
    );
    if (!record) return;
    record.path = file.path;
    await this.saveSettings();
  }

  private setStatus(state: "idle" | "syncing" | "error"): void {
    if (!this.statusBar) return;
    let label: string;
    if (state === "syncing") {
      label = "BakerWriter: syncing…";
    } else if (state === "error") {
      label = "BakerWriter: sync error";
    } else {
      const at = this.settings.lastSyncAt;
      label = at ? `BakerWriter: synced ${hhmm(at)}` : "BakerWriter: idle";
    }
    this.statusBar.setText(label);
  }
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
