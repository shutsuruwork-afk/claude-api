"use strict";

const STORE_KEY = "claude-chat:v1";
const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------- 状態 ----------

let models = [];
let store = loadStore();
let current = null;      // 表示中の会話
let run = null;          // 応答中なら { conv, abort, text, thinking, thinkingLive, node }
let lastError = new Map(); // conv.id -> 直近のエラー文

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.convs)) return saved;
  } catch {}
  return { convs: [], activeId: null, model: null, effort: "", cost: 0, saved: 0 };
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    showBanner("ブラウザの保存領域がいっぱいです。古い会話を削除してください。");
  }
}

function newConv() {
  return {
    id: crypto.randomUUID(),
    title: "",
    model: store.model || models[0]?.id,
    effort: store.effort || "",
    system: "",
    messages: [],
    cost: 0,
    updatedAt: Date.now(),
  };
}

// ---------- 表示用ヘルパー ----------

const fmtInt = (n) => n.toLocaleString("ja-JP");
const fmtCost = (c) => "$" + (c > 0 && c < 0.1 ? c.toFixed(4) : c.toFixed(2));
const modelLabel = (id) => models.find((m) => m.id === id)?.label || id;
const blocksText = (content, type, field) =>
  typeof content === "string"
    ? (type === "text" ? content : "")
    : content.filter((b) => b.type === type).map((b) => b[field] || "").join(type === "text" ? "" : "\n\n");

function renderMarkdown(target, text, final) {
  if (!window.marked || !window.DOMPurify) {
    target.classList.add("plain");
    target.textContent = text;
    return;
  }
  target.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
  for (const a of target.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const table of target.querySelectorAll("table")) {
    const wrap = el("div", "table-wrap");
    table.replaceWith(wrap);
    wrap.append(table);
  }
  if (!final) return;
  for (const code of target.querySelectorAll("pre code")) {
    if (window.hljs) hljs.highlightElement(code);
    const button = el("button", "code-copy", "コピー");
    button.type = "button";
    button.onclick = () => copyText(code.textContent, button);
    code.parentElement.append(button);
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "コピーしました";
    setTimeout(() => (button.textContent = label), 1200);
  } catch {}
}

function showBanner(html) {
  $("banner").innerHTML = html;
  $("banner").hidden = false;
}

// ---------- スクロール ----------

const scroller = $("scroll");
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);

// ---------- サイドバー ----------

function renderSidebar() {
  const list = $("convList");
  list.replaceChildren();
  const convs = [...store.convs].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!convs.length) list.append(el("div", "conv-empty", "まだ会話はありません"));
  for (const conv of convs) {
    const row = el("div", "conv" + (conv === current ? " active" : ""));
    const title = el("button", "conv-title", conv.title || "新しい会話");
    title.type = "button";
    title.onclick = () => openConv(conv);
    const del = el("button", "conv-del", "×");
    del.type = "button";
    del.title = "この会話を削除";
    del.setAttribute("aria-label", "この会話を削除");
    del.onclick = () => deleteConv(conv);
    row.append(title, del);
    list.append(row);
  }
  $("totalCost").textContent = fmtCost(store.cost || 0);
  $("totalSaved").textContent = fmtCost(store.saved || 0);
}

function openConv(conv) {
  current = conv;
  store.activeId = store.convs.includes(conv) ? conv.id : null;
  saveStore();
  document.body.classList.remove("nav-open");
  renderAll();
  toBottom();
  $("input").focus();
}

function deleteConv(conv) {
  if (!confirm(`「${conv.title || "新しい会話"}」を削除しますか？`)) return;
  if (run?.conv === conv) run.abort.abort();
  store.convs = store.convs.filter((c) => c !== conv);
  if (current === conv) current = newConv();
  store.activeId = store.convs.includes(current) ? current.id : null;
  saveStore();
  renderAll();
}

// ---------- スレッド ----------

function renderAll() {
  renderSidebar();
  renderControls();
  renderThread();
}

function renderControls() {
  $("modelSelect").value = current.model;
  $("effortSelect").value = current.effort;
  $("convCost").textContent = current.cost ? `この会話 ${fmtCost(current.cost)}` : "";
  const busyHere = run?.conv === current;
  const busyElsewhere = run && !busyHere;
  document.body.classList.toggle("streaming", busyHere);
  const send = $("sendBtn");
  send.disabled = busyElsewhere || (!busyHere && !$("input").value.trim());
  send.title = busyElsewhere ? "別の会話で応答中です" : "";
  send.setAttribute("aria-label", busyHere ? "停止" : "送信");
}

