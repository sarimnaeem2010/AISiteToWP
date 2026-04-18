import { useParams, Link } from "wouter";
import { useGetProject } from "@workspace/api-client-react";
import { ArrowLeft, LayoutTemplate, Type, Palette, Component, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function ProjectPreview() {
  const { id } = useParams<{ id: string }>();
  const { data: project, isLoading } = useGetProject(id || "", { query: { enabled: !!id } });

  if (isLoading || !project) {
    return <div className="p-8 text-center text-muted-foreground">Loading preview…</div>;
  }

  const parsedSite = project.parsedSite;
  const design = project.designSystem;

  if (!parsedSite) {
    return (
      <div className="p-8 text-center space-y-4">
        <h2>No parsed structure found.</h2>
        <Link href={`/projects/${id}`}>
          <Button variant="outline">Return to workspace</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-10 px-4 sm:px-6 lg:px-10 py-3 border-b border-border bg-background/85 backdrop-blur-md flex items-center gap-3">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="sm" className="h-8 -ml-2">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold truncate">Structure preview</h1>
          <p className="text-muted-foreground text-xs truncate">Review extracted pages and blocks before deploying.</p>
        </div>
        <span className="hidden sm:inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          {parsedSite.pages.length} {parsedSite.pages.length === 1 ? "page" : "pages"} · {parsedSite.pages.reduce((acc, p) => acc + p.sections.length, 0)} blocks
        </span>
      </div>

      {/* Hero summary card — at-a-glance overview before per-page detail */}
      <Card className="overflow-hidden">
        <div className="bg-hero-accent border-b border-card-border px-6 py-6 md:px-8 md:py-7">
          <div className="grid gap-6 md:grid-cols-[1fr_auto] items-start">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <Layers className="h-3 w-3" />
                Parsed structure summary
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight">
                {parsedSite.pages.length} {parsedSite.pages.length === 1 ? "page" : "pages"} ready for WordPress
              </h2>
              <p className="text-sm text-muted-foreground max-w-xl">
                {parsedSite.pages.reduce((acc, p) => acc + p.sections.length, 0)} blocks extracted across {parsedSite.pages.length} {parsedSite.pages.length === 1 ? "page" : "pages"}
                {design?.font ? ` · primary font ${design.font}` : ""}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <Badge variant="outline" className="text-xs">
                {parsedSite.pages.reduce((acc, p) => acc + p.sections.length, 0)} blocks
              </Badge>
              {design?.colors?.length ? (
                <Badge variant="outline" className="text-xs">{design.colors.length} colors</Badge>
              ) : null}
              {design?.font ? <Badge variant="outline" className="text-xs">{design.font}</Badge> : null}
            </div>
          </div>
        </div>
        <CardContent className="p-5 md:p-6 grid gap-6 md:grid-cols-2">
          <div>
            <div className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wider font-medium flex items-center gap-1.5">
              <Type className="h-3 w-3" /> Typography
            </div>
            <div className="flex items-center gap-2 bg-muted/40 border border-border rounded-md p-2.5">
              <Type className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm">{design?.font || "System default"}</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wider font-medium flex items-center gap-1.5">
              <Palette className="h-3 w-3" /> Color palette
            </div>
            <div className="flex flex-wrap gap-2">
              {design?.colors?.length ? (
                design.colors.map((color, i) => (
                  <div
                    key={i}
                    className="h-9 w-9 rounded-md border border-border shadow-xs"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))
              ) : (
                <span className="text-sm text-muted-foreground italic">None extracted</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-page cards */}
      <div className="space-y-6">
          {parsedSite.pages.map((page, pIdx) => (
            <Card key={pIdx} className="overflow-hidden">
              <div className="bg-muted/40 border-b border-border px-5 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <LayoutTemplate className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-base">{page.name}</h3>
                  <Badge variant="secondary" className="ml-1 text-xs">/{page.slug}</Badge>
                </div>
                <Badge variant="outline" className="text-xs">{page.sections.length} blocks</Badge>
              </div>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {page.sections.map((section, sIdx) => (
                    <div key={sIdx} className="p-4 hover:bg-muted/30 transition-colors flex items-start gap-4">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Component className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-semibold text-sm uppercase tracking-wider">{section.type}</span>
                        </div>
                        <div className="text-xs font-mono text-muted-foreground truncate bg-muted/40 p-2 rounded border border-border">
                          {Object.keys(section.content || {}).slice(0, 5).join(", ")}
                          {Object.keys(section.content || {}).length > 5 ? ", …" : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}
