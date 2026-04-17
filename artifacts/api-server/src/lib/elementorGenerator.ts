import { randomBytes } from "crypto";

interface WpBlock {
  blockType: string;
  acfGroup?: string | null;
  fields: Record<string, unknown>;
  innerBlocks?: Record<string, unknown>[];
}

interface WpPage {
  title: string;
  slug: string;
  blocks: WpBlock[];
}

interface ElementorElement {
  id: string;
  elType: "section" | "column" | "widget";
  settings: Record<string, unknown>;
  elements: ElementorElement[];
  widgetType?: string;
}

function eid(): string {
  return randomBytes(4).toString("hex");
}

function section(elements: ElementorElement[], settings: Record<string, unknown> = {}): ElementorElement {
  return {
    id: eid(),
    elType: "section",
    settings: { structure: "10", ...settings },
    elements: [{ id: eid(), elType: "column", settings: { _column_size: 100 }, elements }],
  };
}

function widget(widgetType: string, settings: Record<string, unknown>): ElementorElement {
  return {
    id: eid(),
    elType: "widget",
    widgetType,
    settings,
    elements: [],
  };
}

function blockToElementor(block: WpBlock): ElementorElement[] {
  const f = block.fields;
  switch (block.blockType) {
    case "core/cover": {
      const widgets: ElementorElement[] = [];
      if (f.headline) widgets.push(widget("heading", { title: String(f.headline), size: "xl", header_size: "h1" }));
      if (f.subheadline) widgets.push(widget("text-editor", { editor: `<p>${String(f.subheadline)}</p>` }));
      if (f.cta_text) widgets.push(widget("button", { text: String(f.cta_text), link: { url: String(f.cta_url || "#") } }));
      const settings: Record<string, unknown> = { layout: "boxed" };
      if (f.background_image) settings.background_background = "classic";
      return [section(widgets, settings)];
    }
    case "core/columns":
    case "core/group": {
      const inner: ElementorElement[] = [];
      if (f.section_title || f.heading) inner.push(widget("heading", { title: String(f.section_title || f.heading), header_size: "h2" }));
      if (f.section_subtitle || f.subheading || f.body) inner.push(widget("text-editor", { editor: `<p>${String(f.section_subtitle || f.subheading || f.body)}</p>` }));
      const innerBlocks = (block.innerBlocks ?? []) as unknown as WpBlock[];
      if (innerBlocks.length > 0) {
        const columnCount = Math.max(1, Math.min(innerBlocks.length, 4));
        const columnSize = Math.floor(100 / columnCount);
        const columns: ElementorElement[] = innerBlocks.map((ib) => {
          const colWidgets: ElementorElement[] = [];
          const ibf = ib.fields;
          if (ibf.title) colWidgets.push(widget("heading", { title: String(ibf.title), header_size: "h3" }));
          if (ibf.description) colWidgets.push(widget("text-editor", { editor: `<p>${String(ibf.description)}</p>` }));
          if (ibf.quote) colWidgets.push(widget("testimonial", { testimonial_content: String(ibf.quote), testimonial_name: String(ibf.author_name || "") }));
          if (ibf.question) colWidgets.push(widget("toggle", { tabs: [{ tab_title: String(ibf.question), tab_content: String(ibf.answer || "") }] }));
          return {
            id: eid(),
            elType: "column",
            settings: { _column_size: columnSize },
            elements: colWidgets,
          };
        });
        const sections: ElementorElement[] = [];
        if (inner.length > 0) {
          sections.push({
            id: eid(),
            elType: "section",
            settings: { structure: "10" },
            elements: [{ id: eid(), elType: "column", settings: { _column_size: 100 }, elements: inner }],
          });
        }
        sections.push({
          id: eid(),
          elType: "section",
          settings: { structure: `${innerBlocks.length}0` },
          elements: columns,
        });
        return sections;
      }
      return [section(inner)];
    }
    case "core/gallery": {
      return [section([widget("image-gallery", { gallery: f.images ?? [] })])];
    }
    case "core/query": {
      return [section([widget("posts", { posts_per_page: f.posts_per_page ?? 3 })])];
    }
    case "core/html":
    default: {
      const html = String(f.content || f.section_body || f.section_title || "");
      return [section([widget("html", { html })])];
    }
  }
}

export function pageToElementorData(page: WpPage): ElementorElement[] {
  const out: ElementorElement[] = [];
  for (const block of page.blocks) {
    out.push(...blockToElementor(block));
  }
  return out;
}
