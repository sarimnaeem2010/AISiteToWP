interface ParsedSection {
  type: string;
  content: Record<string, unknown>;
  rawHtml?: string;
  semanticType?: string;
  confidence?: number;
  source?: "ai" | "heuristic";
}

interface ParsedPage {
  name: string;
  slug: string;
  sections: ParsedSection[];
}

interface ParsedSite {
  pages: ParsedPage[];
}

export interface CustomPostTypeDef {
  slug: string;
  label: string;
  pluralLabel: string;
  sourceSemanticType: string;
  fields: string[];
  enabled: boolean;
}

export interface CptItem {
  cptSlug: string;
  title: string;
  fields: Record<string, unknown>;
}

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

export interface WpStructure {
  pages: WpPage[];
  cptItems: CptItem[];
}

function asArray<T = Record<string, unknown>>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function pickTitle(item: Record<string, unknown>, fallback: string): string {
  return String(
    item.title ||
      item.name ||
      item.plan_name ||
      item.author_name ||
      item.question ||
      item.headline ||
      fallback,
  ).slice(0, 200);
}

function mapSectionToBlock(section: ParsedSection): WpBlock {
  const { content } = section;
  const type = section.semanticType || section.type;
  const items = asArray(content.items);

  switch (type) {
    case "hero":
    case "header":
      return {
        blockType: "core/cover",
        acfGroup: "hero_section",
        fields: {
          headline: content.title || content.headline || "",
          subheadline: content.subtitle || content.subheadline || "",
          cta_text: content.cta || content.cta_text || "",
          cta_url: content.cta_url || "",
          background_image: content.image_url || content.background_image || "",
        },
      };

    case "features":
    case "services":
      return {
        blockType: "core/columns",
        acfGroup: type === "services" ? "services_section" : "features_section",
        fields: {
          section_title: content.title || (type === "services" ? "Services" : "Features"),
          section_subtitle: content.subtitle || "",
        },
        innerBlocks: items.map((item) => ({
          blockType: "core/column",
          acfGroup: type === "services" ? "service_item" : "feature_item",
          fields: {
            title: item.title || item.name || "",
            description: item.description || "",
            icon: item.icon || "",
            image: item.image_url || item.image || "",
          },
        })),
      };

    case "about":
      return {
        blockType: "core/group",
        acfGroup: "about_section",
        fields: {
          heading: content.title || "About Us",
          body: content.description || content.subtitle || content.body || "",
          image: (asArray<{ src: string }>(content.images))[0]?.src || content.image_url || "",
        },
      };

    case "testimonials":
      return {
        blockType: "core/group",
        acfGroup: "testimonials_section",
        fields: { section_title: content.title || "What Our Clients Say" },
        innerBlocks: items.map((item) => ({
          blockType: "acf/testimonial-item",
          acfGroup: "testimonial_item",
          fields: {
            quote: item.quote || item.content || "",
            author_name: item.author_name || item.author || item.name || "",
            author_role: item.author_role || item.role || "",
            author_image: item.author_image || item.image_url || "",
          },
        })),
      };

    case "team":
      return {
        blockType: "core/group",
        acfGroup: "team_section",
        fields: { section_title: content.title || "Our Team", section_subtitle: content.subtitle || "" },
        innerBlocks: items.map((item) => ({
          blockType: "acf/team-member",
          acfGroup: "team_member",
          fields: {
            name: item.name || item.title || "",
            role: item.role || item.title_role || "",
            bio: item.bio || item.description || "",
            image: item.image_url || item.image || "",
          },
        })),
      };

    case "pricing":
      return {
        blockType: "core/group",
        acfGroup: "pricing_section",
        fields: {
          section_title: content.title || "Pricing",
          section_subtitle: content.subtitle || "",
        },
        innerBlocks: asArray(content.plans || content.items).map((plan) => ({
          blockType: "acf/pricing-plan",
          acfGroup: "pricing_plan",
          fields: {
            plan_name: plan.name || plan.plan_name || "",
            plan_price: plan.price || plan.plan_price || "",
            plan_features: plan.features || plan.plan_features || [],
            cta_text: plan.cta_text || "Get Started",
            cta_url: plan.cta_url || "",
          },
        })),
      };

    case "faq":
      return {
        blockType: "core/group",
        acfGroup: "faq_section",
        fields: { section_title: content.title || "Frequently Asked Questions" },
        innerBlocks: items.map((item) => ({
          blockType: "acf/faq-item",
          acfGroup: "faq_item",
          fields: { question: item.question || "", answer: item.answer || "" },
        })),
      };

    case "stats":
      return {
        blockType: "core/group",
        acfGroup: "stats_section",
        fields: { section_title: content.title || "" },
        innerBlocks: items.map((item) => ({
          blockType: "core/column",
          acfGroup: "stat_item",
          fields: {
            value: item.value || item.number || "",
            label: item.label || item.title || "",
          },
        })),
      };

    case "logos":
      return {
        blockType: "core/gallery",
        acfGroup: "logos_section",
        fields: {
          section_title: content.title || "Trusted by",
          logos: items.length ? items : asArray(content.images),
        },
      };

    case "cta":
      return {
        blockType: "core/group",
        acfGroup: "cta_section",
        fields: {
          heading: content.title || content.headline || "",
          subheading: content.subtitle || content.subheadline || "",
          button_text: content.cta || content.cta_text || "Get Started",
          button_url: content.cta_url || "",
          button_secondary_text: content.ctaSecondary || content.cta_secondary || "",
        },
      };

    case "gallery":
      return {
        blockType: "core/gallery",
        acfGroup: "gallery_section",
        fields: {
          section_title: content.title || "",
          images: content.images || items,
        },
      };

    case "newsletter":
      return {
        blockType: "core/group",
        acfGroup: "newsletter_section",
        fields: {
          heading: content.title || "Subscribe",
          subheading: content.subtitle || "",
          button_text: content.cta || content.cta_text || "Subscribe",
        },
      };

    case "contact":
      return {
        blockType: "core/group",
        acfGroup: "contact_section",
        fields: {
          heading: content.title || "Contact Us",
          subheading: content.subtitle || "",
          email: content.email || "",
          phone: content.phone || "",
          address: content.address || "",
          form_fields: content.form_fields || ["name", "email", "message"],
        },
      };

    case "blog":
      return {
        blockType: "core/query",
        acfGroup: "blog_section",
        fields: {
          section_title: content.title || "Latest Posts",
          posts_per_page: content.posts_per_page ?? 3,
        },
      };

    case "footer":
      return {
        blockType: "core/group",
        acfGroup: "footer_section",
        fields: {
          copyright_text: content.copyright || content.title || "",
          links: content.links || content.cta || "",
        },
      };

    default:
      return {
        blockType: "core/html",
        acfGroup: null,
        fields: {
          content: section.rawHtml || "",
          section_title: content.title || "",
          section_body: content.subtitle || content.description || "",
        },
      };
  }
}

