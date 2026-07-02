import { App, Modal, Plugin, type TAbstractFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  LEGACY_SERVER_URL,
  type JokeBakerySyncSettings,
} from "./types";
import { SyncEngine } from "./sync";
import { JokeBakerySettingTab } from "./settings";

export default class JokeBakerySyncPlugin extends Plugin {
  settings!: JokeBakerySyncSettings;
  private statusBar?: HTMLElement;
  private autoSyncTimer?: number;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new JokeBakerySettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync JokeBakery", () => this.runSync());

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.setAttribute("aria-label", "Sync JokeBakery");
    this.statusBar.onClickEvent(() => void this.runSync());
    this.setStatus("idle");

    // Obsidian namespaces command ids with the plugin id, so these stay short
    // (a directory-review guideline).
    this.addCommand({
      id: "sync-now",
      name: "Sync now (two-way)",
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: "full-resync",
      name: "Full resync (re-pull everything)",
      callback: () => this.forceResync(),
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
    const data = (await this.loadData()) as Partial<JokeBakerySyncSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data ?? {}),
      // Nested collections need explicit fallbacks so an older data.json (or a
      // partial one) doesn't leave them undefined.
      records: data?.records ?? {},
      pendingDeletes: data?.pendingDeletes ?? [],
    };
    // Pre-rebrand installs pointed at the old deploy URL. Migrate only the
    // exact old default — a custom URL (e.g. localhost) is left alone.
    if (this.settings.serverUrl === LEGACY_SERVER_URL) {
      this.settings.serverUrl = DEFAULT_SETTINGS.serverUrl;
      await this.saveSettings();
    }
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
        () => this.saveSettings(),
        // A pile of queued deletions needs a human. Silent (auto) syncs hold
        // them and keep going; a manual sync asks.
        (count) =>
          opts.silent
            ? Promise.resolve(false)
            : confirmMassDelete(this.app, count)
      );
      const summary = await engine.syncNow({ silent: opts.silent });
      this.setStatus(summary.errors.length ? "error" : "idle");
    } catch {
      this.setStatus("error");
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Drop the pull cursor and re-pull everything from the server.
   *
   * The pull is incremental: it only asks for rows changed since
   * `lastSyncCursor`. So items that already existed *before* the cursor moved
   * past them — e.g. lists created before this plugin learned to sync them —
   * never come down on a normal sync. Blanking the cursor forces a full pull,
   * which writes any such missing files (existing, unchanged files are no-ops).
   */
  async forceResync(): Promise<void> {
    this.settings.lastSyncCursor = "";
    await this.saveSettings();
    await this.runSync();
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
      label = "JokeBakery: syncing…";
    } else if (state === "error") {
      label = "JokeBakery: sync error";
    } else {
      const at = this.settings.lastSyncAt;
      label = at ? `JokeBakery: synced ${hhmm(at)}` : "JokeBakery: idle";
    }
    this.statusBar.setText(label);
  }
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function confirmMassDelete(app: App, count: number): Promise<boolean> {
  return new Promise((resolve) => new ConfirmMassDeleteModal(app, count, resolve).open());
}

/** "Really delete N items on the server?" - resolves false unless explicitly
 *  confirmed (closing the modal any other way counts as "not now"). */
class ConfirmMassDeleteModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private count: number,
    private resolveAnswer: (ok: boolean) => void
  ) {
    super(app);
  }

  private answer(ok: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.resolveAnswer(ok);
  }

  onOpen(): void {
    this.titleEl.setText("Delete synced items in JokeBakery?");
    this.contentEl.createEl("p", {
      text:
        `${this.count} synced files were deleted from this vault. Pushing that ` +
        "will delete all of them in JokeBakery too (recoverable from the " +
        "database, but not from the app). If the files went missing by " +
        "accident, choose Not now and run a Full resync to restore them instead.",
    });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const del = buttons.createEl("button", {
      text: `Delete ${this.count} items`,
      cls: "mod-warning",
    });
    del.addEventListener("click", () => {
      this.answer(true);
      this.close();
    });
    const keep = buttons.createEl("button", { text: "Not now" });
    keep.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.answer(false);
    this.contentEl.empty();
  }
}
