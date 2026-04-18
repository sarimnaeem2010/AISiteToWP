import { useState } from "react";
import { useLocation } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Code2, Link as LinkIcon, Upload, Check } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCreateProject, useParseProject } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const projectSchema = z.object({
  name: z.string().min(2, "Project name must be at least 2 characters").max(50, "Project name is too long"),
});

const STEPS = [
  { id: 1, label: "Details" },
  { id: 2, label: "Source"  },
  { id: 3, label: "Review"  },
] as const;

export default function NewProject() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [projectId, setProjectId] = useState<string | null>(null);

  const [htmlContent, setHtmlContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [inputType, setInputType] = useState<"html" | "url" | "zip">("html");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const createProject = useCreateProject();
  const parseProject = useParseProject();

  const form = useForm<z.infer<typeof projectSchema>>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: "" },
  });

  const onProjectSubmit = (data: z.infer<typeof projectSchema>) => {
    createProject.mutate({ data }, {
      onSuccess: (res) => {
        setProjectId(res.id);
        setStep(2);
      },
      onError: (err) => {
        toast({
          title: "Error creating project",
          description: err instanceof Error ? err.message : "An unknown error occurred",
          variant: "destructive",
        });
      }
    });
  };

  const onParseSubmit = async () => {
    if (!projectId) return;

    if (inputType === "zip") {
      if (!zipFile) {
        toast({ title: "Error", description: "Please select a ZIP file", variant: "destructive" });
        return;
      }
      setIsUploading(true);
      try {
        const fd = new FormData();
        fd.append("file", zipFile);
        const base = import.meta.env.BASE_URL;
        const res = await fetch(`${base}api/projects/${projectId}/upload-zip`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(err.error || `Upload failed (${res.status})`);
        }
        toast({ title: "ZIP extracted and parsed", description: "Site structure analyzed." });
        setLocation(`/projects/${projectId}`);
      } catch (err) {
        toast({
          title: "ZIP upload failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
      return;
    }

    if (inputType === "html" && !htmlContent.trim()) {
      toast({ title: "Error", description: "Please paste HTML content", variant: "destructive" });
      return;
    }
    if (inputType === "url" && !sourceUrl.trim()) {
      toast({ title: "Error", description: "Please enter a valid URL", variant: "destructive" });
      return;
    }

    const parsePayload = {
      htmlContent: inputType === "html" ? htmlContent : sourceUrl,
      sourceType: inputType as "html" | "url",
    };

    parseProject.mutate({ id: projectId, data: parsePayload }, {
      onSuccess: () => {
        toast({
          title: "Project parsed successfully",
          description: "Structure has been analyzed.",
        });
        setLocation(`/projects/${projectId}`);
      },
      onError: (err) => {
        toast({
          title: "Error parsing project",
          description: err instanceof Error ? err.message : "An unknown error occurred",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="space-y-2">
        <h1>New conversion project</h1>
        <p className="text-muted-foreground text-base">
          Import an HTML source — paste, upload, or scrape — and we'll extract pages, sections,
          and design tokens ready for WordPress.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-between bg-card border border-card-border rounded-xl px-5 py-4 shadow-xs">
        {STEPS.map((s, i) => {
          const isDone = step > s.id;
          const isActive = step === s.id;
          return (
            <div key={s.id} className="flex items-center flex-1">
              <div className="flex items-center gap-3">
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                    isDone
                      ? "bg-primary text-primary-foreground"
                      : isActive
                        ? "bg-primary/10 text-primary border border-primary/30"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isDone ? <Check className="h-4 w-4" /> : s.id}
                </div>
                <span className={`text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 mx-4 h-px ${step > s.id ? "bg-primary/40" : "bg-border"}`} />
              )}
            </div>
          );
        })}
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Project details</CardTitle>
            <CardDescription>Name your project to keep track of this conversion.</CardDescription>
          </CardHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onProjectSubmit)}>
              <CardContent>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Acme Corp Landing Page" {...field} />
                      </FormControl>
                      <FormDescription>A recognizable name for this conversion.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              <CardFooter className="flex justify-end border-t border-border bg-muted/30 px-6 py-4 rounded-b-xl">
                <Button type="submit" disabled={createProject.isPending}>
                  {createProject.isPending ? "Creating…" : "Continue"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </CardFooter>
            </form>
          </Form>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Provide source</CardTitle>
            <CardDescription>Paste HTML, upload a ZIP, or scrape a public URL.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Tabs defaultValue="html" onValueChange={(v) => setInputType(v as "html" | "url" | "zip")} className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="html"><Code2 className="mr-2 h-4 w-4" />Paste HTML</TabsTrigger>
                <TabsTrigger value="zip"><Upload className="mr-2 h-4 w-4" />Upload ZIP</TabsTrigger>
                <TabsTrigger value="url"><LinkIcon className="mr-2 h-4 w-4" />From URL</TabsTrigger>
              </TabsList>

              <TabsContent value="zip" className="mt-5">
                <div className="space-y-2">
                  <Label htmlFor="zip-input">Site archive (ZIP)</Label>
                  <Input
                    id="zip-input"
                    type="file"
                    accept=".zip,application/zip"
                    className="cursor-pointer"
                    onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                  />
                  {zipFile && (
                    <p className="text-xs text-muted-foreground">
                      {zipFile.name} — {(zipFile.size / 1024).toFixed(1)} KB
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Upload a ZIP export of your HTML/CSS/JS site. We'll locate the index page and extract the structure.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="html" className="mt-5">
                <div className="space-y-2">
                  <Label htmlFor="html-content">HTML source</Label>
                  <Textarea
                    id="html-content"
                    placeholder="<!DOCTYPE html>&#10;<html>&#10;..."
                    className="min-h-[300px] font-mono text-sm"
                    value={htmlContent}
                    onChange={(e) => setHtmlContent(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Paste the complete HTML export from your AI builder (v0, Bolt, Lovable, etc).
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="url" className="mt-5">
                <div className="space-y-2">
                  <Label htmlFor="url-input">Target URL</Label>
                  <Input
                    id="url-input"
                    type="url"
                    placeholder="https://example-preview.vercel.app"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Provide a public URL to extract structure from. The page must render fully on initial load.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
          <CardFooter className="flex justify-between border-t border-border bg-muted/30 px-6 py-4 rounded-b-xl">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={parseProject.isPending || isUploading}>
              Back
            </Button>
            <Button onClick={onParseSubmit} disabled={parseProject.isPending || isUploading}>
              {parseProject.isPending || isUploading ? "Parsing…" : "Parse & continue"}
              {!(parseProject.isPending || isUploading) && <ArrowRight className="h-4 w-4" />}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
