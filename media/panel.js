(function () {
  const vscode = acquireVsCodeApi();

  const compareBtn = document.getElementById("compare");
  const compareNote = document.getElementById("compare-note");

  // Per-server-block element references and helpers, keyed by target.
  const cards = {};
  document.querySelectorAll("section.server").forEach((section) => {
    const target = section.getAttribute("data-target");
    const card = {
      target,
      urlInput: section.querySelector(".url"),
      sendBtn: section.querySelector(".send"),
      openBtn: section.querySelector(".open"),
      saveBtn: section.querySelector(".save"),
      statusEl: section.querySelector(".status"),
      resultEl: section.querySelector(".result"),
      infoEl: section.querySelector(".info-grid"),
      bodyEl: section.querySelector(".result-body"),
    };
    cards[target] = card;
    wireCard(card);
  });

  // Restore prior URLs (survives the webview being hidden/disposed).
  const prev = vscode.getState() || {};
  for (const target of Object.keys(cards)) {
    if (prev[target] && typeof prev[target] === "string") {
      cards[target].urlInput.value = prev[target];
    }
  }

  function saveState() {
    const state = {};
    for (const target of Object.keys(cards)) {
      state[target] = cards[target].urlInput.value;
    }
    vscode.setState(state);
  }

  function wireCard(card) {
    function send() {
      card.sendBtn.disabled = true;
      card.sendBtn.textContent = "Sending…";
      showStatus(card, "");
      vscode.postMessage({
        type: "send",
        target: card.target,
        url: card.urlInput.value.trim(),
      });
    }

    card.sendBtn.addEventListener("click", send);
    card.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        send();
      }
    });
    card.urlInput.addEventListener("change", () => {
      saveState();
      vscode.postMessage({
        type: "urlChanged",
        target: card.target,
        url: card.urlInput.value.trim(),
      });
    });
    card.saveBtn.addEventListener("click", () =>
      vscode.postMessage({ type: "save", target: card.target })
    );
    card.openBtn.addEventListener("click", () =>
      vscode.postMessage({ type: "openInEditor", target: card.target })
    );
  }

  compareBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "comparePdfs" })
  );

  function setSending(card, sending) {
    card.sendBtn.disabled = sending;
    card.sendBtn.textContent = sending ? "Sending…" : "Send";
  }

  function showStatus(card, text) {
    card.statusEl.hidden = !text;
    card.statusEl.textContent = text || "";
  }

  function humanSize(bytes) {
    if (bytes < 1024) {
      return bytes + " B";
    }
    if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function infoRow(label, valueHtml) {
    return "<dt>" + escapeHtml(label) + "</dt><dd>" + valueHtml + "</dd>";
  }

  function renderResponse(card, msg) {
    setSending(card, false);
    showStatus(card, "");
    card.resultEl.hidden = false;
    card.resultEl.classList.toggle("ok", msg.ok);
    card.resultEl.classList.toggle("error", !msg.ok);

    const statusHtml =
      '<span class="status-code">' +
      msg.status +
      " " +
      escapeHtml(msg.statusText || "") +
      "</span>";

    const rows = [
      infoRow("URL", escapeHtml(msg.url || "")),
      infoRow("Status", statusHtml),
      infoRow("Type", escapeHtml(msg.contentType || "(none)")),
      infoRow("Size", humanSize(msg.size)),
      infoRow("Filename", escapeHtml(msg.filename)),
    ];
    if (msg.checksum) {
      rows.push(infoRow("Checksum", escapeHtml(msg.checksum)));
    }
    card.infoEl.innerHTML = rows.join("");

    card.saveBtn.disabled = false;
    card.openBtn.disabled = msg.kind === "binary";

    if (msg.kind === "binary") {
      card.bodyEl.classList.add("notice");
      card.bodyEl.textContent =
        "Binary response (" +
        humanSize(msg.size) +
        ').\nUse "Save as…" to write it to disk as ' +
        msg.filename +
        ".";
      return;
    }

    card.bodyEl.classList.remove("notice");
    let text = msg.preview != null ? msg.preview : "";
    if (msg.kind === "json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not valid JSON despite the header — show as-is.
      }
    }
    if (msg.truncated) {
      text += "\n\n… preview truncated. Full body available via Save as….";
    }
    card.bodyEl.textContent = text;
  }

  function renderError(card, msg) {
    setSending(card, false);
    card.resultEl.hidden = false;
    card.resultEl.classList.remove("ok");
    card.resultEl.classList.add("error");
    card.infoEl.innerHTML = infoRow(
      "Status",
      '<span class="status-code">Request failed</span>'
    );
    card.saveBtn.disabled = true;
    card.openBtn.disabled = true;
    card.bodyEl.classList.add("notice");
    const detail = msg.detail ? "\n\n" + msg.detail : "";
    card.bodyEl.innerHTML =
      '<span class="error-text">' + escapeHtml(msg.message + detail) + "</span>";
  }

  function updateCompare(msg) {
    compareBtn.hidden = !msg.bothPdf;
    compareNote.hidden = !msg.bothPdf;
    if (!msg.bothPdf) {
      return;
    }
    compareBtn.disabled = !msg.available;
    if (msg.available) {
      compareNote.textContent = "Both responses are PDFs.";
      compareNote.classList.remove("warn");
      compareBtn.title = "Open a diff-pdf comparison window";
    } else {
      compareNote.textContent =
        "Both responses are PDFs, but diff-pdf was not found on your PATH.";
      compareNote.classList.add("warn");
      compareBtn.title = "Install diff-pdf and add it to your PATH";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    const card = msg.target ? cards[msg.target] : undefined;
    switch (msg.type) {
      case "urlValue":
        if (card) {
          card.urlInput.value = msg.url || "";
          saveState();
        }
        break;
      case "sending":
        if (card) {
          setSending(card, true);
          showStatus(card, "Sending payload…");
        }
        break;
      case "response":
        if (card) {
          renderResponse(card, msg);
        }
        break;
      case "error":
        if (card) {
          renderError(card, msg);
        }
        break;
      case "compareState":
        updateCompare(msg);
        break;
    }
  });

  // Tell the extension we're ready so it can seed the URL fields from settings.
  vscode.postMessage({ type: "ready" });
})();
