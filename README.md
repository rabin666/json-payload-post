# JSON Payload Post

A small VS Code extension for posting the JSON file you're editing to a local (or
remote) endpoint and inspecting the response — without leaving the editor.

## Features

- **Send the active JSON** as an HTTP `POST` with `Content-Type: application/json`.
- **Two servers**: a **Primary URL** (default `http://localhost:8010`, also used by the
  editor rocket button) and an optional **Secondary URL**, each with its own Send button —
  so you can fire the same JSON at two servers and compare results.
- Trigger a primary send from either:
  - the **rocket button** in the editor title bar (shown for `.json` / `.jsonc` files), or
  - the **Send** button in the panel.
- **Inline response viewer** (one per server) that detects the response type from
  `Content-Type`:
  - JSON is pretty-printed, CSV/text shown as-is, binary shown as metadata.
  - Response info is shown as a labeled grid (status, type, size, filename).
  - Non-2xx responses and network errors (e.g. `ECONNREFUSED`, timeouts) are reported
    with a description.
- **Open in editor** opens a textual response as a new editor tab with the right language
  (json/html/xml/csv/…); disabled for binary responses.
- **Save as…** writes the response body to disk, pre-filling the filename from the
  `Content-Disposition` header when the server provides one.
- **Compare PDFs (diff-pdf)**: when *both* servers return a PDF, a Compare button launches
  [`diff-pdf`](https://vslavik.github.io/diff-pdf/) in `--view` mode to open a visual
  comparison window. Shown only when both responses are PDFs; enabled only when `diff-pdf`
  is found on your `PATH`.

## Usage

1. Open the **JSON Payload Post** view from the activity bar (rocket icon).
2. Set the **Request URL** (or leave the default).
3. Open a JSON file, then click **Send** in the panel or the rocket button in the editor
   title bar.
4. Review the response; click **Save as…** to write it to a file.

## Settings

| Setting                        | Default                  | Description                                              |
| ------------------------------ | ------------------------ | -------------------------------------------------------- |
| `jsonPayloadPost.url`          | `http://localhost:8010`  | Primary URL; also used by the editor rocket button.      |
| `jsonPayloadPost.secondaryUrl` | `""`                     | Optional secondary URL for a second server.              |
| `jsonPayloadPost.timeoutMs`    | `30000`                  | Request timeout in ms (`0` disables it).                 |

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** to launch the Extension Development Host.

A mock server is included for testing different response types:

```bash
node test-server.js
```

It serves JSON at `/`, CSV at `/csv`, text at `/text`, binary at `/binary`, PDFs at
`/pdf` and `/pdf2` (for diff-pdf testing), a 422 error at `/error`, and a slow route at
`/slow` (for timeout testing) on `http://localhost:8010`.

To exercise the PDF comparison: set the Primary URL to `http://localhost:8010/pdf` and the
Secondary URL to `http://localhost:8010/pdf2`, send both, then click **Compare PDFs**.
