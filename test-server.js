// Tiny mock server for exercising the JSON Payload Post extension.
// Run with: node test-server.js   (listens on http://localhost:8010)
//
// Routes (all accept POST):
//   /            -> echoes the posted JSON as application/json
//   /csv         -> text/csv with a Content-Disposition filename
//   /text        -> text/plain
//   /binary      -> application/octet-stream with a filename
//   /error       -> 422 with an error description body
//   /slow        -> responds after 40s (to test the timeout)

const http = require("http");

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url || "/";

    if (url.startsWith("/csv")) {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="data.csv"',
      });
      res.end("id,name,score\n1,alice,90\n2,bob,75\n");
      return;
    }

    if (url.startsWith("/text")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Plain text response.\nReceived " + body.length + " bytes.\n");
      return;
    }

    if (url.startsWith("/pdf2")) {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="secondary.pdf"',
      });
      res.end(makePdf("Secondary server"));
      return;
    }

    if (url.startsWith("/pdf")) {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="primary.pdf"',
      });
      res.end(makePdf("Primary server"));
      return;
    }

    if (url.startsWith("/binary")) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="payload.bin"',
      });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
      return;
    }

    if (url.startsWith("/error")) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Validation failed", field: "name", reason: "required" })
      );
      return;
    }

    if (url.startsWith("/slow")) {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"slow":true}');
      }, 40000);
      return;
    }

    // Default: echo the JSON back.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: safeParse(body), at: new Date().toISOString() }, null, 2));
  });
});

// Build a minimal but valid single-page PDF containing `text`, with a correct xref table.
function makePdf(text) {
  const stream = "BT /F1 24 Tf 36 72 Td (" + text + ") Tj ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    "<</Length " + stream.length + ">>\nstream\n" + stream + "\nendstream",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += i + 1 + " 0 obj\n" + body + "\nendobj\n";
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += "xref\n0 " + (objects.length + 1) + "\n";
  pdf += "0000000000 65535 f \n";
  offsets.forEach((off) => {
    pdf += String(off).padStart(10, "0") + " 00000 n \n";
  });
  pdf +=
    "trailer\n<</Size " +
    (objects.length + 1) +
    "/Root 1 0 R>>\nstartxref\n" +
    xrefStart +
    "\n%%EOF";
  return Buffer.from(pdf, "latin1");
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

server.listen(8010, () => {
  console.log("Mock server listening on http://localhost:8010");
});
