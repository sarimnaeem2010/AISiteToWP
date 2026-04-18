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
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { useListProjects } from "@workspace/api-client-react";

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  created:    { label: "Created",    color: "bg-muted text-muted-foreground border-border", icon: Clock },
  parsed:     { label: "Parsed",     color: "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900", icon: FileCode2 },
  configured: { label: "Configured", color: "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", icon: LayoutTemplate },
  pushed:     { label: "Pushed",     color: "bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", icon: CheckCircle2 },
  error:      { label: "Error",      color: "bg-destructive/10 text-destructive border-destructive/20", icon: AlertCircle },
};

export default function ProjectsPage() {
  const { data: projects, isLoading } = useListProjects();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Every conversion project in your account.</p>
        </div>
        <Link href="/projects/new">
          <Button data-testid="button-new-project">
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </Link>
      </div>

      <Card>
        {isLoading ? (
          <div className="py-16 text-center text-muted-foreground text-sm">Loading projects…</div>
        ) : projects && projects.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="w-[300px] px-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">Project</TableHead>
                  <TableHead className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Source</TableHead>
                  <TableHead className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</TableHead>
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
                    <TableRow key={project.id} className="group hover:bg-muted/40 transition-colors" data-testid={`row-project-${project.id}`}>
                      <TableCell className="font-medium px-6">
                        <Link href={`/projects/${project.id}`} className="hover:text-primary transition-colors">
                          {project.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {project.sourceType || "—"}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${status.color}`}>
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
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
                          <Button variant="ghost" size="sm" data-testid={`button-open-${project.id}`}>
                            Open
                            <ArrowRight className="h-3.5 w-3.5" />
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
    </div>
  );
}
