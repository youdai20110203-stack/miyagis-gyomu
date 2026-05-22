// Vercel Serverless Function — Claude API プロキシ
// APIキーは環境変数 ANTHROPIC_API_KEY に格納（フロントには露出しない）

const SYSTEM_PROMPTS = {
  consult: `あなたは宮城県の建設現場で働く職人・現場監督・社長をサポートする実務AIアシスタントです。
建設業界の専門知識（工程管理、安全管理、施工方法、法令、見積もり、人員配置など）に詳しく、
現場のリアルな悩みに対して、簡潔で実用的なアドバイスを日本語で返します。
専門用語は使ってよいですが、難しい場合はかみ砕いて説明します。回答は丁寧かつ親しみやすく。`,

  business: `あなたは「宮城の建設業向けAI導入支援サービス」の事業説明AIです。
このサービスは、地元・宮城県の工務店や中堅建設会社に対して、AIを使って日報作成・見積もり補助・
事務作業の効率化を支援するものです。運営は地元の高校生2人。
見込み客（建設会社の社長）に対して、サービスのメリットを分かりやすく、信頼感を持って説明してください。
「現場がどう楽になるか」を具体的に伝え、押し売りはせず誠実に対応します。日本語で簡潔に。`,

  assistant: `あなたは建設業務支援ツールのアシスタントAIです。
ユーザーが日報作成・見積もり・請求書・顧客管理などの業務をスムーズに進められるよう、
操作のサポートや、入力内容の整形・要約・チェックを行います。
ユーザーが入力した現場メモや数値をもとに、整った文章や計算結果を提案してください。日本語で簡潔・実用的に。`,

  general: `あなたは親切で有能なAIアシスタントです。ユーザーの質問やお願いに対して、
正確で分かりやすい回答を日本語で返してください。簡潔さを心がけつつ、必要な情報はしっかり伝えます。`,

  report: `あなたは建設現場の作業日報を整形する専門AIです。
ユーザーが入力した「現場名」と「殴り書きのメモ」をもとに、正式な作業日報に整形してください。

【出力ルール】
- 必ず以下の厳密なフォーマットで、ラベル行とその内容だけを出力すること。前置きや後書き、説明文は一切書かない。
- 各セクションの項目は1行に1つ、行頭に「・」を付ける。
- 情報が無いセクションは「・特になし」と書く。
- 天気・気温はメモに記載があればそれを、無ければ「・記載なし」と書く（推測で創作しない）。
- 作業員はメモから人数を読み取る。不明なら「記載なし」。

【出力フォーマット】
日付: （指定された日付）
天気: （天気・気温）
作業員: （人数や氏名）
[業務内容]
・…
[課題・気づき]
・…
[特記事項]
・…
[明日の予定]
・…`
};

// Markdown記法（**強調**, *斜体*, # 見出し, ` コード）を除去してプレーンテキスト化
function stripMarkdown(text) {
  return String(text)
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '・');
}

export default async function handler(req, res) {
  // CORS（同一オリジンなら不要だが、別ホスト配信に備えて許可）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'APIキーが設定されていません（ANTHROPIC_API_KEY）' });
  }

  try {
    const { messages, mode } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages が不正です' });
    }

    const basePrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.general;
    // 全モード共通: Markdown記法を使わせない（アスタリスク等の混入を防ぐ）
    const systemPrompt = basePrompt +
      '\n\n【重要】回答にMarkdown記法（**強調**、*斜体*、# 見出し、` コードなど）は一切使わないこと。記号を使わず、自然な日本語の文章で書くこと。箇条書きが必要なときは行頭に「・」を使うこと。';

    // 履歴が長すぎる場合は直近 20 件に制限（コスト・トークン対策）
    const trimmed = messages.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000)
    }));

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const MAX_RETRIES = 4;
    let response;
    let lastErrText = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: trimmed
        })
      });

      if (response.ok) break;

      lastErrText = await response.text();

      // 過負荷(529)・レート制限(429)・一時的サーバーエラー(5xx)はリトライ
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) break;

      // 指数バックオフ: 0.5s, 1s, 2s, 4s
      await sleep(500 * Math.pow(2, attempt));
    }

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, lastErrText);
      const isOverloaded = response.status === 529 || lastErrText.includes('overloaded');
      return res.status(response.status).json({
        error: isOverloaded
          ? 'AIが混雑しています。少し待ってからもう一度送信してください。'
          : 'AI応答の取得に失敗しました',
        detail: lastErrText.slice(0, 500)
      });
    }

    const data = await response.json();
    const rawReply = data?.content?.[0]?.text || '（応答が空でした）';
    const reply = stripMarkdown(rawReply);

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'サーバーエラー', detail: String(err).slice(0, 500) });
  }
}
