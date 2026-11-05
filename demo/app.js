/* KeyGate demo — every value below is mock data held in memory.
   No storage APIs, no network calls: reloading the page resets the whole app. */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const money = (n) => `$${n.toFixed(2)}`;
  const num = (n) => new Intl.NumberFormat("en-US").format(n);
  const rand = (min, max) => Math.round(min + Math.random() * (max - min));

  /* ---------------- state (in memory only) ---------------- */

  const state = {
    view: "dashboard",
    stats: { requests: 18432, spend: 12.84, success: 99.2, latency: 842 },
    providers: [
      { id: "openai", name: "OpenAI", glyph: "OA", color: "#10a37f", engine: "openai-compatible", endpoint: "https://api.openai.com/v1", keys: 2, status: "healthy", chips: ["streaming", "tools", "vision"] },
      { id: "groq", name: "Groq", glyph: "GQ", color: "#f55036", engine: "openai-compatible", endpoint: "https://api.groq.com/openai/v1", keys: 1, status: "healthy", chips: ["streaming", "fast"] },
      { id: "anthropic", name: "Anthropic", glyph: "AN", color: "#d97757", engine: "jsonata", endpoint: "https://api.anthropic.com/v1/messages", keys: 1, status: "healthy", chips: ["streaming", "map in/out"] },
      { id: "deepseek", name: "DeepSeek", glyph: "DS", color: "#4d6bfe", engine: "openai-compatible", endpoint: "https://api.deepseek.com/v1", keys: 1, status: "degraded", chips: ["streaming", "reasoning"] }
    ],
    pools: [
      {
        id: "default", name: "default", strategy: "weighted-by-health", cap: 40, spend: 12.84, p95: 842,
        targets: [
          { id: "t1", keyId: "openai-1", label: "openai-prod", model: "gpt-4o-mini", weight: 60, state: "ok" },
          { id: "t2", keyId: "groq-1", label: "groq-prod", model: "llama-3.3-70b", weight: 40, state: "ok" }
        ]
      },
      {
        id: "gpt-4o", name: "gpt-4o", strategy: "priority", cap: 25, spend: 18.12, p95: 1120,
        targets: [
          { id: "t3", keyId: "openai-1", label: "openai-prod", model: "gpt-4o", weight: 100, state: "ok" },
          { id: "t4", keyId: "groq-1", label: "groq-prod", model: "llama-3.3-70b", weight: 50, state: "ok" }
        ]
      },
      {
        id: "claude-sonnet", name: "claude-sonnet", strategy: "round-robin", cap: 20, spend: 6.4, p95: 1340,
        targets: [
          { id: "t5", keyId: "anthropic-1", label: "anthropic-main", model: "claude-sonnet-4", weight: 100, state: "ok" },
          { id: "t6", keyId: "openai-1", label: "openai-prod", model: "gpt-4o-mini", weight: 100, state: "ok" }
        ]
      },
      {
        id: "fast-embeddings", name: "fast-embeddings", strategy: "weighted-by-health", cap: 10, spend: 0.92, p95: 96,
        targets: [
          { id: "t7", keyId: "openai-1", label: "openai-prod", model: "text-embedding-3-small", weight: 80, state: "ok" },
          { id: "t8", keyId: "deepseek-1", label: "deepseek-prod", model: "embed-v2", weight: 20, state: "down" }
        ]
      }
    ],
    keys: [
      { id: "openai-1", label: "openai-prod", provider: "OpenAI", masked: "sk-proj-•••••••••••7f2a", fake: "sk-proj-demo2f9c1a4b7f2a", budget: 25, spend: 8.42, health: 99, status: "active" },
      { id: "openai-2", label: "openai-burst", provider: "OpenAI", masked: "sk-proj-•••••••••••c91d", fake: "sk-proj-demo8b3d5e6ac91d", budget: 10, spend: 1.12, health: 97, status: "active" },
      { id: "groq-1", label: "groq-prod", provider: "Groq", masked: "gsk_••••••••••••44be", fake: "gsk_demo7a1f3c9e44be", budget: 10, spend: 2.28, health: 94, status: "active" },
      { id: "anthropic-1", label: "anthropic-main", provider: "Anthropic", masked: "sk-ant-•••••••••••9a30", fake: "sk-ant-demo4c8e2b9a30", budget: 20, spend: 5.02, health: 98, status: "active" },
      { id: "deepseek-1", label: "deepseek-prod", provider: "DeepSeek", masked: "sk-••••••••••••••11cd", fake: "sk-demo5e7a1b11cd", budget: 8, spend: 7.61, health: 61, status: "cooling_down" }
    ],
    gatewayKeys: [
      { id: "g1", name: "production-app", token: "kg-live-7f2a19c4e8b3d6a1c91d", scope: ["default", "gpt-4o"], rpm: 600, tpm: 120000, lastUsed: "2 min ago" },
      { id: "g2", name: "staging", token: "kg-live-2b7e44aa10ce9d3b8f20", scope: ["default"], rpm: 120, tpm: 30000, lastUsed: "1 h ago" },
      { id: "g3", name: "notebooks", token: "kg-live-9c31f0de77a2b4e6d508", scope: ["claude-sonnet"], rpm: 30, tpm: 8000, lastUsed: "yesterday" }
    ],
    logs: [
      { time: "12:41:08", trace: "tr_8f2a91c4", pool: "default", model: "gpt-4o-mini", status: 200, latency: 612, cost: 0.00042, upstream: "openai-prod", keys: 842, tokens: 1840 },
      { time: "12:40:51", trace: "tr_3b77e0aa", pool: "claude-sonnet", model: "claude-sonnet-4", status: 200, latency: 1180, cost: 0.00218, upstream: "anthropic-main", keys: 143, tokens: 2240 },
      { time: "12:40:44", trace: "tr_c19d44f2", pool: "default", model: "llama-3.3-70b", status: 200, latency: 284, cost: 0.00011, upstream: "groq-prod", keys: 590, tokens: 920 },
      { time: "12:39:59", trace: "tr_5a02b8e1", pool: "gpt-4o", model: "gpt-4o", status: 200, latency: 1420, cost: 0.00492, upstream: "openai-prod", keys: 77, tokens: 3120 },
      { time: "12:39:12", trace: "tr_e4d9a071", pool: "default", model: "gpt-4o-mini", status: 429, latency: 8, cost: 0, upstream: "—", keys: 12, tokens: 0 },
      { time: "12:38:47", trace: "tr_77b1c93d", pool: "fast-embeddings", model: "text-embedding-3-small", status: 200, latency: 88, cost: 0.00001, upstream: "openai-prod", keys: 2310, tokens: 380 },
      { time: "12:38:03", trace: "tr_a08f2e5b", pool: "default", model: "gpt-4o-mini", status: 502, latency: 2040, cost: 0, upstream: "groq-prod", keys: 31, tokens: 0 },
      { time: "12:37:55", trace: "tr_6c4d10aa", pool: "default", model: "gpt-4o-mini", status: 200, latency: 580, cost: 0.00038, upstream: "openai-prod", keys: 1120, tokens: 1610 },
      { time: "12:37:21", trace: "tr_2f9a77be", pool: "claude-sonnet", model: "claude-sonnet-4", status: 200, latency: 1290, cost: 0.00246, upstream: "anthropic-main", keys: 98, tokens: 2480 },
      { time: "12:36:40", trace: "tr_b3e880d4", pool: "gpt-4o", model: "gpt-4o", status: 200, latency: 1080, cost: 0.00391, upstream: "openai-prod", keys: 64, tokens: 2610 },
      { time: "12:35:02", trace: "tr_9d1cf6a0", pool: "default", model: "llama-3.3-70b", status: 200, latency: 301, cost: 0.00009, upstream: "groq-prod", keys: 410, tokens: 780 },
      { time: "12:34:18", trace: "tr_0a77e5c3", pool: "fast-embeddings", model: "text-embedding-3-small", status: 200, latency: 104, cost: 0.00001, upstream: "openai-prod", keys: 1980, tokens: 340 }
    ],
    revealed: new Set(),
    play: { running: false, timer: null, char: 0, text: "", meta: null }
  };

  /* ---------------- shell: tabs, clock, toasts ---------------- */

  const tabs = $$(".nav-item");
  const panels = $$(".view");

  function setView(view, { focus = false } = {}) {
    if (!panels.some((p) => p.dataset.panel === view)) view = "dashboard";
    state.view = view;
    tabs.forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
    if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
    if (view === "dashboard") drawSpark();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else next = (index - 1 + tabs.length) % tabs.length;
      setView(tabs[next].dataset.view, { focus: true });
    });
  });

  $$("[data-goto]").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.goto)));
  window.addEventListener("hashchange", () => setView(location.hash.slice(1)));

  function tickClock() {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  setInterval(tickClock, 1000);

  function toast(message, kind = "ok") {
    const wrap = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span class="dot dot-${kind}"></span><span>${esc(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, 3600);
  }

  /* ---------------- modal ---------------- */

  let modalCloser = null;

  function openModal({ title, sub, body, actions }) {
    closeModal();
    const root = $("#modal-root");
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <div>
            <h2 id="modal-title">${esc(title)}</h2>
            ${sub ? `<p class="modal-sub">${esc(sub)}</p>` : ""}
          </div>
          <button class="modal-close" type="button" aria-label="Close dialog">${icon("x")}</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">${actions}</div>
      </div>`;
    root.appendChild(overlay);

    const previous = document.activeElement;
    const modal = $(".modal", overlay);
    const close = () => {
      overlay.remove();
      modalCloser = null;
      if (previous && previous.focus) previous.focus();
    };
    modalCloser = close;

    $(".modal-close", overlay).addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const focusable = $$("button, input, select, textarea, a[href]", modal).filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });

    const firstField = $("input, select, textarea", modal);
    (firstField || $(".modal-close", overlay)).focus();
    return overlay;
  }

  function closeModal() {
    if (modalCloser) modalCloser();
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied to the clipboard`);
    } catch {
      toast("Clipboard is blocked here — select the value instead", "warn");
    }
  }

  /* ---------------- derived helpers ---------------- */

  const poolById = (id) => state.pools.find((p) => p.id === id);
  const keyById = (id) => state.keys.find((k) => k.id === id);
  const healthyTargets = (pool) => pool.targets.filter((t) => t.state === "ok");

  function pickTarget(pool) {
    const healthy = healthyTargets(pool);
    if (!healthy.length) return null;
    if (pool.strategy === "round-robin") return healthy[Math.floor(Math.random() * healthy.length)];
    if (pool.strategy === "priority") return healthy[0];
    const total = healthy.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * total;
    for (const target of healthy) {
      roll -= target.weight;
      if (roll <= 0) return target;
    }
    return healthy[healthy.length - 1];
  }

  const dotClass = (status) => (status === "ok" || status === "active" || status === "healthy" ? "ok" : status === "degraded" || status === "cooling_down" ? "warn" : "bad");

  /* ---------------- overview ---------------- */

  function renderKpis() {
    const s = state.stats;
    $('[data-kpi="requests"]').textContent = num(s.requests);
    $('[data-kpi="spend"]').textContent = money(s.spend);
    $('[data-kpi="success"]').innerHTML = `${s.success.toFixed(1)}<span class="unit">%</span>`;
    $('[data-kpi="latency"]').innerHTML = `${num(s.latency)}<span class="unit">ms</span>`;
  }

  const sparkSeries = [44, 38, 41, 34, 37, 29, 33, 26, 30, 22, 27, 19, 24, 17, 21, 15, 19, 13, 17, 12];

  function drawSpark() {
    const svg = $(".spark");
    if (!svg || svg.getBoundingClientRect().width === 0) return;
    const data = sparkSeries;
    const w = 180;
    const h = 46;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const points = data.map((value, index) => {
      const x = (index / (data.length - 1)) * w;
      const y = h - 3 - ((value - min) / (max - min || 1)) * (h - 10);
      return [x, y];
    });
    const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    $("#spark-line").setAttribute("d", line);
    $("#spark-area").setAttribute("d", `${line} L${w} ${h} L0 ${h} Z`);
  }

  function renderRoute() {
    const pool = poolById("default");
    $("#route-pool").textContent = pool.name;
    const targets = pool.targets.slice(0, 3);
    $("#route-targets").innerHTML = targets.map((target) => {
      const key = keyById(target.keyId);
      const down = target.state !== "ok" || key?.status === "cooling_down";
      return `<div class="target ${down ? "is-down" : ""}">
        <span class="dot dot-${down ? "warn" : "ok"}"></span>
        <span class="target-name">${esc(target.label)}</span>
        <span class="target-model">${esc(target.model)}</span>
      </div>`;
    }).join("");
    const routePool = $("#route-pool");
    routePool.closest(".route-stop").querySelector(".route-hint").textContent = pool.strategy;
  }

  function renderPoolMini() {
    const rows = state.pools.slice(0, 4).map((pool) => {
      const healthy = healthyTargets(pool).length;
      const ratio = healthy / pool.targets.length;
      const cls = ratio === 1 ? "" : ratio >= 0.5 ? "warn" : "bad";
      return `<div class="pool-row">
        <div>
          <div class="pool-name">${esc(pool.name)}${pool.spend / pool.cap > 0.8 ? '<span class="status status-warn">near cap</span>' : ""}</div>
          <div class="pool-strategy">${esc(pool.strategy)} · ${pool.targets.length} targets</div>
        </div>
        <div class="pool-health">
          <span>${healthy}/${pool.targets.length}</span>
          <span class="mini-bar"><span class="${cls}" style="width:${Math.round(ratio * 100)}%"></span></span>
        </div>
        <div class="pool-spend">${money(pool.spend)}<br><span class="muted">of ${money(pool.cap)}</span></div>
      </div>`;
    });
    $("#pool-mini").innerHTML = rows.join("");
  }

  function renderRecent() {
    $("#recent-body").innerHTML = state.logs.slice(0, 5).map((log) => {
      const kind = log.status === 200 ? "ok" : log.status === 429 ? "warn" : "bad";
      return `<tr>
        <td class="strong">${esc(log.pool)}</td>
        <td><span class="status status-${kind}">${log.status}</span></td>
        <td class="num">${num(log.latency)} ms</td>
        <td class="num">${money(log.cost)}</td>
      </tr>`;
    }).join("");
  }

  function addTrace(poolName, target, status, latency, cost, tokens) {
    const now = new Date();
    const log = {
      time: now.toLocaleTimeString([], { hour12: false }),
      trace: `tr_${Math.random().toString(16).slice(2, 10)}`,
      pool: poolName,
      model: target ? target.model : "—",
      status,
      latency,
      cost,
      upstream: target ? target.label : "—",
      keys: rand(20, 1400),
      tokens
    };
    state.logs.unshift(log);
    state.logs = state.logs.slice(0, 40);
    state.stats.requests += 1;
    state.stats.spend = Math.round((state.stats.spend + cost) * 100) / 100;
    renderRecent();
    renderKpis();
    renderLogs();
  }

  /* ---------------- pools view ---------------- */

  function targetRow(pool, target) {
    const key = keyById(target.keyId);
    const down = target.state !== "ok";
    return `<div class="target-row ${down ? "is-down" : ""}">
      <span class="dot dot-${down ? "bad" : "ok"}" title="${down ? "Offline" : "Healthy"}"></span>
      <div>
        <div class="strong" style="font-size:12.5px">${esc(target.label)}</div>
        <div class="target-model">${esc(target.model)} · ${esc(key ? key.provider : "unknown")}</div>
      </div>
      <span class="target-weight">${pool.strategy === "weighted-by-health" ? `${target.weight}%` : down ? "skipped" : "ready"}</span>
      <button class="btn btn-small ${down ? "" : "btn-ghost"}" data-toggle-target="${target.id}">${down ? "Bring online" : "Take offline"}</button>
    </div>`;
  }

  function poolCard(pool) {
    const pct = Math.min(100, Math.round((pool.spend / pool.cap) * 100));
    const hot = pct >= 80;
    return `<article class="panel pool-card">
      <div class="pool-card-head">
        <div>
          <div class="pool-card-title"><h2>${esc(pool.name)}</h2><span class="badge">${pool.targets.length} targets</span></div>
          <p class="pool-card-meta">p95 ${num(pool.p95)} ms · served to ${pool.name === "default" ? "every client" : "scoped keys"}</p>
        </div>
        <span class="status ${healthyTargets(pool).length === pool.targets.length ? "status-ok" : "status-warn"}">${healthyTargets(pool).length}/${pool.targets.length} healthy</span>
      </div>
      <div class="segmented" role="group" aria-label="Routing strategy for ${esc(pool.name)}">
        ${["weighted-by-health", "round-robin", "priority"].map((strategy) => `
          <button type="button" data-strategy="${pool.id}:${strategy}" aria-pressed="${pool.strategy === strategy}">${strategy}</button>`).join("")}
      </div>
      <div class="target-list">${pool.targets.map((target) => targetRow(pool, target)).join("")}</div>
      <div class="cap">
        <div class="cap-label"><span>Daily cap</span><b>${money(pool.spend)} / ${money(pool.cap)}</b></div>
        <div class="cap-bar"><span class="${hot ? "hot" : ""}" style="width:${pct}%"></span></div>
      </div>
    </article>`;
  }

  function renderPools() {
    $("#pool-grid").innerHTML = state.pools.map(poolCard).join("");
  }

  /* ---------------- providers ---------------- */

  function renderProviders() {
    $("#provider-grid").innerHTML = state.providers.map((provider) => `
      <article class="panel provider-card">
        <div class="provider-head">
          <span class="provider-glyph" style="background:${provider.color}">${esc(provider.glyph)}</span>
          <div>
            <div class="provider-name">${esc(provider.name)}</div>
            <div class="provider-engine">engine: ${esc(provider.engine)}</div>
          </div>
          <span class="status ${provider.status === "healthy" ? "status-ok" : "status-warn"}" style="margin-left:auto">${esc(provider.status)}</span>
        </div>
        <div class="provider-endpoint">${esc(provider.endpoint)}</div>
        <div class="chips">${provider.chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join("")}</div>
        <div class="provider-foot">
          <span>${provider.keys} key${provider.keys === 1 ? "" : "s"} attached</span>
          <button class="link-btn" data-spec="${provider.id}">Inspect spec</button>
        </div>
      </article>`).join("");
  }

  /* ---------------- upstream keys ---------------- */

  function renderKeys() {
    const body = $("#keys-body");
    if (!state.keys.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty"><strong>No upstream keys</strong>Add a provider key to start routing traffic.</div></td></tr>`;
      return;
    }
    body.innerHTML = state.keys.map((key) => {
      const revealed = state.revealed.has(key.id);
      const healthClass = key.health >= 90 ? "" : key.health >= 70 ? "warn" : "bad";
      const budgetPct = Math.min(100, Math.round((key.spend / key.budget) * 100));
      const statusKind = key.status === "active" ? "ok" : "warn";
      return `<tr>
        <td>
          <div class="strong">${esc(key.label)}</div>
          <div class="mono subtle" style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span>${esc(revealed ? key.fake : key.masked)}</span>
            <button class="link-btn" data-reveal="${key.id}" aria-label="${revealed ? "Hide" : "Reveal"} ${esc(key.label)}">${revealed ? "hide" : "reveal"}</button>
          </div>
        </td>
        <td>${esc(key.provider)}</td>
        <td>
          <div class="pool-health">
            <span>${key.health}%</span>
            <span class="mini-bar"><span class="${healthClass}" style="width:${key.health}%"></span></span>
          </div>
        </td>
        <td>
          <div class="mono subtle" style="margin-bottom:4px">${money(key.spend)} / ${money(key.budget)}</div>
          <div class="cap-bar" style="width:120px"><span class="${budgetPct > 80 ? "hot" : ""}" style="width:${budgetPct}%"></span></div>
        </td>
        <td><span class="status status-${statusKind}">${key.status === "active" ? "active" : "cooling down"}</span></td>
        <td class="right">
          <button class="btn btn-small" data-rotate="${key.id}">Rotate</button>
          <button class="btn btn-small btn-danger" data-delete-key="${key.id}">Delete</button>
        </td>
      </tr>`;
    }).join("");
  }

  /* ---------------- gateway keys ---------------- */

  function renderGateway() {
    const body = $("#gateway-body");
    if (!state.gatewayKeys.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty"><strong>No gateway keys yet</strong>Create one to let a client call /v1.</div></td></tr>`;
      return;
    }
    body.innerHTML = state.gatewayKeys.map((key) => `
      <tr>
        <td class="strong">${esc(key.name)}</td>
        <td><code class="mono">${esc(key.token.slice(0, 14))}…</code></td>
        <td><div class="chips">${key.scope.map((scope) => `<span class="chip">${esc(scope)}</span>`).join("")}</div></td>
        <td class="num"><span class="mono">${key.rpm} rpm</span><br><span class="mono subtle">${num(key.tpm)} tpm</span></td>
        <td class="subtle">${esc(key.lastUsed)}</td>
        <td class="right">
          <button class="btn btn-small" data-copy-token="${key.id}">${icon("copy")}Copy</button>
          <button class="btn btn-small btn-danger" data-revoke="${key.id}">Revoke</button>
        </td>
      </tr>`).join("");
  }

  /* ---------------- logs ---------------- */

  function renderLogs() {
    const search = $("#log-search").value.trim().toLowerCase();
    const status = $("#log-status").value;
    const pool = $("#log-pool").value;
    const rows = state.logs.filter((log) => {
      if (status && String(log.status) !== status) return false;
      if (pool && log.pool !== pool) return false;
      if (!search) return true;
      return [log.pool, log.model, log.trace, log.upstream].join(" ").toLowerCase().includes(search);
    });
    $("#log-count").textContent = `${rows.length} of ${state.logs.length}`;
    const body = $("#logs-body");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7"><div class="empty"><strong>No matching traces</strong>Clear the filters to see every request.</div></td></tr>`;
      return;
    }
    body.innerHTML = rows.map((log) => {
      const kind = log.status === 200 ? "ok" : log.status === 429 ? "warn" : "bad";
      return `<tr>
        <td class="mono subtle">${esc(log.time)}</td>
        <td><button class="trace-link" data-trace="${esc(log.trace)}">${esc(log.trace)}</button></td>
        <td>${esc(log.pool)}</td>
        <td class="mono">${esc(log.model)}</td>
        <td class="num"><span class="status status-${kind}">${log.status}</span></td>
        <td class="num">${num(log.latency)} ms</td>
        <td class="num">${money(log.cost)}</td>
      </tr>`;
    }).join("");
  }

  function fillPoolSelects() {
    const options = state.pools.map((pool) => `<option value="${esc(pool.id)}">${esc(pool.name)}</option>`).join("");
    const logPool = $("#log-pool");
    const current = logPool.value;
    logPool.innerHTML = `<option value="">All pools</option>${options}`;
    logPool.value = current;
    const play = $("#play-pool");
    const playCurrent = play.value;
    play.innerHTML = options;
    play.value = state.pools.some((p) => p.id === playCurrent) ? playCurrent : "default";
  }

  function renderAll() {
    renderKpis();
    renderRoute();
    renderPoolMini();
    renderRecent();
    renderPools();
    renderProviders();
    renderKeys();
    renderGateway();
    fillPoolSelects();
    renderLogs();
    $("#count-pools").textContent = String(state.pools.length);
    drawSpark();
  }

  /* ---------------- interactions: overview ---------------- */

  let busy = false;

  $("#route-send").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    const pool = poolById("default");
    const target = pickTarget(pool);
    const readout = $("#route-readout");
    readout.textContent = target
      ? `Sending to ${target.label} (${target.model})…`
      : "Every target in this pool is offline — the gateway would answer 502.";
    setTimeout(() => {
      if (!target) {
        addTrace(pool.name, null, 502, rand(5, 30), 0, 0);
        readout.textContent = "502 no_healthy_upstream — nothing was sent upstream.";
        toast("Pool exhausted: answered 502 without calling a provider", "bad");
      } else {
        const latency = rand(220, 980);
        addTrace(pool.name, target, 200, latency, 0.0004, rand(300, 1900));
        readout.textContent = `200 from ${target.label} in ${latency} ms · trace kept for 30 days.`;
        toast(`Request served by ${target.label} in ${latency} ms`);
      }
      busy = false;
    }, 520);
  });

  function simulateOutage() {
    const groqKey = keyById("groq-1");
    const targets = state.pools.flatMap((pool) => pool.targets).filter((target) => target.keyId === "groq-1");
    const goingDown = groqKey.status === "active";
    groqKey.status = goingDown ? "cooling_down" : "active";
    groqKey.health = goingDown ? 22 : 94;
    targets.forEach((target) => { target.state = goingDown ? "down" : "ok"; });
    const button = $("#simulate-btn");
    button.innerHTML = goingDown ? `${icon("refresh")}Restore upstream` : `${icon("bolt")}Simulate an outage`;
    renderAll();
    if (goingDown) {
      toast("groq-prod failed twice — removed from routing for 30 s", "warn");
      $("#route-readout").textContent = "Failover: weight moved to openai-prod. No request was dropped.";
    } else {
      toast("groq-prod is healthy again and back in the pool");
      $("#route-readout").textContent = "groq-prod rejoined default. Weighted routing resumed.";
    }
  }

  $("#simulate-btn").addEventListener("click", simulateOutage);

  $("#refresh-btn").addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    state.stats.latency = rand(780, 900);
    state.stats.success = Math.round((99 + Math.random() * 0.6) * 10) / 10;
    renderKpis();
    setTimeout(() => {
      button.disabled = false;
      drawSpark();
      toast("Dashboard refreshed from mock data");
    }, 450);
  });

  /* ---------------- interactions: pools ---------------- */

  document.addEventListener("click", (event) => {
    const strategyBtn = event.target.closest("[data-strategy]");
    if (strategyBtn) {
      const [poolId, strategy] = strategyBtn.dataset.strategy.split(":");
      const pool = poolById(poolId);
      if (pool) {
        pool.strategy = strategy;
        renderPools();
        renderRoute();
        renderPoolMini();
        toast(`${pool.name} now uses ${strategy}`);
      }
      return;
    }

    const toggle = event.target.closest("[data-toggle-target]");
    if (toggle) {
      const targetId = toggle.dataset.toggleTarget;
      const pool = state.pools.find((p) => p.targets.some((t) => t.id === targetId));
      const target = pool?.targets.find((t) => t.id === targetId);
      if (target) {
        target.state = target.state === "ok" ? "down" : "ok";
        renderAll();
        toast(`${target.label} ${target.state === "ok" ? "is back online" : "taken offline for this session"}`, target.state === "ok" ? "ok" : "warn");
      }
      return;
    }

    const specBtn = event.target.closest("[data-spec]");
    if (specBtn) {
      const provider = state.providers.find((p) => p.id === specBtn.dataset.spec);
      if (provider) showSpec(provider);
      return;
    }

    const revealBtn = event.target.closest("[data-reveal]");
    if (revealBtn) {
      const id = revealBtn.dataset.reveal;
      if (state.revealed.has(id)) state.revealed.delete(id);
      else state.revealed.add(id);
      renderKeys();
      if (state.revealed.has(id)) toast("Showing a fake value — real keys are never returned in full", "warn");
      return;
    }

    const rotateBtn = event.target.closest("[data-rotate]");
    if (rotateBtn) {
      const key = keyById(rotateBtn.dataset.rotate);
      if (key) {
        key.masked = key.masked.slice(0, key.masked.length - 4) + Math.random().toString(16).slice(2, 6);
        key.health = 100;
        key.status = "active";
        state.pools.forEach((pool) => pool.targets.forEach((t) => { if (t.keyId === key.id) t.state = "ok"; }));
        renderAll();
        toast(`${key.label} rotated — the old value is retired`);
      }
      return;
    }

    const deleteKeyBtn = event.target.closest("[data-delete-key]");
    if (deleteKeyBtn) {
      const key = keyById(deleteKeyBtn.dataset.deleteKey);
      if (key) confirmDeleteKey(key);
      return;
    }

    const copyTokenBtn = event.target.closest("[data-copy-token]");
    if (copyTokenBtn) {
      const key = state.gatewayKeys.find((k) => k.id === copyTokenBtn.dataset.copyToken);
      if (key) copyText(key.token, "Gateway token");
      return;
    }

    const revokeBtn = event.target.closest("[data-revoke]");
    if (revokeBtn) {
      const key = state.gatewayKeys.find((k) => k.id === revokeBtn.dataset.revoke);
      if (key) confirmRevoke(key);
      return;
    }

    const traceBtn = event.target.closest("[data-trace]");
    if (traceBtn) {
      const log = state.logs.find((l) => l.trace === traceBtn.dataset.trace);
      if (log) showTrace(log);
    }
  });

  /* ---------------- modals: pools, providers, keys, traces ---------------- */

  $("#add-pool-btn").addEventListener("click", () => {
    const overlay = openModal({
      title: "New pool",
      sub: "A pool becomes a model name clients can request.",
      body: `
        <label class="field"><span>Pool name</span><input id="pool-name" placeholder="e.g. gpt-4o-mini" autocomplete="off"></label>
        <label class="field"><span>Strategy</span>
          <select id="pool-strategy">
            <option value="weighted-by-health">weighted-by-health</option>
            <option value="round-robin">round-robin</option>
            <option value="priority">priority</option>
          </select>
        </label>
        <label class="field"><span>First target</span>
          <select id="pool-target">${state.keys.map((key) => `<option value="${key.id}">${esc(key.label)}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Daily cap (USD)</span><input id="pool-cap" type="number" min="1" step="1" value="20"></label>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="pool-create">Create pool</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#pool-create", overlay).addEventListener("click", () => {
      const name = $("#pool-name", overlay).value.trim();
      if (!name) { toast("Give the pool a name first", "warn"); $("#pool-name", overlay).focus(); return; }
      const key = keyById($("#pool-target", overlay).value);
      state.pools.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name,
        strategy: $("#pool-strategy", overlay).value,
        cap: Math.max(1, Number($("#pool-cap", overlay).value) || 20),
        spend: 0,
        p95: 600,
        targets: [{ id: `t${Date.now()}`, keyId: key.id, label: key.label, model: key.label.replace("-prod", "-mini"), weight: 100, state: "ok" }]
      });
      closeModal();
      renderAll();
      toast(`Pool ${name} created`);
    });
  });

  $("#add-provider-btn").addEventListener("click", () => {
    const overlay = openModal({
      title: "Add provider",
      sub: "The real console drafts this spec from a cURL command.",
      body: `
        <label class="field"><span>Name</span><input id="prov-name" placeholder="e.g. Mistral" autocomplete="off"></label>
        <label class="field"><span>Engine</span>
          <select id="prov-engine"><option>openai-compatible</option><option>jsonata</option><option>handlebars</option></select>
        </label>
        <label class="field"><span>Base URL</span><input id="prov-url" placeholder="https://api.example.com/v1" autocomplete="off"></label>
        <label class="field"><span>cURL command (optional)</span><textarea id="prov-curl" rows="4" placeholder="curl https://api.example.com/v1/chat/completions -H 'Authorization: Bearer …'"></textarea></label>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="prov-create">Draft provider</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#prov-create", overlay).addEventListener("click", () => {
      const name = $("#prov-name", overlay).value.trim();
      const url = $("#prov-url", overlay).value.trim();
      if (!name || !url) { toast("A name and a base URL are required", "warn"); return; }
      const palette = ["#8b7cff", "#4fd1c5", "#ffbe57", "#ff7a90", "#6ea8fe"];
      state.providers.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name,
        glyph: name.slice(0, 2).toUpperCase(),
        color: palette[state.providers.length % palette.length],
        engine: $("#prov-engine", overlay).value,
        endpoint: url,
        keys: 0,
        status: "healthy",
        chips: ["not tested"]
      });
      closeModal();
      renderProviders();
      toast(`${name} added with a draft spec`);
    });
  });

  $("#add-key-btn").addEventListener("click", () => {
    const overlay = openModal({
      title: "Add upstream key",
      sub: "Values are fake; nothing is encrypted or stored here.",
      body: `
        <label class="field"><span>Label</span><input id="key-label" placeholder="e.g. openai-eu" autocomplete="off"></label>
        <label class="field"><span>Provider</span>
          <select id="key-provider">${state.providers.map((p) => `<option>${esc(p.name)}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Secret</span><input id="key-secret" placeholder="sk-…" autocomplete="off"></label>
        <label class="field"><span>Daily budget (USD)</span><input id="key-budget" type="number" min="1" step="1" value="10"></label>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="key-create">Add key</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#key-create", overlay).addEventListener("click", () => {
      const label = $("#key-label", overlay).value.trim();
      const secret = $("#key-secret", overlay).value.trim();
      if (!label || !secret) { toast("Label and secret are both required", "warn"); return; }
      const tail = secret.slice(-4);
      state.keys.push({
        id: `${label}-${Date.now()}`,
        label,
        provider: $("#key-provider", overlay).value,
        masked: `${secret.slice(0, 4)}-•••••••••••${tail}`,
        fake: secret,
        budget: Math.max(1, Number($("#key-budget", overlay).value) || 10),
        spend: 0,
        health: 100,
        status: "active"
      });
      closeModal();
      renderAll();
      toast(`${label} added and encrypted (pretend)`);
    });
  });

  function confirmDeleteKey(key) {
    const overlay = openModal({
      title: `Delete ${key.label}?`,
      sub: "Targets that use this key would be removed from their pools.",
      body: `<p style="font-size:12.5px;color:var(--muted)">This is a demo — the key comes back when you reload.</p>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Keep key</button><button class="btn btn-danger" type="button" id="key-confirm">Delete key</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#key-confirm", overlay).addEventListener("click", () => {
      state.keys = state.keys.filter((k) => k.id !== key.id);
      state.pools.forEach((pool) => { pool.targets = pool.targets.filter((t) => t.keyId !== key.id); });
      closeModal();
      renderAll();
      toast(`${key.label} deleted`);
    });
  }

  $("#add-gateway-btn").addEventListener("click", () => {
    const overlay = openModal({
      title: "Create gateway key",
      sub: "Give the client a token, not your provider keys.",
      body: `
        <label class="field"><span>Name</span><input id="gw-name" placeholder="e.g. mobile-app" autocomplete="off"></label>
        <div class="field"><span>Pool scope</span>
          <div class="chips">${state.pools.map((pool) => `<label class="chip" style="cursor:pointer;display:inline-flex;gap:5px;align-items:center">
            <input type="checkbox" value="${esc(pool.id)}" ${pool.id === "default" ? "checked" : ""}> ${esc(pool.name)}
          </label>`).join("")}</div>
        </div>
        <label class="field"><span>Requests per minute</span><input id="gw-rpm" type="number" min="1" value="120"></label>
        <label class="field"><span>Tokens per minute</span><input id="gw-tpm" type="number" min="1000" step="1000" value="30000"></label>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="gw-create">Create key</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#gw-create", overlay).addEventListener("click", () => {
      const name = $("#gw-name", overlay).value.trim();
      const scope = $$("input[type=checkbox]:checked", overlay).map((input) => input.value);
      if (!name) { toast("Name the key so you can revoke it later", "warn"); return; }
      if (!scope.length) { toast("Pick at least one pool", "warn"); return; }
      const token = `kg-live-${Array.from(crypto.getRandomValues(new Uint8Array(10))).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      state.gatewayKeys.unshift({
        id: `g${Date.now()}`, name, token, scope,
        rpm: Math.max(1, Number($("#gw-rpm", overlay).value) || 120),
        tpm: Math.max(1000, Number($("#gw-tpm", overlay).value) || 30000),
        lastUsed: "never"
      });
      closeModal();
      renderGateway();
      const shown = openModal({
        title: "Key created",
        sub: "Copy it now — the demo shows the full token only once.",
        body: `<div class="secret"><span>${esc(token)}</span></div>
               <p style="font-size:12px;color:var(--dim)">Clients send this as <code>Authorization: Bearer …</code> to <code>/v1/chat/completions</code>.</p>`,
        actions: `<button class="btn btn-ghost" type="button" data-close>Done</button><button class="btn btn-primary" type="button" id="gw-copy">${icon("copy")}Copy token</button>`
      });
      $("[data-close]", shown).addEventListener("click", closeModal);
      $("#gw-copy", shown).addEventListener("click", () => copyText(token, "Gateway token"));
      toast(`Gateway key ${name} created`);
    });
  });

  function confirmRevoke(key) {
    const overlay = openModal({
      title: `Revoke ${key.name}?`,
      sub: "Requests using this token start failing immediately.",
      body: `<div class="secret"><span>${esc(key.token.slice(0, 14))}…</span></div>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Keep key</button><button class="btn btn-danger" type="button" id="revoke-confirm">Revoke key</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#revoke-confirm", overlay).addEventListener("click", () => {
      state.gatewayKeys = state.gatewayKeys.filter((k) => k.id !== key.id);
      closeModal();
      renderGateway();
      toast(`${key.name} revoked`);
    });
  }

  function showSpec(provider) {
    const spec = `provider: ${provider.id}
engine: ${provider.engine}
base_url: ${provider.endpoint}
auth:
  type: bearer
  header: Authorization
routes:
  chat:
    path: /chat/completions
    method: POST
transform:
  request: |-
    { "model": model, "messages": messages }
  response: |-
    { "choices": body.choices }`;
    const overlay = openModal({
      title: `${provider.name} provider spec`,
      sub: "Read-only view of the declarative spec kept in SQLite.",
      body: `<pre class="play-text" style="min-height:0;max-height:320px">${esc(spec)}</pre>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Close</button><button class="btn" type="button" id="spec-copy">${icon("copy")}Copy YAML</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#spec-copy", overlay).addEventListener("click", () => copyText(spec, "Spec"));
  }

  function showTrace(log) {
    const detail = JSON.stringify({
      trace_id: log.trace,
      pool: log.pool,
      model: log.model,
      status: log.status,
      latency_ms: log.latency,
      cost_usd: log.cost,
      upstream_key: log.upstream,
      usage: { input_tokens: Math.round(log.tokens * 0.7), output_tokens: Math.round(log.tokens * 0.3) },
      routing: { strategy: poolById(log.pool)?.strategy ?? "weighted-by-health", attempt: 1 }
    }, null, 2);
    const overlay = openModal({
      title: `Trace ${log.trace}`,
      sub: `${log.time} · ${log.pool} · ${log.model}`,
      body: `<pre class="play-text" style="min-height:0;max-height:340px">${esc(detail)}</pre>`,
      actions: `<button class="btn btn-ghost" type="button" data-close>Close</button><button class="btn" type="button" id="trace-copy">${icon("copy")}Copy JSON</button>`
    });
    $("[data-close]", overlay).addEventListener("click", closeModal);
    $("#trace-copy", overlay).addEventListener("click", () => copyText(detail, "Trace JSON"));
  }

  /* ---------------- playground ---------------- */

  $("#play-temp").addEventListener("input", (event) => {
    $("#temp-out").textContent = Number(event.target.value).toFixed(1);
  });

  const ANSWER = `A failing upstream key is a signal, not an error to absorb.

• Retrying a dead key burns the latency budget of every request behind it. A circuit opens after consecutive failures and skips that key entirely.
• Quota and auth failures need minutes, not milliseconds. Backoff that doubles per attempt stops a struggling provider from being hammered.
• Health is per key, not per provider. One exhausted account should never take a healthy sibling out of the pool.

The gateway therefore classifies the failure first, then chooses: retry the next key, honour Retry-After, or answer 502 without calling upstream at all.`;

  function stopPlayback() {
    if (state.play.timer) clearTimeout(state.play.timer);
    state.play.timer = null;
    state.play.running = false;
    $("#play-stop").disabled = true;
    $("#play-send").disabled = false;
  }

  function streamAnswer(text, meta) {
    const output = $("#play-text");
    const stats = $("#play-stats");
    const started = performance.now();
    const chunk = Number($("#play-temp").value) > 1.2 ? 4 : 2;
    state.play.char = 0;
    output.textContent = "";

    const write = () => {
      if (!state.play.running) return;
      state.play.char = Math.min(text.length, state.play.char + chunk);
      output.textContent = text.slice(0, state.play.char);
      if (state.play.char < text.length) {
        const caret = document.createElement("span");
        caret.className = "caret";
        output.appendChild(caret);
        state.play.timer = setTimeout(write, 14);
      } else {
        const elapsed = Math.round(performance.now() - started);
        state.play.running = false;
        state.play.timer = null;
        $("#play-stop").disabled = true;
        $("#play-send").disabled = false;
        $("#play-meta").textContent = "200 OK";
        stats.innerHTML = `<span>route <b>${esc(meta.label)}</b></span><span>model <b>${esc(meta.model)}</b></span><span>latency <b>${num(elapsed)} ms</b></span><span>tokens <b>${num(meta.tokens)}</b></span><span>cost <b>${money(meta.cost)}</b></span>`;
        addTrace(meta.pool, meta, 200, elapsed, meta.cost, meta.tokens);
      }
    };
    write();
  }

  $("#play-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.play.running) return;
    const pool = poolById($("#play-pool").value) || poolById("default");
    const target = pickTarget(pool);
    const prompt = $("#play-prompt").value.trim();
    if (!prompt) { toast("Write a message first", "warn"); $("#play-prompt").focus(); return; }
    if (!target) {
      $("#play-meta").textContent = "502 no_healthy_upstream";
      $("#play-text").innerHTML = `<span class="muted">Every target in ${esc(pool.name)} is offline. The gateway would answer 502 without calling a provider.</span>`;
      toast("No healthy target in this pool", "bad");
      return;
    }
    state.play.running = true;
    $("#play-send").disabled = true;
    $("#play-stop").disabled = false;
    $("#play-meta").textContent = "streaming…";
    $("#play-stats").innerHTML = "";
    const tokens = rand(180, 420);
    const meta = {
      pool: pool.name,
      label: target.label,
      model: target.model,
      tokens,
      cost: Math.round(tokens * 0.0000009 * 100000) / 100000
    };
    if (!$("#play-stream").checked) {
      $("#play-text").textContent = ANSWER;
      $("#play-meta").textContent = "200 OK";
      $("#play-stats").innerHTML = `<span>route <b>${esc(meta.label)}</b></span><span>model <b>${esc(meta.model)}</b></span><span>tokens <b>${num(tokens)}</b></span><span>cost <b>${money(meta.cost)}</b></span>`;
      addTrace(meta.pool, meta, 200, rand(700, 1500), meta.cost, tokens);
      return;
    }
    streamAnswer(ANSWER, meta);
  });

  $("#play-stop").addEventListener("click", () => {
    stopPlayback();
    const output = $("#play-text");
    if (output.textContent) output.textContent += "\n\n[stopped by the operator]";
    $("#play-meta").textContent = "stopped";
    toast("Generation stopped; usage was not billed", "warn");
  });

  /* ---------------- logs filters ---------------- */

  $("#log-search").addEventListener("input", renderLogs);
  $("#log-status").addEventListener("change", renderLogs);
  $("#log-pool").addEventListener("change", renderLogs);

  /* ---------------- ambient drift ---------------- */

  setInterval(() => {
    if (state.view !== "dashboard" || document.hidden) return;
    state.stats.latency = Math.max(600, state.stats.latency + rand(-18, 22));
    renderKpis();
    drawSpark();
  }, 7000);

  window.addEventListener("resize", drawSpark);

  /* ---------------- boot ---------------- */

  renderAll();
  setView(location.hash.slice(1) || "dashboard");
  document.documentElement.dataset.ready = "true";
})();
