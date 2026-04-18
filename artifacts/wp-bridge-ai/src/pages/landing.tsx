import { Link } from "wouter";
import { useState } from "react";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  LayoutTemplate,
  Palette,
  Plug,
  Rocket,
  Send,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const SIGNIN_HREF = "/login";
const SIGNUP_HREF = "/signup";

function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const navLinks = [
    { label: "Features", href: "#features" },
    { label: "How it works", href: "#how" },
    { label: "FAQ", href: "#faq" },
  ];

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Zap className="h-4 w-4 fill-current" />
          </span>
          <span className="text-base font-semibold tracking-tight">WP Bridge AI</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link href={SIGNIN_HREF}>
            <Button variant="ghost" size="sm">Sign in</Button>
          </Link>
          <Link href={SIGNUP_HREF}>
            <Button size="sm">Get started</Button>
          </Link>
        </div>

        <button
          aria-label="Toggle menu"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground md:hidden"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-background md:hidden">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </a>
            ))}
            <div className="mt-2 flex gap-2 px-1">
              <Link href={SIGNIN_HREF} className="flex-1">
                <Button variant="outline" size="sm" className="w-full">Sign in</Button>
              </Link>
              <Link href={SIGNUP_HREF} className="flex-1">
                <Button size="sm" className="w-full">Get started</Button>
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-hero-accent">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="py-20 md:py-28 lg:py-32 text-center">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <Rocket className="h-3 w-3" />
            HTML &amp; URL → editable WordPress, in minutes
          </div>
          <h1 className="mt-5 mx-auto max-w-3xl text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight">
            Turn any HTML into a real Elementor WordPress site.
          </h1>
          <p className="mt-5 mx-auto max-w-2xl text-base md:text-lg leading-relaxed text-muted-foreground">
            WP Bridge AI uses semantic analysis to convert AI-generated HTML, live URLs, or ZIP exports into a clean child theme with native Elementor widgets — fully editable, no manual rebuilding.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href={SIGNUP_HREF}>
              <Button size="lg" className="shadow-md">
                Get started
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href={SIGNIN_HREF}>
              <Button size="lg" variant="outline">Sign in</Button>
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">No credit card required · Beta</p>

          <div className="mt-14 md:mt-16">
            <ProductPreview />
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductPreview() {
  return (
    <div className="relative mx-auto max-w-5xl">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-8 -inset-y-6 -z-10 rounded-[2rem] bg-gradient-to-b from-primary/10 to-transparent blur-2xl"
      />
      <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-400/80" />
          <div className="ml-3 hidden flex-1 items-center justify-center sm:flex">
            <div className="inline-flex max-w-sm items-center gap-2 truncate rounded-md border border-border bg-background px-3 py-1 text-[11px] font-medium text-muted-foreground">
              <Plug className="h-3 w-3" />
              app.wpbridge.ai/projects/landing-v2
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-0 md:grid-cols-12">
          <aside className="hidden border-r border-border bg-muted/20 p-4 md:col-span-3 md:block">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Project</div>
            <div className="mt-2 flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
              <FileCode2 className="h-3.5 w-3.5" />
              landing-v2.html
            </div>
            <div className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Detected sections</div>
            <ul className="mt-2 space-y-1.5 text-xs text-foreground/80">
              {[
                { label: "Hero", icon: LayoutTemplate },
                { label: "Features", icon: Brain },
                { label: "Pricing", icon: Palette },
                { label: "FAQ", icon: CheckCircle2 },
                { label: "Footer", icon: Send },
              ].map((s) => (
                <li key={s.label} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                  <s.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {s.label}
                </li>
              ))}
            </ul>
          </aside>

          <div className="md:col-span-9">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  Parsed
                </span>
                <span className="text-xs text-muted-foreground">12 widgets · 4 tokens</span>
              </div>
              <div className="hidden items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground sm:inline-flex">
                <Send className="h-3 w-3" />
                Push to WordPress
              </div>
            </div>

            <div className="space-y-3 p-5">
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">Hero · Elementor section</span>
                  <span className="text-[10px] font-mono text-muted-foreground">section-01</span>
                </div>
                <div className="mt-3 h-3 w-2/3 rounded bg-foreground/80" />
                <div className="mt-2 h-2 w-1/2 rounded bg-muted-foreground/40" />
                <div className="mt-4 flex gap-2">
                  <div className="h-6 w-20 rounded-md bg-primary" />
                  <div className="h-6 w-20 rounded-md border border-border" />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="rounded-lg border border-card-border bg-background p-3">
                    <div className="h-6 w-6 rounded-md bg-primary/15" />
                    <div className="mt-2 h-2 w-3/4 rounded bg-foreground/70" />
                    <div className="mt-1.5 h-1.5 w-full rounded bg-muted-foreground/30" />
                    <div className="mt-1 h-1.5 w-5/6 rounded bg-muted-foreground/30" />
                  </div>
                ))}
              </div>

              <div className="hidden items-center gap-3 rounded-lg border border-card-border bg-background p-3 sm:flex">
                <Palette className="h-4 w-4 text-muted-foreground" />
                <div className="flex items-center gap-1.5">
                  {["bg-primary", "bg-foreground", "bg-muted-foreground/60", "bg-primary/40"].map((c) => (
                    <span key={c} className={`h-4 w-4 rounded-full border border-border ${c}`} />
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">Design tokens extracted</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      icon: FileCode2,
      title: "Upload your HTML",
      body: "Paste markup, drop in a ZIP export, or point us at a live URL. We handle the rest.",
    },
    {
      n: "02",
      icon: Brain,
      title: "AI structures it",
      body: "Semantic analysis detects pages, sections, design tokens and reusable components automatically.",
    },
    {
      n: "03",
      icon: Send,
      title: "Push to WordPress",
      body: "One click ships a child theme + native Elementor widgets you can edit like any normal site.",
    },
  ];

  return (
    <section id="how" className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-20 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-3 text-muted-foreground">From raw HTML to a live, editable WordPress site in three steps.</p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="relative rounded-2xl border border-card-border bg-card p-6 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="text-xs font-mono font-semibold text-muted-foreground">{s.n}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    { icon: Brain, title: "AI semantic analysis", body: "Understands layout intent, not just tags. Hero, features, footer — all detected." },
    { icon: Palette, title: "Design tokens", body: "Colors, typography, and spacing extracted into reusable global tokens." },
    { icon: LayoutTemplate, title: "Elementor-native output", body: "Real Elementor widgets, not freezing screenshots in an HTML block." },
    { icon: Plug, title: "Companion plugin", body: "A lightweight WP plugin handles the import and keeps content in sync." },
    { icon: CheckCircle2, title: "Pixel-perfect", body: "What you see in the source is what lands in WordPress — typography, spacing, layout." },
    { icon: Send, title: "One-click push", body: "Send a project to your WordPress site directly from the dashboard." },
  ];

  return (
    <section id="features" className="border-t border-border bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-20 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">Built for clean, editable output</h2>
          <p className="mt-3 text-muted-foreground">
            Not a screenshot. Not an iframe. A real WordPress site you can hand to a client.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-card-border bg-card p-6 shadow-sm"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="h-4 w-4" />
              </span>
              <h3 className="mt-4 text-base font-semibold tracking-tight">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  const items = [
    {
      q: "What can I feed into WP Bridge AI?",
      a: "AI-generated HTML, a ZIP export of a static site, or a live public URL. We parse all three into the same internal structure.",
    },
    {
      q: "Is the WordPress output really editable?",
      a: "Yes. Output uses native Elementor widgets and a child theme — anyone familiar with Elementor can keep editing the site as normal.",
    },
    {
      q: "Do I need to install anything in WordPress?",
      a: "Just our small companion plugin. It receives the push from your project and writes pages, templates and tokens into your site.",
    },
    {
      q: "Can I tweak the AI's structural decisions?",
      a: "Yes. After parsing, you can review detected sections, design tokens and content types in the workspace before pushing.",
    },
    {
      q: "Is it free?",
      a: "WP Bridge AI is in beta and currently free to try. Pricing will be announced ahead of general availability.",
    },
  ];

  return (
    <section id="faq" className="border-t border-border bg-background">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-20 md:py-24">
        <div className="text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">Frequently asked</h2>
          <p className="mt-3 text-muted-foreground">Short answers to the questions we hear most.</p>
        </div>

        <div className="mt-10 divide-y divide-border rounded-2xl border border-card-border bg-card shadow-sm">
          {items.map((item, i) => (
            <details key={i} className="group px-6 py-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <span className="text-sm md:text-base font-medium text-foreground">{item.q}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Zap className="h-3.5 w-3.5 fill-current" />
            </span>
            <span className="text-sm font-semibold tracking-tight">WP Bridge AI</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#faq" className="hover:text-foreground">FAQ</a>
            <Link href={SIGNIN_HREF} className="hover:text-foreground">Sign in</Link>
          </div>
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} WP Bridge AI</p>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <FAQ />
      </main>
      <Footer />
    </div>
  );
}