function renderThread() {
  const thread = $("thread");
  thread.replaceChildren();
  const messages = current.messages;

  if (!messages.length) {
    thread.append(emptyState());
    return;
  }
  if (current.system) {
    const chip = el("details", "system-chip");
    chip.append(el("summary", "", "システムプロンプトあり"), el("pre", "", current.system));
    thread.append(chip);
  }

  const busy = run?.conv === current;
  messages.forEach((message, index) => {
    const last = index === messages.length - 1;
    thread.append(message.role === "user" ? userNode(message) : assistantNode(message, last && !busy));
  });

  if (busy) {
    thread.append(run.node);
  } else if (messages.at(-1).role === "user") {
    const error = lastError.get(current.id);
    const bar = el("div", "retry" + (error ? " error" : ""));
    const button = el("button", "", "再送");
    button.type = "button";
    button.onclick = () => startRun(current);
    bar.append(el("span", "", error || "このメッセージにはまだ応答がありません。"), button);
    thread.append(bar);
  }
}

function emptyState() {
  const wrap = el("div", "empty");
  wrap.append(el("h1", "", "素の Claude"), el("p", "", "システムプロンプトなし。API にそのままつながっています。"));

  const details = el("details", "system-edit");
  details.open = Boolean(current.system);
  const area = el("textarea");
  area.placeholder = "例: あなたは辛口の編集者です。";
  area.value = current.system;
  area.oninput = () => (current.system = area.value);
  details.append(
    el("summary", "", "システムプロンプトを付ける(任意)"),
    area,
    el("small", "", "空のままなら素の Claude です。最初のメッセージを送ったあとは変更できません。"),
  );
  wrap.append(details);
  return wrap;
}

function userNode(message) {
  const node = el("div", "msg user");
  node.append(el("div", "bubble", message.content));
  return node;
}

function thinkingNode(text, live) {
  const details = el("details", "thinking" + (live ? " live" : ""));
  const summary = el("summary");
  summary.append(el("span", "", live ? "考え中…" : "思考の要約"));
  details.append(summary, el("div", "thinking-text", text));
  return details;
}

function assistantNode(message, isLast) {
  const node = el("div", "msg assistant");
  const thinking = blocksText(message.content, "thinking", "thinking").trim();
  if (thinking) node.append(thinkingNode(thinking, false));

  const text = blocksText(message.content, "text", "text");
  const body = el("div", "body");
  renderMarkdown(body, text, true);
  node.append(body);

  const meta = message.meta || {};
  if (meta.stopped) node.append(el("p", "note", "途中で停止しました。"));
  if (meta.stop_reason === "max_tokens") node.append(el("p", "note", "出力の上限に達したため、途中で切れています。"));
  if (meta.model && meta.model !== meta.requested) {
    node.append(el("p", "note", `このターンは ${modelLabel(meta.model)} が応答しました。`));
  }

  const row = el("div", "meta");
  const actions = el("div", "actions");
  const copy = el("button", "", "コピー");
  copy.type = "button";
  copy.onclick = () => copyText(text, copy);
  actions.append(copy);
  if (isLast) {
    const again = el("button", "", "再生成");
    again.type = "button";
    again.onclick = () => regenerate();
    actions.append(again);
  }
  row.append(actions);

  const usage = meta.usage;
  if (usage) {
    const stats = el("span", "stats");
    const parts = [`入力 ${fmtInt(usage.input + usage.cache_read + usage.cache_write)}`, `出力 ${fmtInt(usage.output)}`];
    stats.append(parts.join(" ・ "));
    if (usage.cache_read) {
      stats.append(" ・ ", el("span", "cache-hit", `キャッシュ利用 ${fmtInt(usage.cache_read)}`));
    }
    if (usage.cost != null) stats.append(` ・ ${fmtCost(usage.cost)}`);
    stats.title = `新規入力 ${fmtInt(usage.input)} / キャッシュ読み出し ${fmtInt(usage.cache_read)} / キャッシュ書き込み ${fmtInt(usage.cache_write)} / 出力 ${fmtInt(usage.output)} トークン`;
    row.append(stats);
  }
  node.append(row);
  return node;
}

// ---------- 応答中の表示 ----------

function liveNode() {
  const node = el("div", "msg assistant");
  node.append(el("span", "cursor"));
  return node;
}

let framePending = false;
function scheduleLiveRender() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    if (!run || run.conv !== current) return;
    const stick = nearBottom();
    const node = run.node;
    const openState = node.querySelector(".thinking")?.open;
    node.replaceChildren();
    if (run.thinkingLive || run.thinking) {
      const thinking = thinkingNode(run.thinking, !run.text);
      thinking.open = Boolean(openState);
      node.append(thinking);
    }
    if (run.text) {
      const body = el("div", "body");
      renderMarkdown(body, run.text, false);
      node.append(body);
    } else if (!run.thinkingLive) {
      node.append(el("span", "cursor"));
    }
    if (stick) toBottom();
  });
}

// ---------- 送受信 ----------

