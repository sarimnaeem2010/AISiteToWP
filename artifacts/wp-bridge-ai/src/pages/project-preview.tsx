import { useParams, Link } from "wouter";
import { useGetProject } from "@workspace/api-client-react";
import { ArrowLeft, LayoutTemplate, Type, Palette, Component } from "lucide-react";
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
    <div className="max-w-6xl mx-auto space-y-8 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl">Structure preview</h1>
          <p className="text-muted-foreground text-sm">Review extracted pages and blocks before deploying.</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        {/* Sidebar: Design system */}
        <div className="md:col-span-1 space-y-6">
          <Card>
            <CardHeader className="border-b border-border py-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" />
                Design system
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-5">
              {design ? (
                <>
                  <div>
                    <div className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wider font-medium">Typography</div>
                    <div className="flex items-center gap-2 bg-muted/40 border border-border rounded-md p-2.5">
                      <Type className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{design.font || "System default"}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-muted-foreground mb-2 uppercase tracking-wider font-medium">Colors</div>
                    <div className="flex flex-wrap gap-2">
                      {design.colors?.map((color, i) => (
                        <div
                          key={i}
                          className="h-9 w-9 rounded-md border border-border shadow-xs"
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      )) || <span className="text-sm text-muted-foreground italic">None extracted</span>}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground italic">No design system extracted.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Main: Pages */}
        <div className="md:col-span-3 space-y-6">
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
    </div>
  );
}
