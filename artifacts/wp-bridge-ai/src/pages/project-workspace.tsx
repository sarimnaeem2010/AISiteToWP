import { useState, useEffect } from "react";
import { Link, useParams, useLocation } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronRight, Download, FileCode2, Globe, LayoutTemplate, Settings2, Trash2, Shield, UploadCloud, Eye, AlertCircle, Database, Layers, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useGetProject, useUpdateWordPressConfig, useTestWordPressConnection, usePushToWordPress, useDeleteProject } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

const wpConfigSchema = z
  .object({
    wpUrl: z.string().url("Must be a valid URL"),
    authMode: z.enum(["basic", "api_key"]).default("basic"),
    wpUsername: z.string().default(""),
    wpAppPassword: z.string().default(""),
    wpApiKey: z.string().default(""),
    useAcf: z.boolean().default(true),
  })
  .refine(
    (d) => d.authMode !== "basic" || (d.wpUsername.length > 0 && d.wpAppPassword.length > 0),
    { message: "Username and app password are required for basic auth", path: ["wpAppPassword"] }
  )
  .refine(
    (d) => d.authMode !== "api_key" || d.wpApiKey.length > 0,
    { message: "API key is required", path: ["wpApiKey"] }
  );

export default function ProjectWorkspace() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [, setLocation] = useLocation(); // We'll add this hook from wouter
  
  const { data: project, isLoading, refetch } = useGetProject(id || "", { query: { enabled: !!id } });
  
  const updateConfig = useUpdateWordPressConfig();
  const testConnection = useTestWordPressConnection();
  const pushToWp = usePushToWordPress();
  const deleteProject = useDeleteProject();

  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pastedHtml, setPastedHtml] = useState("");
  const [reparsing, setReparsing] = useState(false);

  const form = useForm<z.infer<typeof wpConfigSchema>>({
    resolver: zodResolver(wpConfigSchema),
    defaultValues: {
      wpUrl: project?.wpConfig?.wpUrl || "",
      authMode: (project?.wpConfig?.authMode as "basic" | "api_key") || "basic",
      wpUsername: project?.wpConfig?.wpUsername || "",
      wpAppPassword: project?.wpConfig?.wpAppPassword || "",
      wpApiKey: project?.wpConfig?.wpApiKey || "",
      useAcf: project?.wpConfig?.useAcf ?? true,
    },
  });

  const currentAuthMode = form.watch("authMode");

  useEffect(() => {
    if (project?.wpConfig) {
      form.reset({
        wpUrl: project.wpConfig.wpUrl,
        authMode: (project.wpConfig.authMode as "basic" | "api_key") || "basic",
        wpUsername: project.wpConfig.wpUsername ?? "",
        wpAppPassword: project.wpConfig.wpAppPassword === "••••••••" ? "" : (project.wpConfig.wpAppPassword ?? ""),
        wpApiKey: project.wpConfig.wpApiKey === "••••••••" ? "" : (project.wpConfig.wpApiKey ?? ""),
        useAcf: project.wpConfig.useAcf ?? true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.wpConfig?.wpUrl, project?.wpConfig?.wpUsername, project?.wpConfig?.authMode, project?.wpConfig?.useAcf]);

  if (isLoading || !project) {
    return <div className="p-8 text-center font-mono text-muted-foreground">Loading project workspace...</div>;
  }

  const currentStep = 
    project.status === "created" ? 1 : 
    project.status === "parsed" ? 2 :
    project.status === "configured" ? 3 : 4;

  const onSaveConfig = (data: z.infer<typeof wpConfigSchema>) => {
    updateConfig.mutate({ id, data }, {
      onSuccess: () => {
        toast({ title: "Configuration saved" });
        refetch();
      },
      onError: (err) => {
        toast({ title: "Error saving", description: err.message, variant: "destructive" });
      }
    });
  };

  const onTestConnection = async () => {
    setTestResult(null);
    const data = form.getValues();
    if (!data.wpUrl) {
      setTestResult({ success: false, message: "Enter a WordPress URL first." });
      return;
    }
    if (data.authMode === "api_key" && !data.wpApiKey) {
      setTestResult({ success: false, message: "Paste the Plugin API Key first (see Companion Plugin page)." });
      return;
    }
    if (data.authMode === "basic" && (!data.wpUsername || !data.wpAppPassword)) {
      setTestResult({ success: false, message: "Enter username and application password first." });
      return;
    }
    // Auto-save so Test Connection reflects what's in the form
    try {
      await updateConfig.mutateAsync({ id, data });
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    testConnection.mutate({ id }, {
      onSuccess: (res) => {
        setTestResult(res);
        if (res.success) {
          toast({ title: "Connection Successful", description: `Connected to ${res.siteTitle || "WordPress"}` });
          refetch();
        }
      },
      onError: (err) => {
        setTestResult({ success: false, message: err.message });
      }
    });
  };

  const onPush = () => {
    pushToWp.mutate({ id }, {
      onSuccess: (res) => {
        const r = res as any;
        const created = r.pagesCreated ?? 0;
        const updated = r.pagesUpdated ?? 0;
        const cptCount = (r.cptItemsCreated ?? 0) + (r.cptItemsUpdated ?? 0);
        const parts: string[] = [];
        if (created > 0) parts.push(`${created} created`);
        if (updated > 0) parts.push(`${updated} updated`);
        if (cptCount > 0) parts.push(`${cptCount} CPT items`);
        const desc = parts.length > 0 ? `Pages: ${parts.join(", ")}.` : "No changes were applied.";
        if (res.success) {
          toast({ title: "Push Successful", description: desc });
        } else {
          toast({ title: "Push completed with errors", description: desc, variant: "destructive" });
        }
        refetch();
      },
      onError: (err) => {
        toast({ title: "Push Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const apiBase = import.meta.env.BASE_URL;
  const proj = project as any;
  const renderer: "gutenberg" | "elementor" | "raw_html" =
    proj.renderer === "elementor" ? "elementor" : proj.renderer === "raw_html" ? "raw_html" : "gutenberg";
  const cpts: Array<{ slug: string; label: string; pluralLabel: string; sourceSemanticType: string; fields: string[]; enabled: boolean }> =
    Array.isArray(proj.customPostTypes) ? proj.customPostTypes : [];

  const reuploadZip = async (file: File) => {
    setReparsing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiBase}api/projects/${id}/upload-zip`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      toast({ title: "Source re-uploaded", description: "Project re-parsed from ZIP. Raw HTML mode is now available." });
      refetch();
    } catch (err) {
      toast({ title: "Re-upload failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setReparsing(false);
    }
  };

  const reparseHtml = async (html: string) => {
    setReparsing(true);
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ htmlContent: html }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      toast({ title: "HTML re-parsed", description: "Raw HTML mode is now available." });
      setPastedHtml("");
      refetch();
    } catch (err) {
      toast({ title: "Re-parse failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setReparsing(false);
    }
  };

  const setRenderer = async (value: "gutenberg" | "elementor" | "raw_html") => {
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/renderer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renderer: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: `Renderer set to ${value}` });
      refetch();
    } catch (err) {
      toast({ title: "Failed to set renderer", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const toggleCpt = async (slug: string, enabled: boolean) => {
    const next = cpts.map((c) => (c.slug === slug ? { ...c, enabled } : c));
    try {
      const res = await fetch(`${apiBase}api/projects/${id}/custom-post-types`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customPostTypes: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refetch();
    } catch (err) {
      toast({ title: "Failed to update CPTs", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const onDelete = () => {
    deleteProject.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Project deleted" });
        window.location.href = "/";
      }
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="font-mono bg-background">PID: {project.id.slice(0,8)}</Badge>
            <Badge className="font-mono uppercase tracking-wider">{project.status}</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">{project.name}</h1>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Globe className="h-4 w-4" />
            {project.wpConfig?.wpUrl || "No target URL configured"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {project.status !== "created" && (
            <Button
              variant="outline"
              className="font-mono"
              onClick={() => {
                const base = import.meta.env.BASE_URL;
                window.location.href = `${base}api/projects/${id}/astro-export`;
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />
              Export Astro
            </Button>
          )}
          <Link href={`/projects/${id}/plugin`}>
            <Button variant="outline" className="font-mono">
              <Download className="mr-2 h-4 w-4" />
              Get Plugin
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Project</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this conversion project? This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Stepper */}
      <div className="rounded-lg border bg-card/50 backdrop-blur shadow-sm p-4">
        <div className="flex items-center justify-between px-2">
          {[
            { step: 1, label: "Source", icon: FileCode2 },
            { step: 2, label: "Parse", icon: LayoutTemplate },
            { step: 3, label: "Config", icon: Settings2 },
            { step: 4, label: "Deploy", icon: UploadCloud },
          ].map((s, i, arr) => (
            <div key={s.step} className="flex items-center">
              <div className={`flex flex-col items-center gap-2 ${currentStep >= s.step ? "text-primary" : "text-muted-foreground opacity-50"}`}>
                <div className={`h-10 w-10 rounded-full border-2 flex items-center justify-center
                  ${currentStep > s.step ? "bg-primary border-primary text-primary-foreground" : 
                    currentStep === s.step ? "border-primary bg-primary/10" : "border-muted bg-transparent"}`}>
                  {currentStep > s.step ? <Check className="h-5 w-5" /> : <s.icon className="h-5 w-5" />}
                </div>
                <span className="text-xs font-mono font-medium uppercase">{s.label}</span>
              </div>
              {i < arr.length - 1 && (
                <div className={`w-12 sm:w-24 md:w-32 h-px mx-2 sm:mx-4 ${currentStep > s.step ? "bg-primary" : "bg-muted"}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content Area */}
        <div className="md:col-span-2 space-y-6">
          {project.status === "created" && (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono">Waiting for Structure</CardTitle>
                <CardDescription>Parse a source to continue.</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/projects/new">
                  <Button className="font-mono">Go to Parse Step</Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && project.parsedSite && (
            <Card className="overflow-hidden border-primary/20 shadow-md">
              <div className="bg-primary/5 border-b border-primary/10 px-6 py-4 flex items-center justify-between">
                <div>
                  <h3 className="font-mono font-bold flex items-center gap-2">
                    <Check className="h-4 w-4 text-emerald-500" />
                    Structure Parsed
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Found {project.parsedSite.pages.length} pages and {project.parsedSite.pages.reduce((acc, p) => acc + p.sections.length, 0)} blocks.
                  </p>
                </div>
                <Link href={`/projects/${id}/preview`}>
                  <Button variant="outline" size="sm" className="font-mono">
                    <Eye className="mr-2 h-4 w-4" />
                    Preview
                  </Button>
                </Link>
              </div>
            </Card>
          )}

          {currentStep >= 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono flex items-center gap-2">
                  <FileCode2 className="h-5 w-5" />
                  Source Files
                </CardTitle>
                <CardDescription>
                  Re-upload a ZIP or paste raw HTML to refresh the parsed structure. Required for projects parsed before Raw HTML mode existed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 text-xs font-mono">
                  <Badge variant={proj.sourceHtml || proj.uploadedFiles ? "default" : "outline"}>
                    {proj.sourceHtml ? "Raw HTML stored" : proj.uploadedFiles ? "ZIP files stored" : "No source on file"}
                  </Badge>
                  {!proj.sourceHtml && (
                    <span className="text-amber-600 dark:text-amber-400">
                      Re-upload required to use the Raw HTML renderer.
                    </span>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <Label className="font-mono text-xs">Re-upload ZIP</Label>
                    <Input
                      type="file"
                      accept=".zip,application/zip"
                      className="font-mono text-xs mt-1"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) reuploadZip(f);
                        e.currentTarget.value = "";
                      }}
                      disabled={reparsing}
                      data-testid="input-reupload-zip"
                    />
                  </div>
                  <div>
                    <Label className="font-mono text-xs">Or paste HTML</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        type="text"
                        placeholder="<html>...</html>"
                        className="font-mono text-xs"
                        value={pastedHtml}
                        onChange={(e) => setPastedHtml(e.target.value)}
                        disabled={reparsing}
                        data-testid="input-paste-html"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => reparseHtml(pastedHtml)}
                        disabled={reparsing || pastedHtml.trim().length === 0}
                        data-testid="button-reparse-html"
                      >
                        {reparsing ? "Parsing..." : "Re-parse"}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono flex items-center gap-2">
                  <Settings2 className="h-5 w-5" />
                  WordPress Target
                </CardTitle>
                <CardDescription>Configure credentials for the target WordPress instance.</CardDescription>
              </CardHeader>
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSaveConfig)} className="space-y-4">
                    <FormField
                      control={form.control}
                      name="wpUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono">WordPress URL</FormLabel>
                          <FormControl>
                            <Input placeholder="https://my-wp-site.com" className="font-mono bg-muted/20" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="authMode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono">Auth Mode</FormLabel>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => field.onChange("basic")}
                              className={`text-left rounded-md border p-3 text-xs font-mono ${field.value === "basic" ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}
                            >
                              <div className="font-semibold uppercase tracking-wider">Application Password</div>
                              <div className="text-muted-foreground mt-1">Admin user + app password via WP REST</div>
                            </button>
                            <button
                              type="button"
                              onClick={() => field.onChange("api_key")}
                              className={`text-left rounded-md border p-3 text-xs font-mono ${field.value === "api_key" ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}
                            >
                              <div className="font-semibold uppercase tracking-wider">Plugin API Key</div>
                              <div className="text-muted-foreground mt-1">Install bridge plugin, paste its API key</div>
                            </button>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {currentAuthMode === "basic" && (
                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="wpUsername"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="font-mono">Admin Username</FormLabel>
                              <FormControl>
                                <Input placeholder="admin" className="font-mono bg-muted/20" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="wpAppPassword"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="font-mono">Application Password</FormLabel>
                              <FormControl>
                                <Input type="password" placeholder="xxxx xxxx xxxx xxxx" className="font-mono bg-muted/20" {...field} />
                              </FormControl>
                              <FormDescription className="text-[10px]">Generate in WP Profile settings</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    )}
                    {currentAuthMode === "api_key" && (
                      <FormField
                        control={form.control}
                        name="wpApiKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono">Plugin API Key</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="paste key from Get Plugin screen" className="font-mono bg-muted/20" {...field} />
                            </FormControl>
                            <FormDescription className="text-[10px]">Generated and embedded by the bridge plugin PHP file (see Get Plugin).</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <div className="space-y-2">
                      <Label className="font-mono">Page Renderer</Label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => setRenderer("gutenberg")}
                          className={`text-left rounded-md border p-3 text-xs font-mono ${renderer === "gutenberg" ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}
                          data-testid="renderer-gutenberg"
                        >
                          <div className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                            <Layers className="h-3.5 w-3.5" /> Gutenberg
                          </div>
                          <div className="text-muted-foreground mt-1">Native WP block editor markup</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenderer("elementor")}
                          className={`text-left rounded-md border p-3 text-xs font-mono ${renderer === "elementor" ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}
                          data-testid="renderer-elementor"
                        >
                          <div className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5" /> Elementor
                          </div>
                          <div className="text-muted-foreground mt-1">Editable in Elementor builder</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenderer("raw_html")}
                          className={`text-left rounded-md border p-3 text-xs font-mono ${renderer === "raw_html" ? "border-primary bg-primary/10" : "border-border bg-muted/20"}`}
                          data-testid="renderer-raw-html"
                        >
                          <div className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                            <FileCode2 className="h-3.5 w-3.5" /> Raw HTML
                          </div>
                          <div className="text-muted-foreground mt-1">Preserve original design 1:1</div>
                        </button>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {renderer === "elementor" && "Requires Elementor plugin installed on target WordPress site."}
                        {renderer === "raw_html" && "Pushes your uploaded HTML + inline CSS as-is. Use a blank/minimal theme on WordPress for best results."}
                        {renderer === "gutenberg" && "Default. Maps parsed sections to native WordPress blocks."}
                      </p>
                    </div>
                    <FormField
                      control={form.control}
                      name="useAcf"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                          <div className="space-y-0.5">
                            <FormLabel className="font-mono">Advanced Custom Fields</FormLabel>
                            <FormDescription>
                              Map parsed data to ACF fields instead of raw block content.
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <div className="flex items-center gap-3 pt-4 border-t">
                      <Button type="submit" disabled={updateConfig.isPending} className="font-mono">
                        {updateConfig.isPending ? "Saving..." : "Save Config"}
                      </Button>
                      <Button type="button" variant="secondary" onClick={onTestConnection} disabled={testConnection.isPending} className="font-mono">
                        {testConnection.isPending ? "Testing..." : "Test Connection"}
                      </Button>
                    </div>
                    
                    {testResult && (
                      <div className={`p-3 rounded-md text-sm font-mono mt-4 flex items-start gap-2 ${testResult.success ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-destructive/10 text-destructive"}`}>
                        {testResult.success ? <Check className="h-4 w-4 mt-0.5 shrink-0" /> : <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                        <div>
                          <div className="font-bold">{testResult.success ? "Connection Verified" : "Connection Failed"}</div>
                          <div className="opacity-90">{testResult.message}</div>
                        </div>
                      </div>
                    )}
                  </form>
                </Form>
              </CardContent>
            </Card>
          )}

          {currentStep >= 2 && cpts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono flex items-center gap-2">
                  <Database className="h-5 w-5" />
                  Custom Post Types
                  <Badge variant="outline" className="font-mono text-[10px] ml-1">AI-detected</Badge>
                </CardTitle>
                <CardDescription>
                  Repeated content patterns detected. Enabled types will be registered by the plugin and pushed as CPT entries instead of inline page sections.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {cpts.map((cpt) => (
                    <div key={cpt.slug} className="flex items-center justify-between rounded-md border p-3 bg-muted/20">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold">{cpt.label}</span>
                          <Badge variant="outline" className="font-mono text-[10px]">{cpt.slug}</Badge>
                          {cpt.sourceSemanticType && (
                            <Badge variant="secondary" className="font-mono text-[10px]">from {cpt.sourceSemanticType}</Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground font-mono">
                          {(cpt.fields?.length ?? 0)} fields · {cpt.enabled ? "will register & import" : "disabled"}
                        </p>
                      </div>
                      <Switch
                        checked={cpt.enabled !== false}
                        onCheckedChange={(checked) => toggleCpt(cpt.slug, checked)}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground font-mono mt-4">
                  Note: After toggling CPTs, re-download the companion plugin from the Get Plugin page so the new CPT registrations take effect on activation.
                </p>
              </CardContent>
            </Card>
          )}

          {currentStep >= 3 && (
            <Card className={project.status === "configured" ? "border-primary shadow-md" : ""}>
              <CardHeader>
                <CardTitle className="font-mono flex items-center gap-2">
                  <UploadCloud className="h-5 w-5" />
                  Deploy to WordPress
                </CardTitle>
                <CardDescription>Push the generated structure and design system to your WP instance.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md bg-muted/30 p-4 border border-dashed mb-6">
                  <h4 className="font-mono text-sm font-medium mb-2 flex items-center gap-2">
                    <Shield className="h-4 w-4 text-amber-500" />
                    Pre-flight Check
                  </h4>
                  <ul className="text-sm space-y-2 text-muted-foreground">
                    <li className="flex items-center gap-2"><Check className="h-3 w-3 text-emerald-500" /> Parsed structure ready</li>
                    <li className="flex items-center gap-2"><Check className="h-3 w-3 text-emerald-500" /> WP REST API reachable</li>
                    <li className="flex items-center gap-2"><Check className="h-3 w-3 text-emerald-500" /> Plugin companion ready</li>
                  </ul>
                </div>
                <Button 
                  size="lg" 
                  className="w-full font-mono text-base h-14" 
                  onClick={onPush}
                  disabled={pushToWp.isPending}
                >
                  {pushToWp.isPending ? (
                    "Deploying..."
                  ) : (
                    <>
                      <UploadCloud className="mr-2 h-5 w-5" />
                      Convert & Push to WordPress
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar / Log Area */}
        <div className="space-y-6">
          <Card className="h-[600px] flex flex-col">
            <CardHeader className="py-4 border-b">
              <CardTitle className="text-sm font-mono flex items-center justify-between">
                Deployment Log
                <Badge variant="outline" className="text-[10px]">LIVE</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden bg-black/95 text-green-400 font-mono text-xs">
              <ScrollArea className="h-full w-full p-4">
                {(!project.pushLog || project.pushLog.length === 0) ? (
                  <div className="opacity-50 italic">Waiting for deployment...</div>
                ) : (
                  <div className="space-y-2">
                    {project.pushLog.map((log, i) => (
                      <div key={i} className="flex gap-3">
                        <span className="opacity-50 shrink-0">[{new Date(log.createdAt).toLocaleTimeString()}]</span>
                        <span className={`shrink-0 ${log.status === 'error' ? 'text-red-400' : log.status === 'success' ? 'text-green-400' : 'text-yellow-400'}`}>
                          {log.status.toUpperCase()}
                        </span>
                        <span className="break-all">{log.pageName} {log.error ? `- ${log.error}` : ''}</span>
                        {log.wpUrl && (
                          <a href={log.wpUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline shrink-0 flex items-center">
                            view <Globe className="h-3 w-3 ml-1" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

