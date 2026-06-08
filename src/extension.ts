import * as vscode from "vscode";
import { PanelProvider } from "./panelProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("JSON Payload Post");
  const provider = new PanelProvider(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(PanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("jsonPayloadPost.send", () =>
      provider.sendActive()
    ),
    vscode.commands.registerCommand("jsonPayloadPost.showLog", () =>
      output.show(true)
    ),
    vscode.commands.registerCommand("jsonPayloadPost.downloadTemplate", () =>
      provider.downloadTemplateCommand()
    )
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
