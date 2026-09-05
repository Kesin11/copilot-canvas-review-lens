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
      --bg: var(--background-color-default, #ffffff);
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
    button, input, textarea, select {
      font: inherit;
      color: inherit;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    button {
      cursor: pointer;
      padding: 6px 10px;
      background: var(--panel);
    }
    button:hover { border-color: var(--accent); }
    button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
    button.ghost { background: transparent; }
    textarea, input, select { width: 100%; padding: 7px 8px; }
    textarea { resize: vertical; min-height: 72px; }
    .topbar, .toolbar, .actions, .meta, .summary, .section-heading, .section-footer {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .topbar { justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .topbar p, .hint, .muted { color: var(--muted); }
    .topbar p { margin-bottom: 0; }
    .toolbar { flex-shrink: 0; }
    .input-panel, .panel, .section-card, .empty {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .input-panel { padding: 12px; margin-bottom: 16px; }
    .input-panel summary { cursor: pointer; font-weight: 600; }
    .input-content { padding-top: 10px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; }
    .hint { font-size: 12px; margin: 6px 0 0; }
    .actions { justify-content: flex-end; margin-top: 8px; }
    .summary { flex-wrap: wrap; margin-bottom: 16px; }
    .stat {
      min-width: 110px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .stat strong { display: block; font-size: 20px; line-height: 24px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .85fr); gap: 16px; align-items: start; }
    .section-heading { justify-content: space-between; margin-bottom: 10px; }
    .section-heading h2 { margin-bottom: 0; }
    .section-card { padding: 12px; margin-bottom: 12px; background: var(--bg); }
    .section-heading-card { align-items: flex-start; justify-content: space-between; }
    .section-heading-card input { font-weight: 600; }
    .section-description { margin: 8px 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .importance-high { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .importance-medium { color: var(--warning); background: color-mix(in srgb, #d4a72c 18%, transparent); }
    .importance-low { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
    .section-grid { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 8px; }
    .section-meta { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
    .file-chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--muted); font-size: 12px; }
    .diff {
      overflow: auto;
      max-height: 360px;
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
    .review-questions { margin: 8px 0; padding: 8px 8px 8px 26px; border-left: 3px solid var(--accent); background: var(--panel); }
    .review-questions li { margin: 3px 0; }
    .section-footer { justify-content: flex-end; }
    .panel { padding: 12px; margin-bottom: 12px; }
    .panel h2 { display: flex; justify-content: space-between; align-items: center; }
    .graph { display: grid; gap: 6px; margin-bottom: 10px; }
    .node { padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
    .node small { display: block; color: var(--muted); }
    .edge { color: var(--muted); font-size: 12px; padding-left: 10px; }
    .mermaid-view {
      overflow: auto;
      min-height: 120px;
      margin: 0;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    .mermaid-view svg {
      display: block;
      min-width: 260px;
      max-width: none;
    }
    .mermaid-view .diagram-node {
      fill: var(--background-color-default, #ffffff);
      stroke: var(--border-color-default, #d0d7de);
      stroke-width: 1.5;
    }
    .mermaid-view .diagram-edge {
      stroke: var(--text-color-muted, #656d76);
      stroke-width: 1.5;
    }
    .mermaid-view .diagram-arrow {
      fill: var(--text-color-muted, #656d76);
    }
    .mermaid-view .diagram-lifeline {
      stroke: var(--border-color-default, #d0d7de);
      stroke-dasharray: 4 4;
    }
    .mermaid-view text {
      fill: var(--text-color-default, #1f2328);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 12px;
    }
    .mermaid-view .diagram-muted {
      fill: var(--text-color-muted, #656d76);
    }
    .diagram-source {
      margin-top: 8px;
    }
    .diagram-source summary {
      cursor: pointer;
      color: var(--text-color-muted, #656d76);
      font-size: 12px;
    }
    .diagram-source pre {
      overflow: auto;
      margin: 0;
      padding: 8px;
      border-radius: 6px;
      background: var(--code-bg);
      color: #e6edf3;
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 11px;
      line-height: 16px;
      white-space: pre;
    }
    .diagram-fallback {
      margin: 0;
      color: var(--text-color-muted, #656d76);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .empty { padding: 18px; color: var(--muted); text-align: center; }
    #toast { position: fixed; right: 16px; bottom: 16px; max-width: 320px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: 0 4px 18px rgba(0,0,0,.16); }
    .hidden { display: none !important; }
    @media (max-width: 850px) {
      body { padding: 14px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div>
      <h1 id="title">PR Review Lens</h1>
      <p>差分を意味単位で読み解き、レビュー時の認知負荷を下げるCanvas</p>
    </div>
    <div class="toolbar">
      <button class="ghost" id="refresh">再読み込み</button>
    </div>
  </header>

  <details class="input-panel" open>
    <summary>レビュー対象のUnified Diff</summary>
    <div class="input-content">
      <label for="diffInput">差分を貼り付け</label>
      <textarea id="diffInput" rows="8" placeholder="git diff またはPull RequestのUnified Diffを貼り付けてください"></textarea>
      <p class="hint">Canvasは差分をローカルで解析します。初期分類は推定値なので、タイトル・説明・重要度をレビューの観点に合わせて編集できます。</p>
      <div class="actions">
        <button class="primary" id="loadDiff">解析して表示</button>
      </div>
    </div>
  </details>

  <section class="summary" id="summary"></section>
  <div class="layout">
    <main>
      <div class="section-heading">
        <h2>意味単位のレビューセクション</h2>
        <span class="muted" id="updatedAt"></span>
      </div>
      <div id="sections"></div>
    </main>
    <aside>
      <section class="panel">
        <h2>モジュール依存関係</h2>
        <div id="graph"></div>
        <div id="edges"></div>
      </section>
      <section class="panel">
        <h2>フローチャート</h2>
        <div class="mermaid-view" id="flowchart"></div>
        <details class="diagram-source">
          <summary>Mermaidソースを表示</summary>
          <pre id="flowchart-source"></pre>
        </details>
      </section>
      <section class="panel">
        <h2>シーケンス図</h2>
        <div class="mermaid-view" id="sequence"></div>
        <details class="diagram-source">
          <summary>Mermaidソースを表示</summary>
          <pre id="sequence-source"></pre>
        </details>
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
      var sectionDrafts = Object.create(null);
      var IMPORTANCE_LABELS = { high: "高", medium: "中", low: "低" };
      var STATUS_LABELS = { unreviewed: "未確認", reviewing: "確認中", accepted: "問題なし", "needs-attention": "要確認" };

      function request(path, options) {
        var config = options || {};
        config.headers = Object.assign({ "Content-Type": "application/json" }, config.headers || {});
        return fetch(path, config).then(function (response) {
          return response.text().then(function (text) {
            var payload = text ? JSON.parse(text) : {};
            if (!response.ok) {
              throw new Error(payload.error || "リクエストに失敗しました。");
            }
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
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
      }

      function importanceText(importance) {
        return "重要度: " + (IMPORTANCE_LABELS[importance] || IMPORTANCE_LABELS.medium);
      }

      function importanceBadge(importance) {
        return element("span", "badge importance-" + importance, importanceText(importance));
      }

      function diffLineClass(line) {
        if (line.indexOf("+") === 0 && line.indexOf("+++") !== 0) {
          return "diff-line-add";
        }
        if (line.indexOf("-") === 0 && line.indexOf("---") !== 0) {
          return "diff-line-del";
        }
        return "";
      }

      function renderDiff(target, text) {
        target.textContent = "";
        String(text || "").split("\\n").forEach(function (line) {
          target.appendChild(element("span", diffLineClass(line), line + "\\n"));
        });
      }

      function getSectionDraft(card) {
        return {
          title: card.querySelector(".section-title").value,
          description: card.querySelector(".section-description").value,
          importance: card.querySelector(".section-importance").value,
          status: card.querySelector(".section-status").value,
          notes: card.querySelector(".section-notes").value
        };
      }

      function rememberSectionDraft(event) {
        var card = event.target.closest(".section-card");
        if (card) {
          sectionDrafts[card.dataset.id] = getSectionDraft(card);
        }
      }

      function saveSection(section) {
        var payload = getSectionDraft(section);
        return request("/api/sections/" + encodeURIComponent(section.dataset.id), {
          method: "PATCH",
          body: JSON.stringify(payload)
        }).then(function (next) {
          delete sectionDrafts[section.dataset.id];
          state = next;
          render();
          showToast("セクションを保存しました。");
        });
      }

      function renderSections() {
        var container = document.getElementById("sections");
        container.textContent = "";
        Object.keys(sectionDrafts).forEach(function (sectionId) {
          if (!state.sections.some(function (section) { return section.id === sectionId; })) {
            delete sectionDrafts[sectionId];
          }
        });
        if (!state.sections.length) {
          container.appendChild(element("div", "empty", "差分を入力すると、意味単位のセクションがここに表示されます。"));
          return;
        }
        state.sections.forEach(function (section) {
          var displayed = Object.assign({}, section, sectionDrafts[section.id] || {});
          var card = element("article", "section-card");
          card.dataset.id = section.id;
          var heading = element("div", "section-heading-card");
          var title = document.createElement("input");
          title.className = "section-title";
          title.value = displayed.title || "";
          title.setAttribute("aria-label", "セクションタイトル");
          heading.appendChild(title);
          var badge = importanceBadge(displayed.importance);
          heading.appendChild(badge);
          card.appendChild(heading);

          var grid = element("div", "section-grid");
          var description = document.createElement("textarea");
          description.className = "section-description";
          description.value = displayed.description || "";
          description.setAttribute("aria-label", "セクション説明");
          grid.appendChild(description);
          var controls = element("div");
          var importance = document.createElement("select");
          importance.className = "section-importance";
          importance.setAttribute("aria-label", "重要度");
          Object.keys(IMPORTANCE_LABELS).forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = importanceText(value);
            option.selected = displayed.importance === value;
            importance.appendChild(option);
          });
          var status = document.createElement("select");
          status.className = "section-status";
          status.setAttribute("aria-label", "レビュー状態");
          Object.keys(STATUS_LABELS).forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = STATUS_LABELS[value];
            option.selected = displayed.status === value;
            status.appendChild(option);
          });
          controls.appendChild(importance);
          controls.appendChild(status);
          grid.appendChild(controls);
          card.appendChild(grid);

          var meta = element("div", "section-meta");
          (section.filePaths || []).forEach(function (filePath) { meta.appendChild(element("span", "file-chip", filePath)); });
          if (section.diffTruncated) { meta.appendChild(element("span", "muted", "差分抜粋")); }
          card.appendChild(meta);

          var diff = element("pre", "diff");
          renderDiff(diff, section.diff);
          card.appendChild(diff);

          var reason = element("p", "hint", "重要度の推定理由: " + (section.importanceReason || "未設定"));
          card.appendChild(reason);
          if (section.reviewQuestions && section.reviewQuestions.length) {
            var questionList = element("ul", "review-questions");
            questionList.appendChild(element("strong", "", "確認観点"));
            section.reviewQuestions.forEach(function (question) {
              questionList.appendChild(element("li", "", question));
            });
            card.appendChild(questionList);
          }
          var notes = document.createElement("textarea");
          notes.className = "section-notes";
          notes.placeholder = "レビュー観点、確認結果、懸念点を記録";
          notes.value = displayed.notes || "";
          notes.setAttribute("aria-label", "レビュー注記");
          card.appendChild(notes);
          [title, description, importance, status, notes].forEach(function (field) {
            field.addEventListener("input", rememberSectionDraft);
            field.addEventListener("change", rememberSectionDraft);
          });
          importance.addEventListener("change", function () {
            badge.className = "badge importance-" + importance.value;
            badge.textContent = importanceText(importance.value);
          });
          var footer = element("div", "section-footer");
          var save = element("button", "primary", "注記を保存");
          save.addEventListener("click", function () {
            save.disabled = true;
            saveSection(card).catch(function (error) { showToast(error.message); }).finally(function () { save.disabled = false; });
          });
          footer.appendChild(save);
          card.appendChild(footer);
          container.appendChild(card);
        });
      }

      function renderSummary() {
        var summary = document.getElementById("summary");
        summary.textContent = "";
        var stats = state.stats || {};
        [["sections", "セクション"], ["files", "変更ファイル"], ["additions", "追加行"], ["deletions", "削除行"], ["highImportance", "高重要度"]].forEach(function (item) {
          var stat = element("div", "stat");
          stat.appendChild(element("strong", "", String(stats[item[0]] || 0)));
          stat.appendChild(element("span", "", item[1]));
          summary.appendChild(stat);
        });
        document.getElementById("title").textContent = state.title || "PRレビュー補助";
        document.getElementById("updatedAt").textContent = state.updatedAt ? "更新: " + new Date(state.updatedAt).toLocaleString() : "";
        if (document.activeElement !== diffInput) { diffInput.value = state.diff || ""; }
      }

      function renderDependencies() {
        var graph = document.getElementById("graph");
        var edges = document.getElementById("edges");
        graph.textContent = "";
        edges.textContent = "";
        var dependencies = state.dependencies || { nodes: [], edges: [] };
        if (!dependencies.nodes.length) {
          graph.appendChild(element("div", "muted", "変更ファイル間の依存関係は検出されませんでした。"));
        } else {
          dependencies.nodes.forEach(function (node) {
            var item = element("div", "node");
            item.appendChild(element("strong", "", node.label));
            var section = (state.sections || []).find(function (candidate) { return candidate.id === node.sectionId; });
            item.appendChild(element("small", "", section ? section.title : "セクション未紐付け"));
            graph.appendChild(item);
          });
        }
        (dependencies.edges || []).forEach(function (edge) {
          var from = dependencies.nodes.find(function (node) { return node.id === edge.from; });
          var to = dependencies.nodes.find(function (node) { return node.id === edge.to; });
          edges.appendChild(element("div", "edge", (from ? from.label : edge.from) + " → " + (to ? to.label : edge.to) + (edge.label ? " (" + edge.label + ")" : "")));
        });
      }

      var SVG_NS = "http://www.w3.org/2000/svg";

      function svgNode(name, attributes, text) {
        var node = document.createElementNS(SVG_NS, name);
        Object.keys(attributes || {}).forEach(function (key) {
          if (attributes[key] !== undefined && attributes[key] !== null) {
            node.setAttribute(key, attributes[key]);
          }
        });
        if (text !== undefined) {
          node.textContent = text;
        }
        return node;
      }

      function addArrowMarker(svg, id) {
        var defs = svgNode("defs");
        var marker = svgNode("marker", {
          id: id,
          viewBox: "0 0 8 8",
          refX: "7",
          refY: "4",
          markerWidth: "8",
          markerHeight: "8",
          orient: "auto",
          markerUnits: "strokeWidth"
        });
        marker.appendChild(svgNode("path", { d: "M 0 0 L 8 4 L 0 8 z", class: "diagram-arrow" }));
        defs.appendChild(marker);
        svg.appendChild(defs);
      }

      function shortDiagramLabel(value, maxLength) {
        var label = String(value || "").replace(/[\\r\\n]+/g, " ");
        return label.length > maxLength ? label.slice(0, maxLength - 1) + "…" : label;
      }

      function parseFlowchart(source) {
        var nodes = [];
        var nodeById = Object.create(null);
        var edges = [];
        var direction = "LR";
        var lines = String(source || "").split("\\n");
        var directionMatch = lines[0].match(/^\\s*(?:flowchart|graph)\\s+(LR|RL|TB|TD)\\s*$/i);
        if (!directionMatch) {
          return { supported: false, direction: direction, nodes: nodes, edges: edges };
        }
        direction = directionMatch[1].toUpperCase();
        function addNode(id, label) {
          if (!id) { return; }
          if (!nodeById[id]) {
            nodeById[id] = { id: id, label: label || id };
            nodes.push(nodeById[id]);
          } else if (label) {
            nodeById[id].label = label;
          }
        }
        lines.forEach(function (line) {
          var nodeMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*\\[(.*)\\]\\s*$/);
          if (nodeMatch) {
            var label = nodeMatch[2].trim();
            if (label.length >= 2 && label[0] === '"' && label[label.length - 1] === '"') {
              label = label.slice(1, -1);
            }
            addNode(nodeMatch[1], label);
          }
          var labeledEdgeMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*-->\\|([^|]*)\\|\\s*([A-Za-z][A-Za-z0-9_-]*)/);
          var edgeMatch = labeledEdgeMatch || line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*-->\\s*([A-Za-z][A-Za-z0-9_-]*)/);
          if (edgeMatch) {
            var targetId = labeledEdgeMatch ? edgeMatch[3] : edgeMatch[2];
            addNode(edgeMatch[1], edgeMatch[1]);
            addNode(targetId, targetId);
            edges.push({
              from: edgeMatch[1],
              to: targetId,
              label: labeledEdgeMatch ? edgeMatch[2] : ""
            });
          }
        });
        return { supported: true, direction: direction, nodes: nodes, edges: edges };
      }

      function diagramFallback(container, source) {
        container.textContent = "";
        container.appendChild(element("pre", "diagram-fallback", "このMermaid構文は簡易描画の対象外です。ソースを確認してください。\\n\\n" + String(source || "")));
      }

      function renderFlowchart(container, source) {
        var graph = parseFlowchart(source);
        if (!graph.supported || !graph.nodes.length) {
          diagramFallback(container, source);
          return;
        }
        var horizontal = graph.direction === "LR" || graph.direction === "RL";
        var nodeWidth = 166;
        var nodeHeight = 52;
        var gap = 42;
        var padding = 20;
        var nodeCount = graph.nodes.length;
        var gapCount = Math.max(0, nodeCount - 1);
        var width = horizontal
          ? Math.max(280, padding * 2 + nodeCount * nodeWidth + gapCount * gap)
          : 220;
        var height = horizontal
          ? 132
          : Math.max(160, padding * 2 + nodeCount * nodeHeight + gapCount * gap);
        var svg = svgNode("svg", {
          viewBox: "0 0 " + width + " " + height,
          width: width,
          height: height,
          role: "img",
          "aria-label": "PRレビューの変更依存関係"
        });
        addArrowMarker(svg, "flow-arrow");
        var positions = Object.create(null);
        graph.nodes.forEach(function (node, index) {
          var visualIndex = graph.direction === "RL" ? graph.nodes.length - index - 1 : index;
          positions[node.id] = horizontal
            ? { x: padding + visualIndex * (nodeWidth + gap), y: 34 }
            : { x: (width - nodeWidth) / 2, y: padding + visualIndex * (nodeHeight + gap) };
        });
        graph.edges.forEach(function (edge) {
          var from = positions[edge.from];
          var to = positions[edge.to];
          if (!from || !to) { return; }
          var x1;
          var y1;
          var x2;
          var y2;
          if (horizontal) {
            var forward = to.x >= from.x;
            x1 = from.x + (forward ? nodeWidth : 0);
            y1 = from.y + nodeHeight / 2;
            x2 = to.x + (forward ? 0 : nodeWidth);
            y2 = to.y + nodeHeight / 2;
          } else {
            var downward = to.y >= from.y;
            x1 = from.x + nodeWidth / 2;
            y1 = from.y + (downward ? nodeHeight : 0);
            x2 = to.x + nodeWidth / 2;
            y2 = to.y + (downward ? 0 : nodeHeight);
          }
          svg.appendChild(svgNode("line", {
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2,
            class: "diagram-edge",
            "marker-end": "url(#flow-arrow)"
          }));
          if (edge.label) {
            svg.appendChild(svgNode("text", {
              x: (x1 + x2) / 2,
              y: (y1 + y2) / 2 - 6,
              "text-anchor": "middle",
              class: "diagram-muted"
            }, shortDiagramLabel(edge.label, 18)));
          }
        });
        graph.nodes.forEach(function (node) {
          var position = positions[node.id];
          svg.appendChild(svgNode("rect", {
            x: position.x,
            y: position.y,
            width: nodeWidth,
            height: nodeHeight,
            rx: 8,
            class: "diagram-node"
          }));
          svg.appendChild(svgNode("text", {
            x: position.x + nodeWidth / 2,
            y: position.y + nodeHeight / 2 + 4,
            "text-anchor": "middle"
          }, shortDiagramLabel(node.label, 24)));
        });
        container.textContent = "";
        container.appendChild(svg);
      }

      function parseSequence(source) {
        var participants = [];
        var participantById = Object.create(null);
        var messages = [];
        var lines = String(source || "").split("\\n");
        if (!/^\\s*sequenceDiagram\\s*$/i.test(lines[0] || "")) {
          return { supported: false, participants: participants, messages: messages };
        }
        function addParticipant(id, label) {
          if (!id) { return; }
          if (!participantById[id]) {
            participantById[id] = { id: id, label: label || id };
            participants.push(participantById[id]);
          } else if (label) {
            participantById[id].label = label;
          }
        }
        lines.slice(1).forEach(function (line) {
          var participantMatch = line.match(/^\\s*participant\\s+([A-Za-z][A-Za-z0-9_-]*)\\s+as\\s+(.+)$/i);
          if (participantMatch) {
            addParticipant(participantMatch[1], participantMatch[2].trim());
            return;
          }
          var messageMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*(?:-+>>?|=+>>?)\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s*(.*)$/);
          if (messageMatch) {
            addParticipant(messageMatch[1], messageMatch[1]);
            addParticipant(messageMatch[2], messageMatch[2]);
            messages.push({ from: messageMatch[1], to: messageMatch[2], label: messageMatch[3] });
          }
        });
        return { supported: true, participants: participants, messages: messages };
      }

      function renderSequence(container, source) {
        var diagram = parseSequence(source);
        if (!diagram.supported || !diagram.participants.length) {
          diagramFallback(container, source);
          return;
        }
        var participantWidth = 150;
        var participantGap = 20;
        var padding = 20;
        var participantCount = diagram.participants.length;
        var participantGapCount = Math.max(0, participantCount - 1);
        var width = Math.max(300, padding * 2 + participantCount * participantWidth + participantGapCount * participantGap);
        var height = Math.max(150, 88 + diagram.messages.length * 44);
        var svg = svgNode("svg", {
          viewBox: "0 0 " + width + " " + height,
          width: width,
          height: height,
          role: "img",
          "aria-label": "PRレビューの確認シーケンス"
        });
        addArrowMarker(svg, "sequence-arrow");
        var positions = Object.create(null);
        diagram.participants.forEach(function (participant, index) {
          var x = padding + index * (participantWidth + participantGap) + participantWidth / 2;
          positions[participant.id] = x;
          svg.appendChild(svgNode("line", {
            x1: x,
            y1: 48,
            x2: x,
            y2: height - 12,
            class: "diagram-lifeline"
          }));
          svg.appendChild(svgNode("rect", {
            x: x - participantWidth / 2,
            y: 10,
            width: participantWidth,
            height: 34,
            rx: 6,
            class: "diagram-node"
          }));
          svg.appendChild(svgNode("text", {
            x: x,
            y: 32,
            "text-anchor": "middle"
          }, shortDiagramLabel(participant.label, 20)));
        });
        diagram.messages.forEach(function (message, index) {
          var from = positions[message.from];
          var to = positions[message.to];
          if (from === undefined || to === undefined) { return; }
          var y = 76 + index * 44;
          var x1 = from;
          var x2 = to;
          if (x1 === x2) { x2 += 58; }
          svg.appendChild(svgNode("line", {
            x1: x1,
            y1: y,
            x2: x2,
            y2: y,
            class: "diagram-edge",
            "marker-end": "url(#sequence-arrow)"
          }));
          svg.appendChild(svgNode("text", {
            x: (x1 + x2) / 2,
            y: y - 7,
            "text-anchor": "middle",
            class: "diagram-muted"
          }, shortDiagramLabel(message.label, 28)));
        });
        container.textContent = "";
        container.appendChild(svg);
      }

      function renderDiagrams() {
        var diagrams = state.diagrams || {};
        var flowchart = diagrams.flowchart || "flowchart LR";
        var sequence = diagrams.sequence || "sequenceDiagram";
        renderFlowchart(document.getElementById("flowchart"), flowchart);
        renderSequence(document.getElementById("sequence"), sequence);
        document.getElementById("flowchart-source").textContent = flowchart;
        document.getElementById("sequence-source").textContent = sequence;
      }

      function render() {
        if (!state) { return; }
        renderSummary();
        renderSections();
        renderDependencies();
        renderDiagrams();
      }

      document.getElementById("loadDiff").addEventListener("click", function () {
        var diff = diffInput.value;
        if (!diff.trim()) {
          showToast("差分を貼り付けてください。");
          return;
        }
        request("/api/load", { method: "POST", body: JSON.stringify({ diff: diff }) })
          .then(function (next) { state = next; render(); showToast("差分を解析しました。"); })
          .catch(function (error) { showToast(error.message); });
      });
      document.getElementById("refresh").addEventListener("click", function () {
        request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      });

      request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      var events = new EventSource("/events");
      events.addEventListener("state", function (event) {
        try {
          state = JSON.parse(event.data);
          render();
        } catch (error) {
          showToast("Canvas状態の更新を読み込めませんでした。");
        }
      });
    }());
  </script>
</body>
</html>`;
}
