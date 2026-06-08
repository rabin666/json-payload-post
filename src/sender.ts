// HTTP send logic and response classification for the JSON Payload Post extension.
// Uses the extension host's global `fetch` (VS Code ships Node 18+), so no HTTP
// dependency is required.

export type ResponseKind = "json" | "csv" | "text" | "binary";

/** A successful (network-level) request, regardless of HTTP status code. */
export interface SendResult {
  outcome: "response";
  /** The actual URL the request was sent to (after trimming). */
  url: string;
  ok: boolean; // true for 2xx
  status: number;
  statusText: string;
  contentType: string;
  filename: string;
  kind: ResponseKind;
  /** Present for textual responses (json/csv/text). */
  text?: string;
  /** Present for binary responses. */
  bytes?: Uint8Array;
  /** Byte length of the body, for display. */
  size: number;
  /** Raw `Content-Transfer-Encoding` response header value, if any. */
  transferEncoding?: string;
  /** True when the response is an attachment (Content-Disposition: attachment). */
  attachment?: boolean;
  /** True when the body was base64-decoded into `bytes` before being returned. */
  decoded?: boolean;
  /** What triggered decoding: the `Content-Transfer-Encoding` header, or the manual toggle. */
  decodedVia?: "header" | "toggle";
  /** True when the (undecoded) body looks like base64 — hint to offer decoding. */
  looksBase64?: boolean;
}

/** The request could not be completed (bad input, network error, timeout). */
export interface SendError {
  outcome: "error";
  message: string;
  detail?: string;
}

export type SendOutcome = SendResult | SendError;

/**
 * POST `body` to `url` with Content-Type application/json and classify the response.
 * Network/validation problems are returned as a structured SendError rather than thrown.
 */
