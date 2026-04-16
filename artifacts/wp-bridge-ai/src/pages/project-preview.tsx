import { useParams, Link } from "wouter";
import { useGetProject } from "@workspace/api-client-react";
import { ArrowLeft, LayoutTemplate, Type, Palette, Component, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export default function ProjectPreview() {
  const { id } = useParams<{ id: string }>();
  const { data: project, isLoading } = useGetProject(id || "", { query: { enabled: !!id } });

  if (isLoading || !project) {
    return <div className="p-8 text-center font-mono text-muted-foreground">Loading preview...</div>;
  }

  const parsedSite = project.parsedSite;
  const design = project.designSystem;

  if (!parsedSite) {
    return (
      <div className="p-8 text-center space-y-4">
        <h2 className="text-xl font-mono">No parsed structure found.</h2>
        <Link href={`/projects/${id}`}>
          <Button variant="outline" className="font-mono">Return to Workspace</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-4 mb-8">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono">Structure Preview</h1>
          <p className="text-muted-foreground text-sm">Review extracted pages and blocks before deploying.</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-4">
        {/* Sidebar: Design System */}
        <div className="md:col-span-1 space-y-6">
          <Card className="bg-muted/10 border-dashed">
            <CardHeader className="py-4 border-b bg-card">
              <CardTitle className="text-sm font-mono flex items-center gap-2">
                <Palette className="h-4 w-4" />
                Design System
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-6">
              {design ? (
                <>
                  <div>
                    <div className="text-xs font-mono text-muted-foreground mb-2 uppercase tracking-wider">Typography</div>
                    <div className="flex items-center gap-2 bg-background border rounded-md p-2">
                      <Type className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{design.font || "System Default"}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-mono text-muted-foreground mb-2 uppercase tracking-wider">Colors</div>
                    <div className="flex flex-wrap gap-2">
                      {design.colors?.map((color, i) => (
                        <div 
                          key={i} 
                          className="h-8 w-8 rounded-md border shadow-sm ring-1 ring-border/50 ring-offset-1" 
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

        {/* Main Content: Pages */}
        <div className="md:col-span-3 space-y-6">
          {parsedSite.pages.map((page, pIdx) => (
            <Card key={pIdx} className="overflow-hidden shadow-sm">
              <div className="bg-muted/40 border-b px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <LayoutTemplate className="h-4 w-4 text-primary" />
                  <h3 className="font-mono font-bold text-lg">{page.name}</h3>
                  <Badge variant="secondary" className="ml-2 font-mono text-xs">/{page.slug}</Badge>
                </div>
                <Badge variant="outline" className="font-mono">{page.sections.length} blocks</Badge>
              </div>
              <CardContent className="p-0">
                <div className="divide-y">
                  {page.sections.map((section, sIdx) => (
                    <div key={sIdx} className="p-4 hover:bg-muted/10 transition-colors flex items-start gap-4">
                      <div className="h-8 w-8 rounded bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Component className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-mono font-semibold text-sm uppercase tracking-wider">{section.type}</span>
                        </div>
                        <div className="text-xs font-mono text-muted-foreground truncate bg-muted/30 p-2 rounded border">
                          {Object.keys(section.content || {}).slice(0, 5).join(", ")}
                          {Object.keys(section.content || {}).length > 5 ? ", ..." : ""}
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
