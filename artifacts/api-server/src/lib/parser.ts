import type { AiAnalysis } from "./aiAnalyzer";
import { analyzeWithAi } from "./aiAnalyzer";

export interface ParsedSection {
  type: string;
  content: Record<string, unknown>;
  rawHtml?: string;
  semanticType?: string;
  confidence?: number;
  source?: "ai" | "heuristic";
}

export interface ParsedPage {
  name: string;
  slug: string;
  sections: ParsedSection[];
}

export interface ParsedSite {
  pages: ParsedPage[];
}

export interface DesignSystem {
  font: string;
  fontHeading?: string;
  colors: string[];
  primaryColor?: string;
  buttonStyle: string;
  headingStyle: string;
}

const SECTION_PATTERNS: Array<{ type: string; keywords: string[] }> = [
  { type: "hero", keywords: ["hero", "banner", "jumbotron", "headline", "above-the-fold", "main-header"] },
  { type: "features", keywords: ["features", "feature", "benefits", "capabilities", "highlights", "services"] },
  { type: "about", keywords: ["about", "who-we-are", "our-story", "mission", "vision", "team"] },
  { type: "testimonials", keywords: ["testimonials", "testimonial", "reviews", "review", "quotes", "clients"] },
  { type: "pricing", keywords: ["pricing", "price", "plans", "packages", "tiers", "cost"] },
  { type: "faq", keywords: ["faq", "faqs", "questions", "accordion", "q-and-a"] },
  { type: "cta", keywords: ["cta", "call-to-action", "get-started", "signup", "sign-up", "join", "try"] },
  { type: "gallery", keywords: ["gallery", "portfolio", "showcase", "work", "projects", "case-studies"] },
  { type: "blog", keywords: ["blog", "posts", "articles", "news", "updates", "insights"] },
  { type: "contact", keywords: ["contact", "get-in-touch", "reach-us", "support", "form"] },
  { type: "footer", keywords: ["footer", "bottom", "site-footer"] },
];

function classifySection(element: Element): string {
  const id = (element.getAttribute("id") || "").toLowerCase();
  const className = (element.getAttribute("class") || "").toLowerCase();
  const dataSection = (element.getAttribute("data-section") || "").toLowerCase();
  const ariaLabel = (element.getAttribute("aria-label") || "").toLowerCase();
  const combined = `${id} ${className} ${dataSection} ${ariaLabel}`;

  for (const { type, keywords } of SECTION_PATTERNS) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) return type;
    }
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "header") return "hero";
  if (tag === "footer") return "footer";
  if (tag === "nav") return "custom";

  const text = element.textContent?.toLowerCase() || "";
  for (const { type, keywords } of SECTION_PATTERNS) {
    for (const keyword of keywords) {
      if (text.includes(keyword) && text.length < 5000) return type;
    }
  }

  return "custom";
}

function extractSectionContent(element: Element, type: string): Record<string, unknown> {
  const content: Record<string, unknown> = {};

  const h1 = element.querySelector("h1");
  const h2 = element.querySelector("h2");
  const h3 = element.querySelector("h3");
  const heading = h1 || h2 || h3;
  if (heading) content.title = heading.textContent?.trim() || "";

  const paragraphs = Array.from(element.querySelectorAll("p")).map(
    (p) => p.textContent?.trim() || ""
  ).filter(Boolean);
  if (paragraphs.length > 0) content.subtitle = paragraphs[0];
  if (paragraphs.length > 1) content.description = paragraphs.slice(1).join(" ");

  const buttons = Array.from(element.querySelectorAll("a, button")).map((el) => ({
    label: el.textContent?.trim() || "",
    href: el.getAttribute("href") || "",
  })).filter((b) => b.label);
  if (buttons.length > 0) content.cta = buttons[0].label;
  if (buttons.length > 1) content.ctaSecondary = buttons[1].label;

  const images = Array.from(element.querySelectorAll("img")).map((img) => ({
    src: img.getAttribute("src") || "",
    alt: img.getAttribute("alt") || "",
  })).filter((i) => i.src);
  if (images.length > 0) content.images = images;

  if (type === "features") {
    const items = Array.from(element.querySelectorAll("li, [class*='feature'], [class*='card']")).map((el) => ({
      title: el.querySelector("h3,h4,h5,strong")?.textContent?.trim() || "",
      description: el.querySelector("p")?.textContent?.trim() || el.textContent?.trim().slice(0, 200) || "",
    })).filter((i) => i.title || i.description).slice(0, 12);
    if (items.length > 0) content.items = items;
  }

  if (type === "testimonials") {
    const items = Array.from(element.querySelectorAll("[class*='testimonial'], [class*='review'], blockquote")).map((el) => ({
      quote: el.querySelector("p,blockquote")?.textContent?.trim() || el.textContent?.trim().slice(0, 300) || "",
      author: el.querySelector("[class*='author'], [class*='name'], cite")?.textContent?.trim() || "",
    })).filter((i) => i.quote).slice(0, 6);
    if (items.length > 0) content.items = items;
  }

  if (type === "pricing") {
    const plans = Array.from(element.querySelectorAll("[class*='plan'], [class*='price'], [class*='tier'], [class*='card']")).map((el) => ({
      name: el.querySelector("h3,h4,h5")?.textContent?.trim() || "",
      price: el.querySelector("[class*='price'], [class*='amount']")?.textContent?.trim() || "",
      features: Array.from(el.querySelectorAll("li")).map((li) => li.textContent?.trim() || "").filter(Boolean).slice(0, 8),
    })).filter((p) => p.name || p.price).slice(0, 4);
    if (plans.length > 0) content.plans = plans;
  }

  if (type === "faq") {
    const items = Array.from(element.querySelectorAll("[class*='faq'], [class*='accordion'], details, dt")).map((el) => ({
      question: el.querySelector("summary,dt,h4,h5,[class*='question']")?.textContent?.trim() || el.textContent?.trim().slice(0, 150) || "",
      answer: el.querySelector("dd,p,[class*='answer']")?.textContent?.trim() || "",
    })).filter((i) => i.question).slice(0, 10);
    if (items.length > 0) content.items = items;
  }

  return content;
}

