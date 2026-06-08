# JSON Payload Post

A VS Code extension for POSTing the JSON file you're editing to an HTTP endpoint and
inspecting the response without leaving the editor.

## Features

- Sends the active JSON file as an HTTP `POST` with `Content-Type: application/json`.
- Two configurable targets: a primary URL (default `http://localhost:8010`, also used by
  the editor title-bar button) and an optional secondary URL, each with its own Send
  button. This makes it easy to send the same payload to two servers and compare results.
- A send can be triggered from the rocket button in the editor title bar (shown for
  `.json`/`.jsonc` files) or the Send button in the panel.
- Per-server response viewer that classifies the body from `Content-Type`: JSON is
  pretty-printed, CSV/text shown verbatim, binary shown as metadata. Status, type, size,
  and filename appear in a labeled grid. Non-2xx responses and network errors
  (`ECONNREFUSED`, timeouts, etc.) are reported with a description.
- Open in editor: opens a textual response in a new tab with a matching language
  (json/html/xml/csv/…). Disabled for binary responses.
- Save as: writes the response body to disk, defaulting the filename from the
  `Content-Disposition` header when present.
- Base64 decoding: backends such as AOP/Apex Office Print may return a file as a base64
  string rather than raw bytes, which otherwise saves as a corrupt, ~33% larger file. The
  extension decodes automatically when the response carries
  `Content-Transfer-Encoding: base64`. Bodies that look like base64 without that header
  surface a one-click "Decode & re-send"; `jsonPayloadPost.decodeBase64` forces decoding
  as a fallback.
- Download template file: when the payload embeds a base64 template, e.g.
  `{ "template": { "file": "<base64>", "template_type": "docx" } }`, the toolbar button
  decodes `template.file` and saves it, using `template_type` for the extension and
  falling back to magic-byte detection. Also available as the "JSON Payload Post: Download
  Template File" command.
- PDF comparison: when both servers return a PDF, a Compare button runs
  [diff-pdf](https://vslavik.github.io/diff-pdf/) in `--view` mode (with
  `--mark-differences`) to open a visual comparison. The button is shown only when both
  responses are PDFs and `diff-pdf` is on the `PATH`.

## Usage

1. Open the JSON Payload Post view from the activity bar.
2. Set the primary URL (or keep the default).
3. Open a JSON file and click Send in the panel, or use the rocket button in the editor
   title bar.
4. Review the response and use Save as / Open in editor as needed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `jsonPayloadPost.url` | `http://localhost:8010` | Primary URL; also used by the editor title-bar button. |
| `jsonPayloadPost.secondaryUrl` | `""` | Optional secondary URL. |
| `jsonPayloadPost.timeoutMs` | `300000` | Request timeout in ms (`0` disables it). |
| `jsonPayloadPost.decodeBase64` | `false` | Force base64 decoding (fallback for servers that send no header). |
| `jsonPayloadPost.diffPdfMarkDifferences` | `true` | Pass `--mark-differences` to diff-pdf. |
| `jsonPayloadPost.autoSaveFileResponses` | `false` | Open the Save As dialog automatically for file responses. |

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press F5 to launch the Extension Development Host.

A mock server is included for exercising the different response types:

```bash
node test-server.js
```

It listens on `http://localhost:8010` and serves JSON at `/`, CSV at `/csv`, text at
`/text`, binary at `/binary`, PDFs at `/pdf` and `/pdf2`, a base64-encoded PDF at
`/base64`, a 422 error at `/error`, and a slow route at `/slow`.

To exercise the PDF comparison, point the primary URL at `/pdf` and the secondary at
`/pdf2`, send both, then click Compare PDFs.
