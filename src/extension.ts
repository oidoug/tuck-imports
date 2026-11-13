import * as vscode from 'vscode';
import { findImportBlock, scriptStart } from './importBlock';

const SECTION = 'tuckImports';
const DEFAULT_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'astro'];

interface Settings {
  autoFold: boolean;
  compact: boolean;
  includeRequire: boolean;
  minLines: number;
  languages: string[];
}

interface Block {
  startLine: number;
  startCharacter: number;
  endLine: number;
  startsWithImport: boolean;
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    autoFold: config.get('autoFold', true),
    compact: config.get('compact', true),
    includeRequire: config.get('includeRequire', true),
    minLines: Math.max(2, config.get('minLines', 2)),
    languages: config.get('languages', DEFAULT_LANGUAGES),
  };
}

function containsLine(ranges: readonly vscode.Range[], line: number): boolean {
  return ranges.some((r) => r.start.line <= line && r.end.line >= line);
}

/** True/false when the block's first line is on screen, undefined otherwise. */
function isFolded(editor: vscode.TextEditor, block: Block): boolean | undefined {
  const ranges = editor.visibleRanges;
  if (!containsLine(ranges, block.startLine)) return undefined;
  if (containsLine(ranges, block.startLine + 1)) return false;
  // Next line hidden: folded, unless the first line is just the last one on screen
  return ranges.some((r) => r.start.line > block.startLine) ? true : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TuckImports implements vscode.Disposable {
  private settings = readSettings();
  private readonly blocks = new Map<string, { version: number; block: Block | undefined }>();
  private readonly opened = new Set<string>();
  private readonly lastState = new Map<string, boolean>();
  private readonly applied = new WeakMap<vscode.TextEditor, string>();
  private readonly pendingUpdates = new Map<string, NodeJS.Timeout>();
  private readonly mask = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; display: none;',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private provider: vscode.Disposable | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.registerProvider();
    this.disposables.push(
      this.mask,
      vscode.commands.registerCommand('tuckImports.fold', () => this.runCommand('fold')),
      vscode.commands.registerCommand('tuckImports.unfold', () => this.runCommand('unfold')),
      vscode.commands.registerCommand('tuckImports.toggle', () => this.runCommand('toggle')),
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.onEditorShown(editor)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.updateMask(e))),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.updateMask(e.textEditor)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.updateMask(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleUpdate(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri.toString())),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsClosed(e.closed)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SECTION) && this.onSettingsChanged()),
    );

    vscode.window.visibleTextEditors.forEach((e) => this.updateMask(e));
    const active = vscode.window.activeTextEditor;
    if (active) this.onEditorShown(active);
  }

  dispose(): void {
    this.provider?.dispose();
    this.pendingUpdates.forEach((timer) => clearTimeout(timer));
    this.disposables.forEach((d) => d.dispose());
  }

  private registerProvider(): void {
    this.provider?.dispose();
    const selector = this.settings.languages.map((language) => ({ language }));
    this.provider = vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges: (document) => {
        const block = this.blockFor(document);
        if (!block || block.endLine <= block.startLine) return [];
        return [new vscode.FoldingRange(block.startLine, block.endLine, vscode.FoldingRangeKind.Imports)];
      },
    });
  }

  private blockFor(document: vscode.TextDocument): Block | undefined {
    if (!this.settings.languages.includes(document.languageId)) return undefined;
    const key = document.uri.toString();
    const cached = this.blocks.get(key);
    if (cached?.version === document.version) return cached.block;

    let block: Block | undefined;
    const text = document.getText();
    const from = scriptStart(text, document.languageId);
    const found = from === undefined ? undefined : findImportBlock(text, { from, includeRequire: this.settings.includeRequire });
    if (found) {
      const start = document.positionAt(found.start);
      block = {
        startLine: start.line,
        startCharacter: start.character,
        endLine: document.positionAt(found.end).line,
        startsWithImport: found.startsWithImport,
      };
    }
    this.blocks.set(key, { version: document.version, block });
    return block;
  }

  private async onEditorShown(editor: vscode.TextEditor): Promise<void> {
    this.updateMask(editor);
    const key = editor.document.uri.toString();
    if (!this.settings.autoFold || this.opened.has(key)) return;
    const block = this.blockFor(editor.document);
    if (!block) return;
    this.opened.add(key);
    if (block.endLine - block.startLine + 1 < this.settings.minLines) return;
    await this.fold(editor, block, true);
  }

  private async fold(editor: vscode.TextEditor, block: Block, retry = false): Promise<void> {
    // Folding ranges may not be computed yet right after a file opens
    const delays = retry ? [0, 250, 500, 1000] : [0];
    for (const delay of delays) {
      await sleep(delay);
      if (vscode.window.activeTextEditor !== editor) return;
      const current = this.blockFor(editor.document);
      if (!current || current.startLine !== block.startLine) return;
      if (delay > 0 && isFolded(editor, current) !== false) break;
      await vscode.commands.executeCommand('editor.fold', {
        levels: 1,
        direction: 'up',
        selectionLines: [current.startLine],
      });
    }
    this.lastState.set(editor.document.uri.toString(), true);
    this.updateMask(editor);
  }

  private async unfold(editor: vscode.TextEditor, block: Block): Promise<void> {
    await vscode.commands.executeCommand('editor.unfold', {
      levels: 1,
      direction: 'up',
      selectionLines: [block.startLine],
    });
    this.lastState.set(editor.document.uri.toString(), false);
    this.updateMask(editor);
  }

  private async runCommand(action: 'fold' | 'unfold' | 'toggle'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const block = this.blockFor(editor.document);
    if (!block || block.endLine <= block.startLine) {
      vscode.window.setStatusBarMessage('Tuck Imports: no import block to fold', 3000);
      return;
    }
    const folded = isFolded(editor, block) ?? this.lastState.get(editor.document.uri.toString()) ?? false;
    const fold = action === 'fold' || (action === 'toggle' && !folded);
    await (fold ? this.fold(editor, block) : this.unfold(editor, block));
  }

  private updateMask(editor: vscode.TextEditor): void {
    const range = this.maskRange(editor);
    const signature = range ? `${range.start.line}:${range.start.character}:${range.end.character}` : '';
    if ((this.applied.get(editor) ?? '') === signature) return;
    this.applied.set(editor, signature);
    editor.setDecorations(this.mask, range ? [range] : []);
  }

  /** Hides the folded line's text after `import`, leaving `import ⋯`. */
  private maskRange(editor: vscode.TextEditor): vscode.Range | undefined {
    if (!this.settings.compact) return undefined;
    const block = this.blockFor(editor.document);
    if (!block?.startsWithImport || isFolded(editor, block) !== true) return undefined;

    const line = editor.document.lineAt(block.startLine);
    let from = block.startCharacter + 'import'.length;
    if (line.text[from] === ' ') from++;
    if (from >= line.text.length) return undefined;

    const editing = editor.selections.some(
      (s) => s.start.line <= block.startLine && s.end.line >= block.startLine && !(s.isEmpty && s.active.character <= from),
    );
    if (editing) return undefined;
    return new vscode.Range(block.startLine, from, block.startLine, line.text.length);
  }

  private scheduleUpdate(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.pendingUpdates.get(key));
    this.pendingUpdates.set(
      key,
      setTimeout(() => {
        this.pendingUpdates.delete(key);
        vscode.window.visibleTextEditors.filter((e) => e.document === document).forEach((e) => this.updateMask(e));
      }, 100),
    );
  }

  private onTabsClosed(tabs: readonly vscode.Tab[]): void {
    const open = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) open.add(tab.input.uri.toString());
      }
    }
    for (const tab of tabs) {
      if (tab.input instanceof vscode.TabInputText && !open.has(tab.input.uri.toString())) {
        // Fold again next time the file is opened
        this.opened.delete(tab.input.uri.toString());
      }
    }
  }

  private forget(key: string): void {
    this.blocks.delete(key);
    this.opened.delete(key);
    this.lastState.delete(key);
  }

  private onSettingsChanged(): void {
    const previous = this.settings.languages.join();
    this.settings = readSettings();
    this.blocks.clear();
    if (this.settings.languages.join() !== previous) this.registerProvider();
    vscode.window.visibleTextEditors.forEach((e) => this.updateMask(e));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new TuckImports());
}

export function deactivate(): void {}
