import { Link } from "wouter";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  FileCode2,
  Globe,
  LayoutTemplate,
  AlertCircle,
  Clock,
  Plus,
  Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { useListProjects, useGetProjectStats } from "@workspace/api-client-react";

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  created:    { label: "Created",    color: "bg-muted text-muted-foreground border-border", icon: Clock },
  parsed:     { label: "Parsed",     color: "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900", icon: FileCode2 },
  configured: { label: "Configured", color: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", icon: LayoutTemplate },
  pushed:     { label: "Pushed",     color: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", icon: CheckCircle2 },
  error:      { label: "Error",      color: "bg-destructive/10 text-destructive border-destructive/20", icon: AlertCircle },
};

interface StatProps {
  label: string;
  value: string | number;
  icon: React.ElementType;
}

function Stat({ label, value, icon: Icon }: StatProps) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
        </div>
        <div className="mt-3 text-3xl font-bold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetProjectStats();
  const { data: projects, isLoading: projectsLoading } = useListProjects();

  const valOrDash = (n: number | undefined | null) => (statsLoading ? "—" : (n ?? 0));

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Section: Hero band */}
      <section className="relative overflow-hidden rounded-2xl border border-card-border bg-hero-accent shadow-sm">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-end p-7 md:p-9">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Sparkles className="h-3 w-3" />
              Convert HTML to Elementor in minutes
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
              Welcome back
            </h1>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              Turn AI-generated HTML, live URLs, or ZIP exports into a clean WordPress
              child theme with native Elementor widgets — no manual rebuilding.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/projects/new">
              <Button size="lg" className="shadow-md">
                <Plus className="h-4 w-4" />
                New project
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Section: Stats */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total projects"    value={valOrDash(stats?.totalProjects)}      icon={Box} />
        <Stat label="Parsed structure"  value={valOrDash(stats?.parsedProjects)}     icon={FileCode2} />
        <Stat label="Pushed to WP"      value={valOrDash(stats?.pushedProjects)}     icon={CheckCircle2} />
        <Stat label="Pages converted"   value={valOrDash(stats?.totalPagesConverted)} icon={LayoutTemplate} />
      </section>

      {/* Section: Recent projects */}
      <section>
        <Card>
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div>
              <h3 className="text-base font-semibold tracking-tight">Recent projects</h3>
              <p className="text-sm text-muted-foreground mt-0.5">Your latest HTML to WordPress conversions.</p>
            </div>
            <Link href="/projects/new">
              <Button variant="outline" size="sm">
                <Plus className="h-4 w-4" />
                New
              </Button>
            </Link>
          </div>

          {projectsLoading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">Loading projects…</div>
          ) : projects && projects.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-b border-border">
                    <TableHead className="w-[300px] px-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">Project</TableHead>
                    <TableHead className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
                    <TableHead className="text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Pages</TableHead>
                    <TableHead className="text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Target WP</TableHead>
                    <TableHead className="text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Updated</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => {
                    const status = statusConfig[project.status] || statusConfig.created;
                    const StatusIcon = status.icon;
                    return (
                      <TableRow key={project.id} className="group hover:bg-muted/40 transition-colors">
                        <TableCell className="font-medium px-6">
                          <Link href={`/projects/${project.id}`} className="hover:text-primary transition-colors">
                            {project.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${status.color}`}>
                            <StatusIcon className="h-3 w-3" />
                            {status.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                          {project.pageCount || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {project.wpUrl ? (
                            <a href={project.wpUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center justify-end gap-1.5">
                              <Globe className="h-3 w-3" />
                              {new URL(project.wpUrl).hostname}
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
                        </TableCell>
                        <TableCell className="text-right pr-4">
                          <Link href={`/projects/${project.id}`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                              <ArrowRight className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="py-16 px-6 flex flex-col items-center justify-center text-center">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4">
                <Box className="h-7 w-7" />
              </div>
              <h3 className="text-lg font-semibold tracking-tight mb-1">No projects yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm mb-5">
                Create your first conversion project to start pushing pages into WordPress.
              </p>
              <Link href="/projects/new">
                <Button>
                  <Plus className="h-4 w-4" />
                  Create your first project
                </Button>
              </Link>
            </div>
          )}
        </Card>
      </section>

      {/* Section: Onboarding nudge (always shown — short feature row) */}
      <section className="grid gap-4 md:grid-cols-3">
        {[
          { icon: FileCode2, title: "Bring any HTML", body: "Paste markup, upload a ZIP, or scrape a public URL." },
          { icon: LayoutTemplate, title: "Auto-extract structure", body: "Pages, sections, design tokens and CPTs detected automatically." },
          { icon: CheckCircle2, title: "Push to WordPress", body: "Generates a child theme + Elementor widgets you can edit natively." },
        ].map((f) => (
          <Card key={f.title}>
            <CardContent className="p-5">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary mb-3">
                <f.icon className="h-4 w-4" />
              </div>
              <h4 className="text-sm font-semibold mb-1">{f.title}</h4>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
