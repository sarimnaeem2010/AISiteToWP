interface ParsedSection {
  type: string;
  content: Record<string, unknown>;
  rawHtml?: string;
}

interface ParsedPage {
  name: string;
  slug: string;
  sections: ParsedSection[];
}

interface ParsedSite {
  pages: ParsedPage[];
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

interface WpStructure {
  pages: WpPage[];
}

function mapSectionToBlock(section: ParsedSection): WpBlock {
  const { type, content } = section;

  switch (type) {
    case "hero":
      return {
        blockType: "core/cover",
        acfGroup: "hero_section",
        fields: {
          headline: content.title || "",
          subheadline: content.subtitle || "",
          cta_text: content.cta || "",
          cta_url: "",
          background_image: "",
        },
      };

    case "features":
      return {
        blockType: "core/columns",
        acfGroup: "features_section",
        fields: {
          section_title: content.title || "Features",
          section_subtitle: content.subtitle || "",
        },
        innerBlocks: ((content.items as Array<{ title: string; description: string }>) || []).map((item) => ({
          blockType: "core/column",
          acfGroup: "feature_item",
          fields: {
            title: item.title,
            description: item.description,
            icon: "",
          },
        })),
      };

    case "about":
      return {
        blockType: "core/group",
        acfGroup: "about_section",
        fields: {
          heading: content.title || "About Us",
          body: content.description || content.subtitle || "",
          image: (content.images as Array<{ src: string }>)?.[0]?.src || "",
        },
      };

    case "testimonials":
      return {
        blockType: "core/group",
        acfGroup: "testimonials_section",
        fields: {
          section_title: content.title || "What Our Clients Say",
        },
        innerBlocks: ((content.items as Array<{ quote: string; author: string }>) || []).map((item) => ({
          blockType: "acf/testimonial-item",
          acfGroup: "testimonial_item",
          fields: {
            quote: item.quote,
            author_name: item.author,
            author_image: "",
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
        innerBlocks: ((content.plans as Array<{ name: string; price: string; features: string[] }>) || []).map((plan) => ({
          blockType: "acf/pricing-plan",
          acfGroup: "pricing_plan",
          fields: {
            plan_name: plan.name,
            plan_price: plan.price,
            plan_features: plan.features,
            cta_text: "Get Started",
            cta_url: "",
          },
        })),
      };

    case "faq":
      return {
        blockType: "core/group",
        acfGroup: "faq_section",
        fields: {
          section_title: content.title || "Frequently Asked Questions",
        },
        innerBlocks: ((content.items as Array<{ question: string; answer: string }>) || []).map((item) => ({
          blockType: "acf/faq-item",
          acfGroup: "faq_item",
          fields: {
            question: item.question,
            answer: item.answer,
          },
        })),
      };

    case "cta":
      return {
        blockType: "core/group",
        acfGroup: "cta_section",
        fields: {
          heading: content.title || "",
          subheading: content.subtitle || "",
          button_text: content.cta || "Get Started",
          button_url: "",
          button_secondary_text: content.ctaSecondary || "",
        },
      };

    case "gallery":
      return {
        blockType: "core/gallery",
        acfGroup: "gallery_section",
        fields: {
          section_title: content.title || "",
          images: content.images || [],
        },
      };

    case "contact":
      return {
        blockType: "core/group",
        acfGroup: "contact_section",
        fields: {
          heading: content.title || "Contact Us",
          subheading: content.subtitle || "",
          form_fields: ["name", "email", "message"],
        },
      };

    case "blog":
      return {
        blockType: "core/query",
        acfGroup: "blog_section",
        fields: {
          section_title: content.title || "Latest Posts",
          posts_per_page: 3,
        },
      };

    case "footer":
      return {
        blockType: "core/group",
        acfGroup: "footer_section",
        fields: {
          copyright_text: content.title || "",
          links: content.cta || "",
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

export function mapToWordPress(parsedSite: ParsedSite): WpStructure {
  const pages: WpPage[] = parsedSite.pages.map((page) => ({
    title: page.name,
    slug: page.slug,
    blocks: page.sections.map(mapSectionToBlock),
  }));

  return { pages };
}
