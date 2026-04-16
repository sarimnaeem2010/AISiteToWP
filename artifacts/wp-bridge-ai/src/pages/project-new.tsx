import { useState } from "react";
import { useLocation } from "wouter";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Code2, Link as LinkIcon, Upload } from "lucide-react";
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
    defaultValues: {
      name: "",
    },
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
    <div className="max-w-2xl mx-auto space-y-8 py-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tight font-mono">New Conversion Project</h1>
        <p className="text-muted-foreground">
          Import your AI-generated site structure to begin the WordPress conversion.
        </p>
      </div>

      <div className="flex gap-4 items-center mb-8 relative">
        <div className="absolute left-6 right-6 top-1/2 h-px bg-border -z-10" />
        <div className={`flex flex-col items-center justify-center bg-background px-4 ${step >= 1 ? "text-primary" : "text-muted-foreground"}`}>
          <div className={`h-8 w-8 rounded-full border-2 flex items-center justify-center font-mono text-sm mb-2 ${step >= 1 ? "border-primary bg-primary/10" : "border-muted bg-muted/20"}`}>
            1
          </div>
          <span className="text-xs font-medium uppercase tracking-wider">Details</span>
        </div>
        <div className="flex-1" />
        <div className={`flex flex-col items-center justify-center bg-background px-4 ${step >= 2 ? "text-primary" : "text-muted-foreground"}`}>
          <div className={`h-8 w-8 rounded-full border-2 flex items-center justify-center font-mono text-sm mb-2 ${step >= 2 ? "border-primary bg-primary/10" : "border-muted bg-muted/20"}`}>
            2
          </div>
          <span className="text-xs font-medium uppercase tracking-wider">Source</span>
        </div>
        <div className="flex-1" />
        <div className="flex flex-col items-center justify-center bg-background px-4 text-muted-foreground opacity-50">
          <div className="h-8 w-8 rounded-full border-2 border-muted bg-muted/20 flex items-center justify-center font-mono text-sm mb-2">
            3
          </div>
          <span className="text-xs font-medium uppercase tracking-wider">Review</span>
        </div>
      </div>

      {step === 1 && (
        <Card className="shadow-md">
          <CardHeader>
            <CardTitle className="font-mono">Project Details</CardTitle>
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
                      <FormLabel className="font-mono">Project Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Acme Corp Landing Page" className="font-mono" {...field} />
                      </FormControl>
                      <FormDescription>
                        A recognizable name for this conversion.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              <CardFooter className="flex justify-end border-t bg-muted/20 px-6 py-4">
                <Button type="submit" disabled={createProject.isPending} className="font-mono">
                  {createProject.isPending ? "Creating..." : "Continue"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </CardFooter>
            </form>
          </Form>
        </Card>
      )}

      {step === 2 && (
        <Card className="shadow-md">
          <CardHeader>
            <CardTitle className="font-mono">Provide Source</CardTitle>
            <CardDescription>Paste HTML or provide a URL to parse the site structure.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Tabs defaultValue="html" onValueChange={(v) => setInputType(v as "html" | "url" | "zip")} className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="html" className="font-mono">
                  <Code2 className="mr-2 h-4 w-4" />
                  Paste HTML
                </TabsTrigger>
                <TabsTrigger value="zip" className="font-mono">
                  <Upload className="mr-2 h-4 w-4" />
                  Upload ZIP
                </TabsTrigger>
                <TabsTrigger value="url" className="font-mono">
                  <LinkIcon className="mr-2 h-4 w-4" />
                  URL Extract
                </TabsTrigger>
              </TabsList>
              <TabsContent value="zip" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="zip-input" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Site Archive (ZIP)</Label>
                  <Input
                    id="zip-input"
                    type="file"
                    accept=".zip,application/zip"
                    className="font-mono cursor-pointer"
                    onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                  />
                  {zipFile && (
                    <p className="text-xs text-muted-foreground font-mono">
                      {zipFile.name} — {(zipFile.size / 1024).toFixed(1)} KB
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Upload a ZIP export of your HTML/CSS/JS site. We'll locate the index page and extract the structure.
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="html" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="html-content" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Raw HTML Output</Label>
                  <Textarea
                    id="html-content"
                    placeholder="<!DOCTYPE html>&#10;<html>&#10;..."
                    className="min-h-[300px] font-mono text-sm bg-muted/30"
                    value={htmlContent}
                    onChange={(e) => setHtmlContent(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Paste the complete HTML export from your AI builder (v0, Bolt, etc).
                  </p>
                </div>
              </TabsContent>
              <TabsContent value="url" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="url-input" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Target URL</Label>
                  <Input
                    id="url-input"
                    type="url"
                    placeholder="https://example-preview.vercel.app"
                    className="font-mono"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Provide a public URL to extract structure from. Ensure the page is fully rendered on load.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
          <CardFooter className="flex justify-between border-t bg-muted/20 px-6 py-4">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={parseProject.isPending || isUploading} className="font-mono">
              Back
            </Button>
            <Button onClick={onParseSubmit} disabled={parseProject.isPending || isUploading} className="font-mono">
              {parseProject.isPending || isUploading ? "Parsing Structure..." : "Parse & Continue"}
              {!(parseProject.isPending || isUploading) && <ArrowRight className="ml-2 h-4 w-4" />}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