export async function sendPayload(
  url: string,
  body: string,
  timeoutMs: number,
  decodeBase64 = false
): Promise<SendOutcome> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return { outcome: "error", message: "Request URL is empty. Set a URL first." };
  }

  // Fail early on invalid JSON rather than posting a malformed body.
  try {
    JSON.parse(body);
  } catch (e) {
    return {
      outcome: "error",
      message: "The active file is not valid JSON.",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let res: Response;
  try {
    res = await fetch(trimmedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    if (timer) {
      clearTimeout(timer);
    }
    if (e instanceof Error && e.name === "AbortError") {
      return {
        outcome: "error",
        message: `Request timed out after ${timeoutMs} ms.`,
      };
    }
    // Network-level failure: ECONNREFUSED, DNS, TLS, etc. The cause carries the detail.
    const cause = (e as { cause?: unknown })?.cause;
    return {
      outcome: "error",
      message: `Could not reach ${trimmedUrl}.`,
      detail: describeNetworkError(e, cause),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  const contentType = res.headers.get("content-type") ?? "";
  const kind = classify(contentType);
  const disposition = res.headers.get("content-disposition") ?? "";
  const transferEncoding = (res.headers.get("content-transfer-encoding") ?? "").trim();

  // An explicit base64 transfer-encoding takes precedence over the manual toggle.
  const headerSaysBase64 = transferEncoding.toLowerCase() === "base64";
  const shouldDecode = decodeBase64 || headerSaysBase64;

  // Read the body once as bytes; decode to text only when needed.
  const raw = new Uint8Array(await res.arrayBuffer());
  const base = {
    outcome: "response" as const,
    url: trimmedUrl,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    contentType,
    transferEncoding,
    attachment: /attachment/i.test(disposition),
  };

  // Body is a base64 string (optionally a data: URI) wrapping the real file.
  if (shouldDecode) {
    const asText = new TextDecoder().decode(raw);
    const cleaned = cleanBase64(asText);
    if (!cleaned || !isBase64(cleaned)) {
      return {
        outcome: "error",
        message: headerSaysBase64
          ? "Server sent 'Content-Transfer-Encoding: base64' but the body is not valid Base64."
          : "Asked to decode Base64, but the response body is not valid Base64.",
        detail: headerSaysBase64
          ? "The response was left undecoded. Check the server output."
          : 'Turn off "Decode Base64" for this server, then send again.',
      };
    }
    const decodedBytes = new Uint8Array(Buffer.from(cleaned, "base64"));
    const filename =
      parseFilename(disposition) ??
      filenameForContentType(contentType) ??
      sniffFilename(decodedBytes) ??
      defaultFilename("binary");
    return {
      ...base,
      filename,
      kind: "binary",
      bytes: decodedBytes,
      size: decodedBytes.byteLength,
      decoded: true,
      decodedVia: headerSaysBase64 ? "header" : "toggle",
    };
  }

  const looksBase64 = detectBase64(raw);

  if (kind === "binary") {
    return {
      ...base,
      filename: parseFilename(disposition) ?? defaultFilename(kind),
      kind,
      bytes: raw,
      size: raw.byteLength,
      looksBase64,
    };
  }

  return {
    ...base,
    filename: parseFilename(disposition) ?? defaultFilename(kind),
    kind,
    text: new TextDecoder().decode(raw),
    size: raw.byteLength,
    looksBase64,
  };
}

function classify(contentType: string): ResponseKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) {
    return "json";
  }
  if (ct.includes("text/csv") || ct.includes("application/csv")) {
    return "csv";
  }
  if (ct.startsWith("text/") || ct.includes("application/xml") || ct.includes("+xml")) {
    return "text";
  }
  return "binary";
}

function defaultFilename(kind: ResponseKind): string {
  switch (kind) {
    case "json":
      return "response.json";
    case "csv":
      return "response.csv";
    case "text":
      return "response.txt";
    default:
      return "response.bin";
  }
}

/**
 * Parse a filename from a Content-Disposition header. Prefers the RFC 5987
 * `filename*=` form (percent-decoded), falling back to plain `filename=`.
 */
export function parseFilename(disposition: string): string | undefined {
  if (!disposition) {
    return undefined;
  }
  const extended = /filename\*\s*=\s*(?:[^']*'[^']*')?([^;]+)/i.exec(disposition);
  if (extended) {
    const raw = extended[1].trim().replace(/^["']|["']$/g, "");
    try {
      return sanitize(decodeURIComponent(raw));
    } catch {
      return sanitize(raw);
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(disposition);
  if (plain) {
    return sanitize(plain[2].trim());
  }
  return undefined;
}

/** Strip any path components so we only ever suggest a bare filename. */
function sanitize(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.trim() || "response";
}

/** Remove a `data:...;base64,` prefix and all whitespace, leaving raw base64 chars. */
export function cleanBase64(text: string): string {
  return text
    .trim()
    .replace(/^data:[^;,]*;base64,/i, "")
    .replace(/\s+/g, "");
}

/** Whether a cleaned string is syntactically valid base64. */
export function isBase64(cleaned: string): boolean {
  return (
    cleaned.length >= 4 &&
    cleaned.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)
  );
}

/**
 * Heuristic: does this response body look like a base64-encoded payload (rather than
 * raw text or raw binary)? Used to hint the user to enable decoding.
 */
function detectBase64(raw: Uint8Array): boolean {
  if (raw.byteLength < 64) {
    return false; // too small to be a meaningful encoded file
  }
  // Sniff a prefix as ASCII; a real binary file would contain non-base64 bytes early.
  const sample = new TextDecoder("latin1").decode(raw.subarray(0, 4096));
  const cleaned = cleanBase64(sample);
  if (cleaned.length < 32) {
    return false;
  }
  // The sampled prefix (minus any trailing partial quad) must be pure base64 chars,
  // allowing up to two '=' padding chars at the very end of a fully-sampled body.
  const head = cleaned.slice(0, cleaned.length - (cleaned.length % 4));
  return /^[A-Za-z0-9+/]+={0,2}$/.test(head);
}

const CONTENT_TYPE_EXT: [string, string][] = [
  ["application/pdf", "pdf"],
  ["wordprocessingml.document", "docx"],
  ["spreadsheetml.sheet", "xlsx"],
  ["presentationml.presentation", "pptx"],
  ["application/msword", "doc"],
  ["application/vnd.ms-excel", "xls"],
  ["application/zip", "zip"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
];

/** Pick a default filename from a binary content-type, if recognized. */
function filenameForContentType(contentType: string): string | undefined {
  const ct = contentType.toLowerCase();
  for (const [needle, ext] of CONTENT_TYPE_EXT) {
    if (ct.includes(needle)) {
      return `response.${ext}`;
    }
  }
  return undefined;
}

/** Guess a file extension from the leading magic bytes of decoded binary data. */
export function sniffExtension(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return "pdf"; // %PDF
  }
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return "docx"; // PK.. (OOXML zip — docx is the common AOP case)
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpg";
  }
  return undefined;
}

/** Guess a filename from the leading magic bytes of decoded binary data. */
function sniffFilename(bytes: Uint8Array): string | undefined {
  const ext = sniffExtension(bytes);
  return ext ? `response.${ext}` : undefined;
}

function describeNetworkError(e: unknown, cause: unknown): string {
  const parts: string[] = [];
  if (cause && typeof cause === "object") {
    const c = cause as { code?: string; message?: string };
    if (c.code) {
      parts.push(c.code);
    }
    if (c.message) {
      parts.push(c.message);
    }
  }
  if (parts.length === 0 && e instanceof Error) {
    parts.push(e.message);
  }
  return parts.join(" — ") || "Unknown network error.";
}
