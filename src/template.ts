// Extracts an embedded base64 template file from the request JSON, e.g.:
//   { "template": { "file": "<base64>", "template_type": "docx" } }

import { cleanBase64, isBase64, sniffExtension } from "./sender";

export interface TemplateFile {
  bytes: Uint8Array;
  filename: string;
}

export type TemplateResult = TemplateFile | { error: string };

/** Parse `jsonText` and return the decoded `template.file`, or a descriptive error. */
export function extractTemplate(jsonText: string): TemplateResult {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return { error: "The active file is not valid JSON." };
  }

  const template = (obj as { template?: unknown })?.template;
  if (!template || typeof template !== "object") {
    return { error: 'No "template" object found in the JSON.' };
  }

  const { file, template_type: templateType } = template as {
    file?: unknown;
    template_type?: unknown;
  };
  if (typeof file !== "string" || file.trim() === "") {
    return { error: 'No "template.file" base64 string found.' };
  }

  const cleaned = cleanBase64(file);
  if (!isBase64(cleaned)) {
    return { error: '"template.file" is not valid base64.' };
  }

  const bytes = new Uint8Array(Buffer.from(cleaned, "base64"));
  const ext = extForTemplateType(templateType) ?? sniffExtension(bytes) ?? "bin";
  return { bytes, filename: `template.${ext}` };
}

/** Use template_type as the extension when it looks like one (e.g. "docx", "xlsx"). */
function extForTemplateType(t: unknown): string | undefined {
  if (typeof t === "string" && /^[a-z0-9]{1,8}$/i.test(t.trim())) {
    return t.trim().toLowerCase();
  }
  return undefined;
}
