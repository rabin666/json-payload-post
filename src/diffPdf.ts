// Wrapper around the external `diff-pdf` tool (https://vslavik.github.io/diff-pdf/),
// launched in --view mode to show its GUI comparison window.

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

let availability: Promise<boolean> | undefined;
let runCounter = 0;
const TEMP_SUBDIR = "json-payload-post";

/**
 * Resolve whether `diff-pdf` is on the PATH, cached for the session.
 *
 * Uses `where`/`which` instead of running `diff-pdf --help`, which opens a GUI help
 * window on the Windows build.
 */
export function isDiffPdfAvailable(): Promise<boolean> {
  if (!availability) {
    availability = new Promise<boolean>((resolve) => {
      const finder = process.platform === "win32" ? "where" : "which";
      try {
        const child = spawn(finder, ["diff-pdf"], {
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
  return availability;
}

/**
 * Write both PDFs to a fresh pair of temp files and launch `diff-pdf --view`. Resolves
 * once the process is spawned; the window then runs independently. Rejects if the files
 * can't be written or the process can't start.
 *
 * Filenames are unique per call to avoid overwriting a file that an open diff-pdf window
 * still holds (a locked overwrite fails with EBUSY/EPERM on Windows).
 */
export async function runDiffPdf(
  primary: Uint8Array,
  secondary: Uint8Array,
  markDifferences = true
): Promise<void> {
  const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
  await fs.mkdir(dir, { recursive: true });
  await pruneOldFiles(dir);

  const stamp = `${Date.now()}-${runCounter++}`;
  const fileA = path.join(dir, `primary-${stamp}.pdf`);
  const fileB = path.join(dir, `secondary-${stamp}.pdf`);

  await fs.writeFile(fileA, primary);
  await fs.writeFile(fileB, secondary);

  // Guard against launching on an empty/failed write.
  const [statA, statB] = await Promise.all([fs.stat(fileA), fs.stat(fileB)]);
  if (statA.size === 0 || statB.size === 0) {
    throw new Error("One of the PDF responses was empty; nothing to compare.");
  }

  const args = ["--view"];
  if (markDifferences) {
    args.push("--mark-differences");
  }
  args.push(fileA, fileB);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("diff-pdf", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("spawn", () => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    });
  });
}

/** Remove temp PDFs from earlier comparisons; ignores files still locked by an open window. */
async function pruneOldFiles(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".pdf"))
        .map((name) => fs.unlink(path.join(dir, name)).catch(() => undefined))
    );
  } catch {
    // Directory missing or unreadable.
  }
}