function submit() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || run) return;

  if (!store.convs.includes(current)) {
    current.system = current.system.trim();
    store.convs.push(current);
    store.activeId = current.id;
  }
  if (!current.title) current.title = text.split("\n")[0].slice(0, 40);
  current.messages.push({ role: "user", content: text });
  input.value = "";
  resizeInput();
  startRun(current);
}

function regenerate() {
  if (run || current.messages.at(-1)?.role !== "assistant") return;
  current.messages.pop();
  startRun(current);
}

async function startRun(conv) {
  if (run) return;
  lastError.delete(conv.id);
  conv.updatedAt = Date.now();
  run = { conv, abort: new AbortController(), text: "", thinking: "", thinkingLive: false, node: liveNode() };
  saveStore();
  renderAll();
  toBottom();

  let done = null;
  let error = null;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: run.abort.signal,
      body: JSON.stringify({
        model: conv.model,
        effort: conv.effort,
        system: conv.system,
        messages: conv.messages.map(({ role, content }) => ({ role, content })),
      }),
    });
    if (!response.ok) {
      error = (await response.json().catch(() => ({}))).error || `サーバーエラー (${response.status})`;
    } else {
      for await (const [name, data] of readEvents(response.body)) {
        if (name === "text") {
          run.text += data.text;
          run.thinkingLive = false;
        } else if (name === "thinking") {
          run.thinking += data.text;
          run.thinkingLive = true;
        } else if (name === "done") {
          done = data;
        } else if (name === "error") {
          error = data.message;
        }
        scheduleLiveRender();
      }
      if (!done && !error) error = "応答の途中で接続が切れました。";
    }
  } catch (e) {
    if (e.name !== "AbortError") error = "サーバーに接続できません。web.py が動いているか確認してください。";
  }

  finishRun(conv, done, error);
}

async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = chunk.match(/^event: (.*)$/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (name && data) yield [name, JSON.parse(data)];
    }
  }
}

function finishRun(conv, done, error) {
  const partial = run.text;
  run = null;

  if (done && done.stop_reason === "refusal") {
    error = "安全フィルタにより応答が止められました。言い方を変えて送り直してみてください。";
  } else if (done && !done.content.some((b) => b.type === "text" && b.text)) {
    error = "空の応答が返ってきました。";
  } else if (done) {
    if (done.thinking_stripped) {
      // サーバーが思考ブロックを外して送り直した。保存している履歴も同じ形にそろえる。
      for (const message of conv.messages) {
        if (Array.isArray(message.content)) {
          message.content = message.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
        }
      }
    }
    conv.messages.push({
      role: "assistant",
      content: done.content,
      meta: { model: done.model, requested: conv.model, stop_reason: done.stop_reason, usage: done.usage },
    });
    const { cost, saved } = done.usage;
    conv.cost += cost || 0;
    store.cost = (store.cost || 0) + (cost || 0);
    store.saved = (store.saved || 0) + (saved || 0);
  } else if (!error && partial) {
    // 停止ボタン: ここまでの文章だけを残す (トークン数は取得できないのでコストには入らない)。
    conv.messages.push({ role: "assistant", content: [{ type: "text", text: partial }], meta: { stopped: true } });
  }

  if (error) lastError.set(conv.id, error);
  conv.updatedAt = Date.now();
  saveStore();

  const stick = nearBottom();
  renderAll();
  if (stick && conv === current) toBottom();
}

// ---------- 入力欄 ----------

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
  renderControls();
}

$("input").addEventListener("input", resizeInput);
$("input").addEventListener("keydown", (e) => {
  // 日本語変換の確定 Enter では送信しない。
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  submit();
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (run?.conv === current) run.abort.abort();
  else submit();
});

$("newChat").onclick = () => openConv(newConv());
$("menuBtn").onclick = () => document.body.classList.add("nav-open");
$("scrim").onclick = () => document.body.classList.remove("nav-open");

$("modelSelect").onchange = (e) => {
  current.model = store.model = e.target.value;
  saveStore();
};
$("effortSelect").onchange = (e) => {
  current.effort = store.effort = e.target.value;
  saveStore();
};

// ---------- 起動 ----------

async function init() {
  try {
    const config = await (await fetch("/api/config")).json();
    models = config.models;
    for (const model of models) {
      const option = el("option", "", model.label);
      option.value = model.id;
      $("modelSelect").append(option);
    }
    store.model = models.some((m) => m.id === store.model) ? store.model : config.defaultModel;
    if (!config.hasKey) {
      showBanner("APIキーが設定されていません。ターミナルで <code>export ANTHROPIC_API_KEY=sk-ant-...</code> を実行してから <code>python web.py</code> を起動し直してください。");
    }
  } catch {
    showBanner("サーバーに接続できません。<code>python web.py</code> が動いているか確認してください。");
  }
  current = store.convs.find((c) => c.id === store.activeId) || newConv();
  renderAll();
  toBottom();
}

init();
