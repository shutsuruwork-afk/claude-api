"use strict";

// PC のサーバー (web.py) なしで、ブラウザから Claude API を直接呼ぶモード。
// API キーはこの端末のブラウザにだけ保存される。
// モデル表・単価・リクエストの組み立ては web.py と同じ内容にそろえること。

const Direct = (() => {
  const KEY_STORE = "claude-chat:key";

  // USD / 100万トークン
  const MODELS = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4.0, output: 20.0, cache_read: 0.2 },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2", input: 8.0, output: 40.0, cache_read: 0.2 },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2.0, output: 10.0, cache_read: 0.1 },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cache_read: 0.01 },
  ];
  const DEFAULT_MODEL = "claude-opus-5-5";
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  // 会話履歴を 1 時間キャッシュする。書き込みは入力単価の 2 倍。
  const CACHE_CONTROL = { type: "ephemeral", ttl: "1h" };
  const CACHE_WRITE_MULTIPLIER = 2;

  // 安全分類器が応答を止めたとき、API 側で別モデルに引き継ぐ。
  const FALLBACK_BETA = "server-side-fallback-2026-07-01";
  const FALLBACK_MODELS = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"];

  const isThinking = (block) => block.type === "thinking" || block.type === "redacted_thinking";

  const getKey = () => {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
  };
  const setKey = (key) => {
    try {
      if (key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch {}
  };

  let sdkLoading = null;
  function loadSdk() {
    sdkLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/anthropic.min.js";
      script.onload = resolve;
      script.onerror = () => { sdkLoading = null; reject(new Error("SDK を読み込めませんでした")); };
      document.head.append(script);
    });
    return sdkLoading;
  }

  function usageSummary(model, usage) {
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const summary = { input: usage.input_tokens, output: usage.output_tokens, cache_read: cacheRead, cache_write: cacheWrite, cost: null, saved: null };
    const price = MODELS.find((m) => m.id === model);
    if (price) {
      summary.cost = (usage.input_tokens * price.input
        + cacheWrite * price.input * CACHE_WRITE_MULTIPLIER
        + cacheRead * price.cache_read
        + usage.output_tokens * price.output) / 1e6;
      summary.saved = cacheRead * (price.input - price.cache_read) / 1e6;
    }
    return summary;
  }

  function buildParams({ model, effort, system, messages }) {
    const params = {
      model,
      max_tokens: 64000,
      messages,
      cache_control: CACHE_CONTROL,
      thinking: { type: "adaptive", display: "summarized" },
    };
    // システムプロンプトは空なら送らない = 素の Claude。
    if (system && system.trim()) params.system = system.trim();
    if (EFFORTS.includes(effort)) params.output_config = { effort };
    return params;
  }

  function openStream(client, params, signal) {
    if (FALLBACK_MODELS.includes(params.model)) {
      return client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" }, { signal });
    }
    return client.messages.stream(params, { signal });
  }

  async function* streamOnce(client, params, signal, thinkingStripped) {
    const stream = openStream(client, params, signal);
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield ["text", { text: event.delta.text }];
        else if (event.delta.type === "thinking_delta") yield ["thinking", { text: event.delta.thinking }];
      } else if (event.type === "content_block_start" && event.content_block.type === "thinking") {
        yield ["thinking", { text: "" }];
      }
    }
    const message = await stream.finalMessage();
    // 途中で別モデルに引き継がれたターンは、引き継ぎ前の思考ブロックを送り返せない。
    const fallbackAt = message.content.map((b) => b.type).lastIndexOf("fallback");
    const content = message.content.filter((b, i) => i > fallbackAt || !isThinking(b));
    yield ["done", {
      content,
      model: message.model,
      stop_reason: message.stop_reason,
      usage: usageSummary(message.model, message.usage),
      thinking_stripped: thinkingStripped,
    }];
  }

  // web.py の /api/chat と同じイベント列 ([名前, データ]) を返す。
  async function* events(request, signal) {
    await loadSdk();
    const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true });
    let params = buildParams(request);
    try {
      try {
        yield* streamOnce(client, params, signal, false);
      } catch (e) {
        // 思考ブロックの署名が通らない場合は、思考を外して一度だけやり直す (出力前に決まるエラー)。
        if (!(e instanceof Anthropic.BadRequestError) || !String(e.message).includes("signature")) throw e;
        const messages = params.messages.map((m) =>
          Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => !isThinking(b)) } : m);
        params = { ...params, messages };
        yield* streamOnce(client, params, signal, true);
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof Anthropic.AuthenticationError) {
        yield ["error", { message: "APIキーが無効です。左のメニューの「APIキー」から入れ直してください。" }];
      } else if (e instanceof Anthropic.RateLimitError) {
        yield ["error", { message: "レート制限に達しました。少し待ってから再送してください。" }];
      } else if (e instanceof Anthropic.APIConnectionError) {
        yield ["error", { message: "Claude API に接続できませんでした。通信状況を確認してください。" }];
      } else if (e instanceof Anthropic.APIError) {
        yield ["error", { message: `APIエラー ${e.status}: ${e.message}` }];
      } else {
        throw e;
      }
    }
  }

  return { MODELS, DEFAULT_MODEL, getKey, setKey, events };
})();
