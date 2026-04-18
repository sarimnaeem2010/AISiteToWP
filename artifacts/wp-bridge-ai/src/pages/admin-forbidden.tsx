import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminForbidden() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/20 px-4 py-12">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">403 — Forbidden</CardTitle>
          <CardDescription>
            Your account does not have admin access. If you think this is a mistake, contact a system
            administrator.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-xs text-muted-foreground">
          You can return to the regular dashboard at any time.
        </CardContent>
      </Card>
    </div>
  );
}
