import { SendResult } from "./sender";

export type Target = "primary" | "secondary";

/**
 * Holds the most recent response for each server slot (primary / secondary) so the
 * "Save as...", "Open in editor", and PDF-compare actions can reuse the body without
 * re-sending. Stored in memory only.
 */
class ResponseStore {
  private results: Partial<Record<Target, SendResult>> = {};

  set(target: Target, result: SendResult): void {
    this.results[target] = result;
  }

  clear(target: Target): void {
    delete this.results[target];
  }

  /** The last response for a slot, or undefined if there is nothing stored. */
  getResult(target: Target): SendResult | undefined {
    return this.results[target];
  }

  /** The raw bytes of a slot's last response, or undefined if there is nothing to save. */
  getBytes(target: Target): { filename: string; data: Uint8Array } | undefined {
    const last = this.results[target];
    if (!last) {
      return undefined;
    }
    const data = last.bytes ?? new TextEncoder().encode(last.text ?? "");
    return { filename: last.filename, data };
  }

  /** True when both slots currently hold a PDF response. */
  bothPdf(): boolean {
    return isPdf(this.results.primary) && isPdf(this.results.secondary);
  }
}

export function isPdf(result: SendResult | undefined): boolean {
  if (!result) {
    return false;
  }
  return (
    result.contentType.toLowerCase().includes("pdf") ||
    result.filename.toLowerCase().endsWith(".pdf")
  );
}

export const responseStore = new ResponseStore();