function extractDesignSystem(html: string): DesignSystem {
  const fontMatch = html.match(/font-family:\s*['"]?([^'";\n,]+)/i);
  const font = fontMatch ? fontMatch[1].trim() : "Inter, sans-serif";

  const colorMatches = html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g);
  const colorSet = new Set<string>();
  for (const match of colorMatches) {
    colorSet.add(`#${match[1].toUpperCase()}`);
    if (colorSet.size >= 8) break;
  }

  const rgbMatches = html.matchAll(/rgb\((\d+,\s*\d+,\s*\d+)\)/g);
  for (const match of rgbMatches) {
    colorSet.add(`rgb(${match[1]})`);
    if (colorSet.size >= 10) break;
  }

  const buttonClassMatch = html.match(/class="[^"]*(?:btn|button)[^"]*"/i);
  const buttonStyle = buttonClassMatch ? buttonClassMatch[0] : "rounded";

  const headingMatch = html.match(/h1[^>]*style="([^"]+)"/i);
  const headingStyle = headingMatch ? headingMatch[1] : "bold";

  return {
    font,
    colors: Array.from(colorSet).slice(0, 8),
    buttonStyle,
    headingStyle,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function aiAnalysisToParsedSite(analysis: AiAnalysis): { parsedSite: ParsedSite; designSystem: DesignSystem } {
  const parsedSite: ParsedSite = {
    pages: analysis.pages.map((p) => ({
      name: p.name,
      slug: p.slug,
      sections: p.sections.map((s) => {
        const items = s.repeatItems && s.repeatItems.length > 0 ? s.repeatItems : undefined;
        const content: Record<string, unknown> = { ...s.fields };
        if (items) content.items = items;
        // Carry alternate keys mapper expects
        if (s.fields.headline && !content.title) content.title = s.fields.headline;
        if (s.fields.subheadline && !content.subtitle) content.subtitle = s.fields.subheadline;
        if (s.fields.description && !content.description) content.description = s.fields.description;
        if (s.fields.cta_text && !content.cta) content.cta = s.fields.cta_text;
        return {
          type: s.semanticType,
          semanticType: s.semanticType,
          confidence: s.confidence,
          source: "ai" as const,
          content,
        };
      }),
    })),
  };
  const designSystem: DesignSystem = {
    font: analysis.designSystem.font,
    fontHeading: analysis.designSystem.fontHeading,
    colors: analysis.designSystem.colors,
    primaryColor: analysis.designSystem.primaryColor,
    buttonStyle: analysis.designSystem.buttonStyle,
    headingStyle: analysis.designSystem.headingStyle,
  };
  return { parsedSite, designSystem };
}

export async function parseHtml(html: string): Promise<{
  parsedSite: ParsedSite;
  designSystem: DesignSystem;
  aiAnalysis: AiAnalysis | null;
}> {
  const ai = await analyzeWithAi(html);
  if (ai) {
    const { parsedSite, designSystem } = aiAnalysisToParsedSite(ai);
    return { parsedSite, designSystem, aiAnalysis: ai };
  }
  const heuristic = parseHtmlHeuristic(html);
  return { ...heuristic, aiAnalysis: null };
}

function parseHtmlHeuristic(html: string): {
  parsedSite: ParsedSite;
  designSystem: DesignSystem;
} {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const designSystem = extractDesignSystem(html);

  const pageTitle =
    document.querySelector("title")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    "Home";

  const body = document.body;
  const topLevelSections = Array.from(
    body.querySelectorAll(
      "section, article, header, footer, main > div, body > div, [id], [data-section]"
    )
  ).filter((el) => {
    const parent = el.parentElement;
    if (!parent) return true;
    const tagName = parent.tagName.toLowerCase();
    return tagName === "body" || tagName === "main" || parent === body;
  });

  const sections: ParsedSection[] = [];
  const seen = new Set<Element>();

  for (const el of topLevelSections) {
    if (seen.has(el)) continue;
    seen.add(el);

    const type = classifySection(el);
    const content = extractSectionContent(el, type);
    const rawHtml = el.outerHTML.slice(0, 2000);

    if (el.textContent?.trim() && el.textContent.trim().length > 10) {
      sections.push({ type, content, rawHtml });
    }
  }

  if (sections.length === 0) {
    sections.push({
      type: "hero",
      content: {
        title: pageTitle,
        subtitle: document.querySelector("p")?.textContent?.trim() || "",
      },
    });
  }

  const parsedSite: ParsedSite = {
    pages: [
      {
        name: pageTitle,
        slug: "home",
        sections,
      },
    ],
  };

  return { parsedSite, designSystem };
}
