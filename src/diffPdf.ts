// Integration with the external `diff-pdf` tool (https://vslavik.github.io/diff-pdf/).
// We launch it in --view mode to open its GUI comparison window.

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

let availability: Promise<boolean> | undefined;
/** Monotonic counter so each comparison gets a distinct pair of temp files. */
let runCounter = 0;
const TEMP_SUBDIR = "json-payload-post";

/** Whether `diff-pdf` can be found on the PATH. Result is cached for the session. */
export function isDiffPdfAvailable(): Promise<boolean> {
  if (!availability) {
    availability = new Promise<boolean>((resolve) => {
      try {
        const child = spawn("diff-pdf", ["--help"], { stdio: "ignore" });
        child.on("error", () => resolve(false)); // ENOENT — not installed / not on PATH
        child.on("exit", () => resolve(true)); // ran, regardless of exit code
      } catch {
        resolve(false);
      }
    });
  }
  return availability;
}

/**
 * Write both PDF buffers to a UNIQUE pair of temp files and launch `diff-pdf --view`
 * to open a comparison window. Resolves once the process has been spawned (the window
 * stays open independently). Rejects if the files can't be written or diff-pdf can't
 * be launched.
 *
 * Each call uses fresh filenames so we never overwrite a file that a previously opened
 * diff-pdf window is still holding open (which on Windows fails with EBUSY/EPERM and was
 * the cause of intermittent failures).
 */
export async function runDiffPdf(
  primary: Uint8Array,
  secondary: Uint8Array
): Promise<void> {
  const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  await pruneOldFiles(dir);

  const stamp = `${Date.now()}-${runCounter++}`;
  const fileA = path.join(dir, `primary-${stamp}.pdf`);
  const fileB = path.join(dir, `secondary-${stamp}.pdf`);

  await fs.writeFile(fileA, primary);
  await fs.writeFile(fileB, secondary);

  // Make sure both files actually landed and are non-empty before launching.
  const [statA, statB] = await Promise.all([fs.stat(fileA), fs.stat(fileB)]);
  if (statA.size === 0 || statB.size === 0) {
    throw new Error("One of the PDF responses was empty; nothing to compare.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("diff-pdf", ["--view", fileA, fileB], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    // Give the spawn a tick to fail fast on ENOENT; otherwise consider it launched.
    child.on("spawn", () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}

/**
 * Best-effort removal of temp PDFs from previous comparisons. Files that are still
 * locked by an open diff-pdf window will fail to delete — that's fine, we ignore it
 * and never reuse a name anyway.
 */
async function pruneOldFiles(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".pdf"))
        .map((name) => fs.unlink(path.join(dir, name)).catch(() => undefined))
    );
  } catch {
    // Directory unreadable or already gone — nothing to prune.
  }
}
