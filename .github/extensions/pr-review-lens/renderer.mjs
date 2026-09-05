export function renderHtml(instanceId) {
    const encodedInstanceId = JSON.stringify(instanceId).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR Review Lens</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--background-color-default, #fff);
      --panel: var(--background-color-secondary, #f6f8fa);
      --border: var(--border-color-default, #d0d7de);
      --text: var(--text-color-default, #1f2328);
      --muted: var(--text-color-muted, #656d76);
      --accent: var(--true-color-blue, #0969da);
      --accent-muted: var(--true-color-blue-muted, #ddf4ff);
      --danger: var(--true-color-red, #cf222e);
      --warning: #9a6700;
      --success: #1a7f37;
      --code-bg: #161b22;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 15px; margin-bottom: 6px; }
    button, textarea {
      font: inherit;
      color: inherit;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    button { cursor: pointer; padding: 6px 10px; background: var(--panel); }
    button:hover { border-color: var(--accent); }
    button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
    textarea { width: 100%; padding: 8px; resize: vertical; min-height: 86px; }
    .topbar, .toolbar, .status-line, .group-heading, .group-meta, .file-list, .evidence-list, .related-list {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .topbar { justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .topbar p, .muted, .hint { color: var(--muted); }
    .topbar p { margin-bottom: 0; }
    .toolbar { flex-shrink: 0; }
    .input-panel, .panel, .group-card, .empty, .unparsed {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .input-panel { padding: 12px; margin-bottom: 16px; }
    .input-panel summary, details summary { cursor: pointer; font-weight: 600; }
    .input-content { padding-top: 10px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; }
    .hint { font-size: 12px; margin: 6px 0 0; }
    .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
    .status-line { flex-wrap: wrap; margin: 6px 0 16px; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .status-cached { color: var(--muted); background: var(--panel); }
    .status-analyzing { color: var(--warning); background: color-mix(in srgb, #d4a72c 18%, transparent); }
    .status-ai-updated { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
    .status-error { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .impact-high { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .impact-medium { color: var(--warning); background: color-mix(in srgb, #d4a72c 18%, transparent); }
    .impact-low { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
    .overview { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
    .stat { min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    .stat strong { display: block; font-size: 20px; line-height: 24px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(250px, .75fr); gap: 16px; align-items: start; }
    .panel, .group-card, .unparsed { padding: 12px; margin-bottom: 12px; }
    .panel h2 { margin-bottom: 8px; }
    .toc { margin: 0; padding-left: 20px; }
    .toc li { margin: 6px 0; }
    a { color: var(--accent); }
    .group-card { background: var(--bg); scroll-margin-top: 12px; }
    .group-heading { align-items: flex-start; justify-content: space-between; }
    .group-heading h3 { margin-bottom: 2px; }
    .role { color: var(--muted); font-size: 12px; }
    .group-summary { margin: 8px 0; }
    .group-meta, .file-list, .evidence-list, .related-list { flex-wrap: wrap; }
    .file-chip, .meta-chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--muted); font-size: 12px; }
    .file-chip { text-decoration: none; }
    .evidence { margin: 10px 0; padding: 8px; border-left: 3px solid var(--accent); background: var(--panel); }
    .evidence-list, .related-list { list-style: none; padding: 0; margin: 5px 0 0; }
    .evidence-list li, .related-list li { margin: 2px 0; }
    .diff {
      overflow: auto;
      max-height: 480px;
      margin: 10px 0;
      padding: 10px;
      border-radius: 6px;
      background: var(--code-bg);
      color: #e6edf3;
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 12px;
      line-height: 18px;
      white-space: pre;
    }
    .diff-line-add { color: #aff5b4; background: rgba(46, 160, 67, .18); }
    .diff-line-del { color: #ffb3b3; background: rgba(248, 81, 73, .18); }
    .uncertainty { color: var(--muted); font-size: 12px; }
    .ai-error { color: var(--danger); margin: 8px 0; }
    .empty { padding: 18px; color: var(--muted); text-align: center; }
    #toast { position: fixed; right: 16px; bottom: 16px; max-width: 320px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: 0 4px 18px rgba(0,0,0,.16); }
    .hidden { display: none !important; }
    @media (max-width: 980px) { .overview { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 760px) {
      body { padding: 14px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div>
      <h1 id="title">PR Review Lens</h1>
      <p>差分を意味単位で読み解く、読み取り専用のレビュー・ストーリー</p>
      <div class="status-line"><span id="status" class="badge"></span><span id="updatedAt" class="muted"></span><span id="language" class="meta-chip"></span></div>
    </div>
    <div class="toolbar"><button id="refresh">再読み込み</button></div>
  </header>

  <details class="input-panel" open>
    <summary>レビュー対象のUnified Diff</summary>
    <div class="input-content">
      <label for="diffInput">差分を貼り付け</label>
      <textarea id="diffInput" rows="8" placeholder="git diff またはPull RequestのUnified Diffを貼り付けてください"></textarea>
      <p class="hint">差分はCanvas内で決定的に解析され、候補を先に表示します。エージェントの要約更新後も、表示は読み取り専用です。</p>
      <div class="actions"><button class="primary" id="loadDiff">解析して表示</button></div>
    </div>
  </details>

  <section class="overview" id="overview"></section>
  <div id="unparsed"></div>
  <div class="layout">
    <main>
      <div class="group-heading"><h2>レビュー・ストーリー</h2><span class="muted">重要度・変更量・パス順</span></div>
      <div id="groups"></div>
    </main>
    <aside>
      <section class="panel">
        <h2>目次</h2>
        <ol id="toc" class="toc"></ol>
      </section>
      <section class="panel">
        <h2>説明の読み方</h2>
        <p class="hint">結論（要約）、証拠（ファイルとハンク）、影響（重要度）、不確実性の3層で整理しています。高影響グループは詳細が表示されます。</p>
      </section>
    </aside>
  </div>
  <div id="toast" class="hidden" role="status"></div>

  <script>
    window.__INSTANCE_ID__ = ${encodedInstanceId};
    (function () {
      var state = null;
      var toastTimer;
      var diffInput = document.getElementById("diffInput");
      var STATUS_LABELS = { cached: "決定的解析済み", analyzing: "解析中", "ai-updated": "AI要約反映済み", error: "解析/AIエラー（決定的状態を保持）" };
      var IMPACT_LABELS = { high: "高影響", medium: "中影響", low: "低影響" };

      function request(path, options) {
        var config = options || {};
        config.headers = Object.assign({ "Content-Type": "application/json" }, config.headers || {});
        return fetch(path, config).then(function (response) {
          return response.text().then(function (text) {
            var payload = text ? JSON.parse(text) : {};
            if (!response.ok) throw new Error(payload.error || "リクエストに失敗しました。");
            return payload;
          });
        });
      }
      function showToast(message) {
        var toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.remove("hidden");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.add("hidden"); }, 3200);
      }
      function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function impactValue(group) {
        var impact = group.impact || {};
        var level = typeof impact === "string" ? impact : impact.level;
        if (!IMPACT_LABELS[level]) level = "medium";
        return { level: level, score: typeof impact === "object" ? impact.score : "" };
      }
      function impactBadge(group) {
        var impact = impactValue(group);
        return element("span", "badge impact-" + impact.level, IMPACT_LABELS[impact.level] + (impact.score !== "" ? " · " + impact.score : ""));
      }
      function diffLineClass(line) {
        if (line.indexOf("+") === 0 && line.indexOf("+++") !== 0) return "diff-line-add";
        if (line.indexOf("-") === 0 && line.indexOf("---") !== 0) return "diff-line-del";
        return "";
      }
      function renderDiff(target, text) {
        target.textContent = "";
        String(text || "").split("\\n").forEach(function (line) {
          target.appendChild(element("span", diffLineClass(line), line + "\\n"));
        });
      }
      function renderOverview() {
        var target = document.getElementById("overview");
        target.textContent = "";
        var stats = state.stats || {};
        [["files", "変更ファイル"], ["additions", "追加行"], ["deletions", "削除行"], ["groups", "グループ"], ["highImpact", "高影響"], ["diffLines", "差分行"]].forEach(function (item) {
          var stat = element("div", "stat");
          stat.appendChild(element("strong", "", String(stats[item[0]] || 0)));
          stat.appendChild(element("span", "", item[1]));
          target.appendChild(stat);
        });
      }
      function renderEvidence(group, card) {
        var evidence = element("div", "evidence");
        evidence.appendChild(element("strong", "", "証拠"));
        var list = element("ul", "evidence-list");
        (group.evidence || []).forEach(function (item) {
          var line = "";
          if (item.lineStart) {
            line = ":" + item.lineStart;
            if (item.lineEnd && item.lineEnd !== item.lineStart) line += "-" + item.lineEnd;
          }
          var link = element("a", "", (item.file || "差分") + line);
          link.href = "#group-" + group.id;
          link.title = item.reason || item.hunk || "グループの差分へ移動";
          var li = element("li");
          li.appendChild(link);
          if (item.hunk) li.appendChild(element("span", "muted", " " + item.hunk));
          list.appendChild(li);
        });
        if (!list.children.length) list.appendChild(element("li", "muted", "ファイル単位の証拠（詳細行なし）"));
        evidence.appendChild(list);
        card.appendChild(evidence);
      }
      function renderGroup(group) {
        var card = element("article", "group-card");
        card.id = "group-" + group.id;
        var heading = element("div", "group-heading");
        var headingText = element("div");
        headingText.appendChild(element("h3", "", group.title || "変更"));
        headingText.appendChild(element("div", "role", "役割: " + (group.role || "implementation")));
        heading.appendChild(headingText);
        heading.appendChild(impactBadge(group));
        card.appendChild(heading);
        card.appendChild(element("p", "group-summary", group.summary || group.description || "要約なし"));
        var meta = element("div", "group-meta");
        var files = element("div", "file-list");
        (group.files || []).forEach(function (file) {
          var link = element("a", "file-chip", file.path + " +" + (file.additions || 0) + " -" + (file.deletions || 0));
          link.href = "#group-" + group.id;
          files.appendChild(link);
        });
        meta.appendChild(files);
        var impact = group.impact || {};
        if (typeof impact === "object" && impact.reason) meta.appendChild(element("span", "meta-chip", impact.reason));
        card.appendChild(meta);
        renderEvidence(group, card);
        if ((group.relatedGroups || []).length) {
          var related = element("div", "related");
          related.appendChild(element("strong", "", "関連グループ"));
          var list = element("ul", "related-list");
          group.relatedGroups.forEach(function (id) {
            var link = element("a", "", id);
            link.href = "#group-" + id;
            var li = element("li"); li.appendChild(link); list.appendChild(li);
          });
          related.appendChild(list);
          card.appendChild(related);
        }
        if (group.uncertainty) card.appendChild(element("p", "uncertainty", "不確実性: " + group.uncertainty));
        if (group.aiError) card.appendChild(element("p", "ai-error", "AI更新: " + group.aiError));
        if (group.detail) {
          var details = document.createElement("details");
          details.open = impactValue(group).level === "high";
          details.appendChild(element("summary", "", "詳細"));
          details.appendChild(element("p", "", group.detail));
          card.appendChild(details);
        }
        var diff = element("pre", "diff");
        renderDiff(diff, group.diff);
        card.appendChild(diff);
        return card;
      }
      function renderGroups() {
        var target = document.getElementById("groups");
        var toc = document.getElementById("toc");
        target.textContent = ""; toc.textContent = "";
        var groups = state.groups || [];
        if (!groups.length) {
          target.appendChild(element("div", "empty", "差分を入力すると、決定的な候補グループがここに表示されます。"));
          return;
        }
        groups.forEach(function (group) {
          var item = element("li");
          var link = element("a", "", group.title || "変更");
          link.href = "#group-" + group.id;
          item.appendChild(link);
          item.appendChild(element("span", "muted", " · " + (impactValue(group).level || "medium")));
          toc.appendChild(item);
          target.appendChild(renderGroup(group));
        });
      }
      function renderUnparsed() {
        var target = document.getElementById("unparsed");
        target.textContent = "";
        if (!(state.unparsedFiles || []).length && !state.unparsedReason) return;
        var box = element("section", "unparsed");
        box.appendChild(element("strong", "", "未解析の差分"));
        box.appendChild(element("p", "", state.unparsedReason || "一部の差分を解析できませんでした。"));
        if ((state.unparsedFiles || []).length) box.appendChild(element("p", "muted", "対象: " + state.unparsedFiles.join(", ")));
        target.appendChild(box);
      }
      function render() {
        if (!state) return;
        document.getElementById("title").textContent = state.title || "PRレビュー補助";
        var status = state.analysisStatus || "cached";
        var statusNode = document.getElementById("status");
        statusNode.className = "badge status-" + status;
        statusNode.textContent = STATUS_LABELS[status] || status;
        document.getElementById("updatedAt").textContent = state.updatedAt ? "更新: " + new Date(state.updatedAt).toLocaleString() : "";
        document.getElementById("language").textContent = "言語: " + (state.language || "ja");
        if (document.activeElement !== diffInput) diffInput.value = state.diff || "";
        renderOverview(); renderUnparsed(); renderGroups();
      }
      document.getElementById("loadDiff").addEventListener("click", function () {
        var diff = diffInput.value;
        if (!diff.trim()) { showToast("差分を貼り付けてください。"); return; }
        request("/api/load", { method: "POST", body: JSON.stringify({ diff: diff }) })
          .then(function (next) { state = next; render(); showToast("決定的な候補を解析しました。"); })
          .catch(function (error) { showToast(error.message); });
      });
      document.getElementById("refresh").addEventListener("click", function () {
        request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      });
      request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      var events = new EventSource("/events");
      events.addEventListener("state", function (event) {
        try { state = JSON.parse(event.data); render(); }
        catch { showToast("Canvas状態の更新を読み込めませんでした。"); }
      });
    }());
  </script>
</body>
</html>`;
}
