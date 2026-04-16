import { Link } from "wouter";
import { ArrowRight, Box, CheckCircle2, FileCode2, Globe, LayoutTemplate, AlertCircle, Clock, Plus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { useListProjects, useGetProjectStats } from "@workspace/api-client-react";

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  created: { label: "Created", color: "bg-muted text-muted-foreground", icon: Clock },
  parsed: { label: "Parsed", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", icon: FileCode2 },
  configured: { label: "Configured", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400", icon: LayoutTemplate },
  pushed: { label: "Pushed", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400", icon: CheckCircle2 },
  error: { label: "Error", color: "bg-destructive/10 text-destructive dark:bg-destructive/20", icon: AlertCircle },
};

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetProjectStats();
  const { data: projects, isLoading: projectsLoading } = useListProjects();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground font-mono">Overview</h1>
          <p className="text-muted-foreground mt-1">Pipeline status and recent conversion projects.</p>
        </div>
        <Link href="/projects/new">
          <Button className="font-mono shadow-sm">
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="shadow-xs border-muted/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium font-mono">Total Projects</CardTitle>
            <Box className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statsLoading ? "-" : stats?.totalProjects || 0}</div>
          </CardContent>
        </Card>
        <Card className="shadow-xs border-muted/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium font-mono">Parsed Structure</CardTitle>
            <FileCode2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statsLoading ? "-" : stats?.parsedProjects || 0}</div>
          </CardContent>
        </Card>
        <Card className="shadow-xs border-muted/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium font-mono">Pushed to WP</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statsLoading ? "-" : stats?.pushedProjects || 0}</div>
          </CardContent>
        </Card>
        <Card className="shadow-xs border-muted/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium font-mono">Pages Converted</CardTitle>
            <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statsLoading ? "-" : stats?.totalPagesConverted || 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-xs border-muted/50">
        <CardHeader>
          <CardTitle className="font-mono">Recent Projects</CardTitle>
          <CardDescription>Your latest HTML to WordPress conversions.</CardDescription>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm font-mono">Loading projects...</div>
          ) : projects && projects.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-[300px] font-mono">Project Name</TableHead>
                    <TableHead className="font-mono">Status</TableHead>
                    <TableHead className="font-mono text-right">Pages</TableHead>
                    <TableHead className="font-mono text-right">Target WP</TableHead>
                    <TableHead className="font-mono text-right">Updated</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => {
                    const status = statusConfig[project.status] || statusConfig.created;
                    const StatusIcon = status.icon;
                    return (
                      <TableRow key={project.id} className="group hover:bg-muted/30">
                        <TableCell className="font-medium font-mono">
                          <Link href={`/projects/${project.id}`} className="hover:underline hover:text-primary transition-colors">
                            {project.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={`${status.color} border-none font-mono font-medium rounded-sm`}>
                            <StatusIcon className="mr-1.5 h-3 w-3" />
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {project.pageCount || "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          {project.wpUrl ? (
                            <a href={project.wpUrl} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary flex items-center justify-end gap-1 font-mono">
                              <Globe className="h-3 w-3" />
                              {new URL(project.wpUrl).hostname}
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-xs font-mono">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground font-mono">
                          {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
                        </TableCell>
                        <TableCell className="text-right">
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
            <div className="py-12 flex flex-col items-center justify-center border rounded-md border-dashed bg-muted/20">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Box className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-1 font-mono">No projects yet</h3>
              <p className="text-sm text-muted-foreground mb-4">Create your first HTML to WordPress conversion project.</p>
              <Link href="/projects/new">
                <Button className="font-mono">
                  <Plus className="mr-2 h-4 w-4" />
                  New Project
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
