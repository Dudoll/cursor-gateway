import type { RunRecord, SocialInterviewReportId } from "@cursor-gateway/shared";

export type XiaohongshuCard = {
  kind: "cover" | "question" | "summary" | "continuation";
  kicker: string;
  source?: string;
  title: string;
  body: string;
  footer: string;
};

export type XiaohongshuDraft = {
  reportId: SocialInterviewReportId;
  runId: string;
  title: string;
  body: string;
  landingUrl: string;
  hashtags: string[];
  cards: XiaohongshuCard[];
};

function compactMarkdown(value: string, limit: number) {
  const compact = value
    .replace(/```[\s\S]*?```/g, "[代码见完整面经]")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[-*>#]+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
}

function field(section: string, name: string) {
  const pattern = new RegExp(`\\*\\*${name}：\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[^\\n]+：\\*\\*|$)`);
  return pattern.exec(section)?.[1]?.trim() ?? "";
}

function questionCards(markdown: string, date: string): XiaohongshuCard[] {
  const headings = [...markdown.matchAll(/^### (W1|Q[1-5])(?:｜|\|)?\s*(.+)$/gm)];
  return headings.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? markdown.indexOf("\n## 今日", start);
    const section = markdown.slice(start, end > start ? end : undefined);
    const prompt = field(section, "题目");
    const focus = field(section, "考察点");
    const answer = field(section, "参考答案");
    const questionCode = match[1] ?? `Q${index + 1}`;
    const headingText = match[2] ?? "面试题";
    // The heading may contain source info such as
    // "来源线索： Reddit + Anthropic". Use it as the small-font source.
    const sourceText = compactMarkdown(headingText, 80).replace(/^来源线索/, "面经来源");
    return {
      kind: "question" as const,
      kicker: `${questionCode} · ${focus ? compactMarkdown(focus, 42) : "面试真题"}`,
      ...(sourceText ? { source: sourceText } : {}),
      title: compactMarkdown(prompt || headingText, 60),
      body: answer ? `答题抓手：\n${answer}` : "",
      footer: `${date} · 完整答案与个性化训练见主页`
    };
  });
}

export function buildXiaohongshuDraft(input: {
  reportId: SocialInterviewReportId;
  reportName: string;
  run: RunRecord;
  publicOrigin: string;
}): XiaohongshuDraft {
  const date = input.run.idempotencyKey?.split(":").at(-1) ?? input.run.createdAt.slice(0, 10);
  const isAgent = input.reportId === "ai-agent-mianshi";
  const focus = isAgent ? "AI Agent 开发" : "AI Infra";
  const response = input.run.response ?? "";
  const questions = questionCards(response, date);
  const cards: XiaohongshuCard[] = [
    {
      kind: "cover",
      kicker: "DAILY INTERVIEW SIGNAL",
      title: `${focus}\n大厂面经 1+5`,
      body: isAgent
        ? "优选 Java 转 AI Agent：工具调用、MCP、RAG、评测与生产工程"
        : "聚焦推理服务、GPU、性能优化、系统设计与线上排障",
      footer: `${date} · 来源分级 · 拒绝伪造面经`
    },
    ...questions
  ];
  const summary = response.split("## 今日总结").at(1) ?? response.split("## 今日趋势小结").at(1);
  if (summary) {
    cards.push({
      kind: "summary",
      kicker: "TREND / NEXT STEP",
      title: "今天应该重点准备什么？",
      body: compactMarkdown(summary, 600),
      footer: "根据 AI 日报与历史面经动态更新"
    });
  }

  const title = `${focus} 大厂面经｜1 道笔试 + 5 道面试题`;
  const list = questions
    .slice(0, 6)
    .map((card, idx) => `${idx === 0 ? "笔试" : `Q${idx}`}｜${card.title}`)
    .join("\n");
  const hashtags = isAgent
    ? ["AI面试", "AIAgent", "Java转AI", "面试题", "程序员求职"]
    : ["AI面试", "AIInfra", "大模型推理", "面试题", "程序员求职"];
  return {
    reportId: input.reportId,
    runId: input.run.id,
    title: compactMarkdown(title, 40),
    body: compactMarkdown(
      `${date} 的 ${focus} 面经精选：\n\n${list}\n\n每题附参考答案、追问和趋势总结。完整内容与个性化训练见主页。\n\n${hashtags
        .map((tag) => `#${tag}`)
        .join(" ")}`,
      1_000
    ),
    landingUrl: `${input.publicOrigin}/reports/${input.reportId}`,
    hashtags,
    cards
  };
}
