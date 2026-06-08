import * as vscode from "vscode";
import { sendPayload, SendResult } from "./sender";
import { responseStore, Target } from "./responseStore";
import { isDiffPdfAvailable, runDiffPdf } from "./diffPdf";
import { extractTemplate } from "./template";

const CONFIG_SECTION = "jsonPayloadPost";
const VIEW_ID = "jsonPayloadPost.panel";
/** Cap the preview sent to the webview; the full body is kept in responseStore for saving. */
const PREVIEW_LIMIT = 200_000;

const URL_SETTING: Record<Target, string> = {
  primary: "url",
  secondary: "secondaryUrl",
};

const URL_DEFAULT: Record<Target, string> = {
  primary: "http://localhost:8010",
  secondary: "",
};

export class PanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = VIEW_ID;

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  /** Reveal the panel and send the active JSON to the primary server (editor button entry). */
  public async sendActive(): Promise<void> {
    const doc = resolveTargetDocument();
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (!doc) {
      vscode.window.showWarningMessage(
        "Open a JSON file and make it the active editor to send a payload."
      );
      return;
    }
    const url = getConfiguredUrl("primary");
    this.post({ type: "urlValue", target: "primary", url });
    await this.performSend("primary", url, doc, getConfiguredDecodeBase64());
  }

  private async onMessage(msg: any): Promise<void> {
    const target: Target = msg?.target === "secondary" ? "secondary" : "primary";
    switch (msg?.type) {
      case "ready":
        this.post({ type: "urlValue", target: "primary", url: getConfiguredUrl("primary") });
        this.post({ type: "urlValue", target: "secondary", url: getConfiguredUrl("secondary") });
        await this.refreshCompareState();
        return;
      case "urlChanged":
        await saveUrl(target, String(msg.url ?? ""));
        return;
      case "send": {
        const url = String(msg.url ?? "");
        await saveUrl(target, url);
        const doc = resolveTargetDocument();
        if (!doc) {
          this.post({
            type: "error",
            target,
            message: "No JSON file is active.",
            detail: "Open a JSON file and make it the active editor, then send again.",
          });
          return;
        }
        // Decode when the hint forced it or the global setting requests it; the header
        // (Content-Transfer-Encoding: base64) is handled automatically in the sender.
        const decode = Boolean(msg.decodeBase64) || getConfiguredDecodeBase64();
        await this.performSend(target, url, doc, decode);
        return;
      }
      case "save":
        await this.saveResponse(target);
        return;
      case "openInEditor":
        await this.openInEditor(target);
        return;
      case "comparePdfs":
        await this.comparePdfs();
        return;
      case "clear":
        responseStore.clear(target);
        this.output.appendLine(`[${target}] response cleared`);
        await this.refreshCompareState();
        return;
      case "downloadTemplate":
        await this.downloadTemplate();
        return;
    }
  }

  private async performSend(
    target: Target,
    url: string,
    doc: vscode.TextDocument,
    decodeBase64: boolean
  ): Promise<void> {
    this.post({ type: "sending", target, filename: doc.fileName });
    const body = doc.getText();
    const timeoutMs = getConfiguredTimeout();

    this.output.appendLine(
      `[${target}] POST ${url.trim()}  (Content-Type: application/json, body ${byteLength(body)} bytes from ${doc.fileName}${decodeBase64 ? ", decode-base64: on" : ""})`
    );
    const outcome = await sendPayload(url, body, timeoutMs, decodeBase64);

    if (outcome.outcome === "error") {
      responseStore.clear(target);
      this.output.appendLine(
        `[${target}]   -> ERROR: ${outcome.message}${outcome.detail ? " — " + outcome.detail : ""}`
      );
      this.post({ type: "error", target, message: outcome.message, detail: outcome.detail });
      await this.refreshCompareState();
      return;
    }

    responseStore.set(target, outcome);
    const stored = responseStore.getBytes(target);
    const checksum = stored ? quickChecksum(stored.data) : "n/a";
    const cteNote = outcome.transferEncoding
      ? ` · Content-Transfer-Encoding: ${outcome.transferEncoding}`
      : "";
    const decodeNote = outcome.decoded
      ? ` · base64-decoded (${outcome.decodedVia})`
      : outcome.looksBase64
        ? " · ⚠ looks like base64"
        : "";
    this.output.appendLine(
      `[${target}]   -> ${outcome.status} ${outcome.statusText} · ${outcome.contentType || "(no content-type)"}${cteNote} · ${outcome.size} bytes · ${outcome.filename}${decodeNote} · checksum ${checksum}`
    );
    this.post(buildResponseMessage(target, outcome, checksum));
    await this.refreshCompareState();

    // Optionally prompt to save straight away when the response is a downloadable file.
    if (getConfiguredAutoSave() && isFileResponse(outcome)) {
      await this.saveResponse(target);
    }
  }

  /** Confirmation toast offering to open the saved file or reveal its folder. */
  private async showSavedMessage(dest: vscode.Uri, prefix: string): Promise<void> {
    const openFile = "Open File";
    const openFolder = "Open Folder";
    const choice = await vscode.window.showInformationMessage(
      `${prefix} ${dest.fsPath}`,
      openFile,
      openFolder
    );
    if (choice === openFile) {
      await vscode.commands.executeCommand("vscode.open", dest);
    } else if (choice === openFolder) {
      await vscode.commands.executeCommand("revealFileInOS", dest);
    }
  }

  private async saveResponse(target: Target): Promise<void> {
    const saved = responseStore.getBytes(target);
    if (!saved) {
      vscode.window.showWarningMessage("There is no response to save yet.");
      return;
    }
    const defaultUri = defaultSaveUri(saved.filename);
    const dest = await vscode.window.showSaveDialog({ defaultUri });
    if (!dest) {
      return; // user cancelled
    }
    try {
      await vscode.workspace.fs.writeFile(dest, saved.data);
      await this.showSavedMessage(dest, "Saved response to");
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to save response: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Reveal the panel and download the template file from the active JSON (command entry). */
  public async downloadTemplateCommand(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.downloadTemplate();
  }

  /** Extract `template.file` (base64) from the active JSON and save it to disk. */
  private async downloadTemplate(): Promise<void> {
    const doc = resolveTargetDocument();
    if (!doc) {
      vscode.window.showWarningMessage(
        "Open the JSON payload file and make it the active editor first."
      );
      return;
    }
    const result = extractTemplate(doc.getText());
    if ("error" in result) {
      vscode.window.showWarningMessage(`Cannot download template: ${result.error}`);
      return;
    }
    const dest = await vscode.window.showSaveDialog({
      defaultUri: defaultSaveUri(result.filename),
    });
    if (!dest) {
      return; // user cancelled
    }
    try {
      await vscode.workspace.fs.writeFile(dest, result.bytes);
      this.output.appendLine(
        `[template] saved ${result.bytes.byteLength} bytes to ${dest.fsPath}`
      );
      await this.showSavedMessage(dest, "Saved template to");
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to save template: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async openInEditor(target: Target): Promise<void> {
    const result = responseStore.getResult(target);
    if (!result) {
      vscode.window.showWarningMessage("There is no response to open yet.");
      return;
    }
    if (result.text === undefined) {
      vscode.window.showWarningMessage(
        'Binary responses cannot be opened as text. Use "Save as…" instead.'
      );
      return;
    }
    const language = languageForResult(result);
    const doc = await vscode.workspace.openTextDocument({
      content: result.text,
      language,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async comparePdfs(): Promise<void> {
    const a = responseStore.getBytes("primary");
    const b = responseStore.getBytes("secondary");
    if (!a || !b || !responseStore.bothPdf()) {
      vscode.window.showWarningMessage(
        "Both servers must have returned a PDF response before comparing."
      );
      return;
    }
    if (!(await isDiffPdfAvailable())) {
      vscode.window.showErrorMessage(
        "`diff-pdf` was not found on your PATH. Install it from https://vslavik.github.io/diff-pdf/ to use this feature."
      );
      return;
    }
    const csA = quickChecksum(a.data);
    const csB = quickChecksum(b.data);
    this.output.appendLine(
      `[compare] primary checksum ${csA} vs secondary checksum ${csB}` +
        (csA === csB ? "  ⚠ IDENTICAL — both servers returned the same bytes" : "")
    );
    if (csA === csB) {
      vscode.window.showWarningMessage(
        "Both PDFs are byte-identical — diff-pdf will show no differences. See the 'JSON Payload Post' output for details.",
        "Show Log"
      ).then((c) => {
        if (c === "Show Log") {
          this.output.show(true);
        }
      });
    }
    const mark = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>("diffPdfMarkDifferences", true);
    try {
      await runDiffPdf(a.data, b.data, mark);
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to launch diff-pdf: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Tell the webview whether the Compare button should be shown / enabled. */
  private async refreshCompareState(): Promise<void> {
    const bothPdf = responseStore.bothPdf();
    const available = bothPdf ? await isDiffPdfAvailable() : false;
    this.post({ type: "compareState", bothPdf, available });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const styleUri = uri("panel.css");
    const scriptUri = uri("panel.js");
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>JSON Payload Post</title>
</head>
<body>
  <div class="toolbar">
    <button id="download-template" class="secondary" title="Decode template.file from the active JSON and save it">Download template file</button>
  </div>

  ${serverBlock("primary", "Primary URL", "Default — also used by the editor rocket button")}
  ${serverBlock("secondary", "Secondary URL", "Optional — send the same JSON to a second server")}

  <button id="compare" class="secondary compare" hidden>Compare PDFs (diff-pdf)</button>
  <div id="compare-note" class="compare-note" hidden></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function serverBlock(target: Target, label: string, hint: string): string {
  return /* html */ `
  <section class="server" data-target="${target}">
    <label class="field-label" for="url-${target}">${label}</label>
    <div class="field-hint">${hint}</div>
    <input id="url-${target}" class="url" type="text" spellcheck="false" placeholder="http://localhost:8010" />
    <div class="row">
      <span class="method-badge">POST</span>
      <button class="send primary">Send</button>
    </div>
    <div class="decode-hint" hidden></div>
    <div class="status" hidden></div>
    <div class="result" hidden>
      <div class="result-title">Response</div>
      <dl class="info-grid"></dl>
      <div class="result-actions">
        <button class="open secondary">Open in editor</button>
        <button class="save secondary">Save as…</button>
        <button class="clear secondary">Clear</button>
      </div>
      <pre class="result-body"></pre>
    </div>
  </section>`;
}

function buildResponseMessage(target: Target, r: SendResult, checksum: string) {
  const truncated = r.text !== undefined && r.text.length > PREVIEW_LIMIT;
  const preview = r.text !== undefined ? r.text.slice(0, PREVIEW_LIMIT) : undefined;
  return {
    type: "response" as const,
    target,
    url: r.url,
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    contentType: r.contentType,
    kind: r.kind,
    filename: r.filename,
    size: r.size,
    checksum,
    transferEncoding: r.transferEncoding ?? "",
    decoded: r.decoded === true,
    decodedVia: r.decodedVia,
    looksBase64: r.looksBase64 === true,
    preview,
    truncated,
  };
}

/** Byte length of a UTF-8 string. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Fast non-cryptographic checksum (FNV-1a) for spotting byte-identical responses. */
function quickChecksum(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + `/${data.length}b`;
}

/** Map a textual response to a VS Code language id for the editor tab. */
function languageForResult(r: SendResult): string {
  const ct = r.contentType.toLowerCase();
  const byContentType: [string, string][] = [
    ["html", "html"],
    ["xml", "xml"],
    ["json", "json"],
    ["csv", "csv"],
    ["javascript", "javascript"],
    ["markdown", "markdown"],
    ["css", "css"],
    ["yaml", "yaml"],
  ];
  for (const [needle, lang] of byContentType) {
    if (ct.includes(needle)) {
      return lang;
    }
  }
  const ext = r.filename.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    json: "json",
    html: "html",
    htm: "html",
    xml: "xml",
    csv: "csv",
    js: "javascript",
    md: "markdown",
    css: "css",
    yaml: "yaml",
    yml: "yaml",
  };
  return byExt[ext] ?? "plaintext";
}

/** Pick the JSON document to send: the active editor, else the first visible JSON editor. */
function resolveTargetDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isJson(active)) {
    return active;
  }
  const visible = vscode.window.visibleTextEditors.find((e) => isJson(e.document));
  return visible?.document;
}

function isJson(doc: vscode.TextDocument): boolean {
  return doc.languageId === "json" || doc.languageId === "jsonc";
}

function getConfiguredUrl(target: Target): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(URL_SETTING[target], URL_DEFAULT[target]);
}

function getConfiguredTimeout(): number {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>("timeoutMs", 300000);
}

function getConfiguredDecodeBase64(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("decodeBase64", false);
}

function getConfiguredAutoSave(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("autoSaveFileResponses", false);
}

/** A response is treated as a file when it's binary, base64-decoded, or an attachment. */
function isFileResponse(r: SendResult): boolean {
  return r.kind === "binary" || r.decoded === true || r.attachment === true;
}

async function saveUrl(target: Target, url: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const key = URL_SETTING[target];
  if (url === config.get<string>(key)) {
    return;
  }
  const scope = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config.update(key, url, scope);
}

function defaultSaveUri(filename: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder) {
    return vscode.Uri.joinPath(folder, filename);
  }
  return vscode.Uri.file(filename);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
