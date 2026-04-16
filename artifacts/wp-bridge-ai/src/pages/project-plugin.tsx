import { useParams, Link } from "wouter";
import { useGetProject, useGeneratePlugin } from "@workspace/api-client-react";
import { ArrowLeft, Download, FileCode2, Copy, Check } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function ProjectPlugin() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data: project } = useGetProject(id || "", { query: { enabled: !!id } });
  const { data: pluginData, isLoading } = useGeneratePlugin(id || "", { query: { enabled: !!id } });

  const handleCopy = () => {
    if (pluginData?.phpCode) {
      navigator.clipboard.writeText(pluginData.phpCode);
      setCopied(true);
      toast({ title: "Copied to clipboard" });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!id) return;
    const base = import.meta.env.BASE_URL;
    window.location.href = `${base}api/projects/${id}/plugin-zip`;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-4 mb-8">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono">Companion Plugin</h1>
          <p className="text-muted-foreground text-sm">Install this on your target WordPress instance.</p>
        </div>
      </div>

      <Card className="border-primary/20 shadow-md">
        <CardHeader className="bg-primary/5 border-b pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="font-mono flex items-center gap-2">
                <FileCode2 className="h-5 w-5 text-primary" />
                {pluginData?.filename || "wp-bridge-companion.php"}
              </CardTitle>
              <CardDescription className="mt-2">
                This plugin creates the REST API endpoints necessary to receive the parsed structure.
                It includes authentication and Block/ACF generation logic specifically tailored for <strong>{project?.name || "this project"}</strong>.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCopy} className="font-mono" disabled={!pluginData}>
                {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                Copy
              </Button>
              <Button onClick={handleDownload} className="font-mono" disabled={!pluginData}>
                <Download className="mr-2 h-4 w-4" />
                Download .zip
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-96 flex items-center justify-center font-mono text-muted-foreground bg-black/95">
              Generating PHP code...
            </div>
          ) : pluginData ? (
            <div className="relative">
              <ScrollArea className="h-[600px] w-full bg-[#1e1e1e] text-[#d4d4d4] font-mono text-sm p-4">
                <pre><code>{pluginData.phpCode}</code></pre>
              </ScrollArea>
              <div className="absolute top-4 right-4 bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
                </span>
                API Key Embedded
              </div>
            </div>
          ) : (
            <div className="h-96 flex items-center justify-center font-mono text-destructive bg-black/95">
              Failed to generate plugin code.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
