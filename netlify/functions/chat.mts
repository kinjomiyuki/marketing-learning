import type { Config } from "@netlify/functions";

// Marketing Learn の質問チャット用プロキシ。
// APIキーはブラウザに出さず、Netlify の環境変数 ANTHROPIC_API_KEY から読む。

const MODEL = Netlify.env.get("CLAUDE_MODEL") || "claude-haiku-5-5";
const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;

const SYSTEM_PROMPT =
  "あなたはマーケティング学習アプリ「Marketing Learn」の学習アシスタントです。" +
  "ユーザーはマーケティングの基礎、4P、STP、CAC、LTV、コンバージョン率、リテンション戦略などについて質問します。" +
  "学習者にわかりやすく、簡潔に（3〜5文程度、必要なら箇条書き）日本語で答えてください。";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "POSTで呼び出してください。", code: "bad_request" }, 405);
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      { error: "チャットの設定が完了していません（サーバーにAPIキーがありません）。", code: "not_configured" },
      500,
    );
  }

  let messages: { role: string; content: string }[];
  try {
    const body = await req.json();
    messages = body.messages;
  } catch {
    return json({ error: "リクエストの形式が正しくありません。", code: "bad_request" }, 400);
  }

  const valid =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    ) &&
    messages[messages.length - 1].role === "user";
  if (!valid) {
    return json({ error: "リクエストの形式が正しくありません。", code: "bad_request" }, 400);
  }

  // 直近の会話だけを送り、長すぎる入力は切り詰める
  const trimmed = messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_CHARS),
  }));
  while (trimmed.length > 1 && trimmed[0].role !== "user") trimmed.shift();

  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: trimmed,
      }),
    });
  } catch {
    return json({ error: "AIサービスに接続できませんでした。", code: "upstream_error" }, 502);
  }

  if (!upstream.ok) {
    console.error("Anthropic API error", upstream.status, await upstream.text());
    if (upstream.status === 429) {
      return json({ error: "しばらく時間をおいてから再度お試しください。", code: "rate_limited" }, 429);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ error: "チャットの認証設定に問題があります（APIキーを確認してください）。", code: "not_configured" }, 502);
    }
    return json({ error: "エラーが発生しました。もう一度お試しください。", code: "upstream_error" }, 502);
  }

  const data = await upstream.json();
  if (data.stop_reason === "refusal") {
    return json({ error: "その質問には回答できませんでした。別の聞き方をお試しください。", code: "refused" }, 200);
  }
  const text = (data.content || [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  if (!text) {
    return json({ error: "回答を取得できませんでした。もう一度お試しください。", code: "upstream_error" }, 502);
  }
  return json({ text });
};

export const config: Config = {
  path: "/api/chat",
  method: "POST",
};
