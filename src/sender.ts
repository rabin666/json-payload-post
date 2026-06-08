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
  timeoutMs: number
): Promise<SendOutcome> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return { outcome: "error", message: "Request URL is empty. Set a URL first." };
  }

  // Validate JSON up front so we fail with a clear message instead of sending garbage.
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
  const filename = parseFilename(disposition) ?? defaultFilename(kind);

  if (kind === "binary") {
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      outcome: "response",
      url: trimmedUrl,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType,
      filename,
      kind,
      bytes: buf,
      size: buf.byteLength,
    };
  }

  const text = await res.text();
  return {
    outcome: "response",
    url: trimmedUrl,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    contentType,
    filename,
    kind,
    text,
    size: byteLength(text),
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
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
