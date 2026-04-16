import AdmZip from "adm-zip";

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

interface DesignSystem {
  font: string;
  colors: string[];
  buttonStyle: string;
  headingStyle: string;
}

function pascal(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("") || "Section";
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSection(section: ParsedSection): string {
  const c = section.content;
  switch (section.type) {
    case "hero":
      return `<section class="hero">
  <h1>{title}</h1>
  {subtitle && <p class="subtitle">{subtitle}</p>}
  {cta && <a class="btn" href={ctaUrl ?? "#"}>{cta}</a>}
</section>`;
    case "features":
      return `<section class="features">
  {title && <h2>{title}</h2>}
  <div class="feature-grid">
    {items.map((item) => (
      <div class="feature">
        <h3>{item.title}</h3>
        <p>{item.description}</p>
      </div>
    ))}
  </div>
</section>`;
    case "pricing":
      return `<section class="pricing">
  {title && <h2>{title}</h2>}
  <div class="plan-grid">
    {plans.map((plan) => (
      <div class="plan">
        <h3>{plan.name}</h3>
        <p class="price">{plan.price}</p>
        <ul>{plan.features.map((f) => <li>{f}</li>)}</ul>
      </div>
    ))}
  </div>
</section>`;
    case "testimonials":
      return `<section class="testimonials">
  {title && <h2>{title}</h2>}
  <div class="quotes">
    {items.map((t) => (
      <blockquote>
        <p>{t.quote}</p>
        <cite>{t.author}</cite>
      </blockquote>
    ))}
  </div>
</section>`;
    case "faq":
      return `<section class="faq">
  {title && <h2>{title}</h2>}
  <dl>
    {items.map((q) => (
      <>
        <dt>{q.question}</dt>
        <dd>{q.answer}</dd>
      </>
    ))}
  </dl>
</section>`;
    case "cta":
      return `<section class="cta-banner">
  <h2>{title}</h2>
  {subtitle && <p>{subtitle}</p>}
  {cta && <a class="btn" href={ctaUrl ?? "#"}>{cta}</a>}
</section>`;
    case "footer":
      return `<footer>
  <p>{copyright}</p>
</footer>`;
    default:
      return `<section class="section-${esc(section.type)}">
  {title && <h2>{title}</h2>}
  {subtitle && <p>{subtitle}</p>}
</section>`;
  }
}

function renderComponent(section: ParsedSection, idx: number): { name: string; code: string } {
  const name = `${pascal(section.type)}${idx + 1}`;
  const c = section.content as Record<string, unknown>;

  const propsFromContent: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      propsFromContent.push(`  ${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === "string") {
      propsFromContent.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }

  const propsBlock = `const defaults = {\n${propsFromContent.join(",\n")}\n};`;

  const code = `---
interface Props {
  title?: string;
  subtitle?: string;
  cta?: string;
  ctaUrl?: string;
  items?: Array<Record<string, any>>;
  plans?: Array<{ name: string; price: string; features: string[] }>;
  copyright?: string;
}

${propsBlock}

const {
  title = defaults.title,
  subtitle = defaults.subtitle,
  cta = defaults.cta,
  ctaUrl = defaults.ctaUrl,
  items = defaults.items ?? [],
  plans = defaults.plans ?? [],
  copyright = defaults.copyright,
} = Astro.props;
---
${renderSection(section)}
`;

  return { name, code };
}

function renderPage(page: ParsedPage, components: { name: string; section: ParsedSection }[]): string {
  const imports = components.map((c) => `import ${c.name} from "../components/${c.name}.astro";`).join("\n");
  const uses = components.map((c) => `<${c.name} />`).join("\n  ");
  return `---
import Layout from "../layouts/Layout.astro";
${imports}
---
<Layout title="${esc(page.name)}">
  ${uses}
</Layout>
`;
}

const LAYOUT_CODE = `---
interface Props {
  title: string;
}
const { title } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <link rel="stylesheet" href="/styles/global.css" />
  </head>
  <body>
    <slot />
  </body>
</html>
`;

function buildGlobalCss(ds: DesignSystem | null): string {
  const font = ds?.font ?? "Inter, system-ui, sans-serif";
  const primary = ds?.colors?.[0] ?? "#3b82f6";
  return `:root { --font: ${font}; --primary: ${primary}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font); color: #0f172a; background: #f8fafc; }
section { padding: 4rem 1.5rem; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 2.75rem; margin: 0 0 1rem; }
h2 { font-size: 2rem; margin: 0 0 1rem; }
h3 { margin: 0 0 .5rem; }
.btn { display: inline-block; padding: .75rem 1.25rem; background: var(--primary); color: #fff; text-decoration: none; border-radius: .5rem; }
.feature-grid, .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; }
.feature, .plan { padding: 1.5rem; background: #fff; border: 1px solid #e2e8f0; border-radius: .75rem; }
blockquote { margin: 0; padding: 1.5rem; background: #fff; border-left: 4px solid var(--primary); }
dl dt { font-weight: 600; margin-top: 1rem; }
footer { padding: 2rem; text-align: center; color: #64748b; border-top: 1px solid #e2e8f0; }
`;
}

const WP_LIB = `// Fetch content from WordPress REST API
const WP_URL = import.meta.env.PUBLIC_WP_URL ?? "";

export interface WpPage {
  id: number;
  title: { rendered: string };
  slug: string;
  content: { rendered: string };
  acf?: Record<string, unknown>;
}

export async function getPage(slug: string): Promise<WpPage | null> {
  if (!WP_URL) return null;
  const res = await fetch(\`\${WP_URL}/wp-json/wp/v2/pages?slug=\${slug}&_embed=1\`);
  if (!res.ok) return null;
  const pages = (await res.json()) as WpPage[];
  return pages[0] ?? null;
}

export async function getAllPages(): Promise<WpPage[]> {
  if (!WP_URL) return [];
  const res = await fetch(\`\${WP_URL}/wp-json/wp/v2/pages?per_page=100\`);
  if (!res.ok) return [];
  return (await res.json()) as WpPage[];
}
`;

const ASTRO_CONFIG = `import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
});
`;

const PKG_JSON = (name: string) =>
  JSON.stringify(
    {
      name: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "astro dev",
        build: "astro build",
        preview: "astro preview",
      },
      dependencies: {
        astro: "^5.0.0",
      },
    },
    null,
    2
  );

const README = (name: string) => `# ${name}

Generated by **WP Bridge AI** — AI-converted site with Astro + WordPress CMS integration.

## Setup

\`\`\`bash
npm install
npm run dev
\`\`\`

## Connect to WordPress

Set \`PUBLIC_WP_URL\` in \`.env\`:

\`\`\`
PUBLIC_WP_URL=https://your-wp-site.com
\`\`\`

Content in \`src/components\` is static-seeded from the original upload but can be replaced with calls to \`src/lib/wp.ts\` (\`getPage(slug)\`) for dynamic CMS content.
`;

export function generateAstroProject(
  siteName: string,
  parsedSite: ParsedSite,
  designSystem: DesignSystem | null
): Buffer {
  const zip = new AdmZip();
  const slug = siteName.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "astro-site";

  zip.addFile("package.json", Buffer.from(PKG_JSON(slug)));
  zip.addFile("astro.config.mjs", Buffer.from(ASTRO_CONFIG));
  zip.addFile("README.md", Buffer.from(README(siteName)));
  zip.addFile(".env.example", Buffer.from("PUBLIC_WP_URL=https://your-wp-site.com\n"));
  zip.addFile("src/layouts/Layout.astro", Buffer.from(LAYOUT_CODE));
  zip.addFile("src/styles/global.css", Buffer.from(buildGlobalCss(designSystem)));
  zip.addFile("public/styles/global.css", Buffer.from(buildGlobalCss(designSystem)));
  zip.addFile("src/lib/wp.ts", Buffer.from(WP_LIB));

  for (const page of parsedSite.pages) {
    const components = page.sections.map((s, i) => {
      const c = renderComponent(s, i);
      zip.addFile(`src/components/${c.name}.astro`, Buffer.from(c.code));
      return { name: c.name, section: s };
    });
    const pageCode = renderPage(page, components);
    const routeName = page.slug === "home" ? "index" : page.slug;
    zip.addFile(`src/pages/${routeName}.astro`, Buffer.from(pageCode));
  }

  const mapping = {
    siteName,
    pages: parsedSite.pages.map((p) => ({
      slug: p.slug,
      name: p.name,
      sectionTypes: p.sections.map((s) => s.type),
    })),
    designSystem,
  };
  zip.addFile("mapping.json", Buffer.from(JSON.stringify(mapping, null, 2)));

  return zip.toBuffer();
}
