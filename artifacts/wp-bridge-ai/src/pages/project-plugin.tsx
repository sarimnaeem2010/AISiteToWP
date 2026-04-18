import { useParams, Link } from "wouter";
import { useGetProject, useGeneratePlugin } from "@workspace/api-client-react";
import { ArrowLeft, Download, FileCode2, Copy, Check, Key, ChevronDown } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export default function ProjectPlugin() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

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

  const handleCopyKey = () => {
    if (pluginData?.apiKey) {
      navigator.clipboard.writeText(pluginData.apiKey);
      setKeyCopied(true);
      toast({ title: "API key copied" });
      setTimeout(() => setKeyCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!id) return;
    const base = import.meta.env.BASE_URL;
    window.location.href = `${base}api/projects/${id}/plugin-zip`;
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20 animate-in fade-in duration-500">
      <div className="flex items-center gap-4">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="icon" className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl">Companion plugin</h1>
          <p className="text-muted-foreground text-sm">Install this on your target WordPress instance.</p>
        </div>
      </div>

      {pluginData?.apiKey && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4 text-primary" />
              Plugin API key
            </CardTitle>
            <CardDescription>
              Copy this value into the <strong>Plugin API Key</strong> field in WordPress Config.
              It's already baked into the plugin ZIP you installed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-muted px-3 py-2.5 rounded-lg border border-border font-mono text-xs break-all select-all">
                {pluginData.apiKey}
              </code>
              <Button variant="outline" onClick={handleCopyKey} className="shrink-0">
                {keyCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copy key
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="bg-muted/40 border-b border-border pb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <FileCode2 className="h-5 w-5 text-primary" />
                <span className="font-mono">{pluginData?.filename || "wp-bridge-companion.php"}</span>
              </CardTitle>
              <CardDescription className="mt-2 max-w-2xl">
                This plugin creates the REST endpoints needed to receive your parsed structure.
                It includes authentication and Elementor widget / ACF import logic specifically tailored
                for <strong>{project?.name || "this project"}</strong>.
              </CardDescription>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" onClick={handleCopy} disabled={!pluginData}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copy
              </Button>
              <Button onClick={handleDownload} disabled={!pluginData}>
                <Download className="h-4 w-4" />
                Download .zip
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="h-32 flex items-center justify-center text-muted-foreground">
              Generating PHP code…
            </div>
          ) : pluginData ? (
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-muted/30 transition-colors border-b border-border data-[state=open]:border-b-0">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <FileCode2 className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">PHP source preview</div>
                    <div className="text-xs text-muted-foreground">
                      Optional — open to inspect generated PHP. Hidden by default.
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-muted-foreground hidden sm:inline">Show / hide</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="relative">
                  <ScrollArea className="h-[600px] w-full bg-[#1e1e1e] text-[#d4d4d4] font-mono text-xs p-4">
                    <pre><code>{pluginData.phpCode}</code></pre>
                  </ScrollArea>
                  <div className="absolute top-3 right-3 bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400"></span>
                    </span>
                    API key embedded
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <div className="h-32 flex items-center justify-center text-destructive">
              Failed to generate plugin code.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