/**
 * Extract CPT items from sections whose semanticType matches an enabled CPT.
 * Returns items and a list of section indices (per page) that were promoted to CPTs
 * so the caller can omit them from the page block list.
 */
function extractCptItems(
  parsedSite: ParsedSite,
  cpts: CustomPostTypeDef[],
): { items: CptItem[]; promotedSections: Set<string> } {
  const items: CptItem[] = [];
  const promotedSections = new Set<string>();
  const enabled = cpts.filter((c) => c.enabled);
  if (enabled.length === 0) return { items, promotedSections };

  const bySource = new Map(enabled.map((c) => [c.sourceSemanticType, c]));

  parsedSite.pages.forEach((page, pageIdx) => {
    page.sections.forEach((section, secIdx) => {
      const semantic = section.semanticType || section.type;
      const cpt = bySource.get(semantic);
      if (!cpt) return;
      const sectionItems = asArray(section.content.items);
      if (sectionItems.length === 0) return;
      for (const it of sectionItems) {
        items.push({
          cptSlug: cpt.slug,
          title: pickTitle(it, cpt.label),
          fields: it,
        });
      }
      promotedSections.add(`${pageIdx}:${secIdx}`);
    });
  });

  return { items, promotedSections };
}

export function mapToWordPress(
  parsedSite: ParsedSite,
  customPostTypes: CustomPostTypeDef[] = [],
): WpStructure {
  const { items: cptItems, promotedSections } = extractCptItems(parsedSite, customPostTypes);

  const pages: WpPage[] = parsedSite.pages.map((page, pageIdx) => ({
    title: page.name,
    slug: page.slug,
    blocks: page.sections
      .map((section, secIdx) => ({ section, key: `${pageIdx}:${secIdx}` }))
      .filter(({ key }) => !promotedSections.has(key))
      .map(({ section }) => mapSectionToBlock(section)),
  }));

  return { pages, cptItems };
}
