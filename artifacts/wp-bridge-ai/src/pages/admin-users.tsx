import { useCallback, useEffect, useState } from "react";
import { Users, UserPlus, KeyRound, ShieldOff, ShieldCheck, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AdminShell, AdminLoading, useAdminAuth, type AdminUser } from "@/components/admin-shell";

interface UserRow {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export default function AdminUsers() {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const { user: me, status: authStatus } = useAdminAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pwdTarget, setPwdTarget] = useState<UserRow | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}api/admin/users`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { users: UserRow[] };
      setUsers(body.users);
    } catch (err) {
      toast({ title: "Could not load users", description: String(err), variant: "destructive" });
    }
  }, [apiBase, toast]);

  useEffect(() => {
    if (authStatus === "ok") void reload();
  }, [authStatus, reload]);

  const onToggleAdmin = async (row: UserRow, next: boolean) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`${apiBase}api/admin/users/${row.id}/admin`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast({ title: next ? "Granted admin" : "Removed admin" });
      await reload();
    } catch (err) {
      toast({ title: "Could not update admin status", description: String(err), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  if (authStatus !== "ok" || !users) return <AdminLoading />;

  return (
    <AdminShell user={me} active="users">
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" /> Admin users
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Manage who can sign in to the admin portal. Promote users to admin, change passwords,
              or remove admin access. The system always keeps at least one admin.
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)} data-testid="button-add-user">
            <UserPlus className="h-4 w-4 mr-2" /> Add user
          </Button>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>All accounts</CardTitle>
            <CardDescription>{users.length} user{users.length === 1 ? "" : "s"} total.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isSelf = me?.id === u.id;
                  return (
                    <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                      <TableCell className="font-mono text-sm">
                        {u.username}
                        {isSelf && (
                          <Badge variant="secondary" className="ml-2 text-[10px]">you</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.isAdmin ? (
                          <Badge className="bg-primary/10 text-primary border-primary/20" variant="outline">
                            Admin
                          </Badge>
                        ) : (
                          <Badge variant="outline">User</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(u.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPwdTarget(u)}
                          data-testid={`button-change-password-${u.id}`}
                        >
                          <KeyRound className="h-3.5 w-3.5 mr-1" /> Password
                        </Button>
                        {u.isAdmin ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === u.id || isSelf}
                            title={isSelf ? "You cannot remove your own admin access" : undefined}
                            onClick={() => onToggleAdmin(u, false)}
                            data-testid={`button-revoke-admin-${u.id}`}
                          >
                            <ShieldOff className="h-3.5 w-3.5 mr-1" /> Remove admin
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === u.id}
                            onClick={() => onToggleAdmin(u, true)}
                            data-testid={`button-grant-admin-${u.id}`}
                          >
                            <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Make admin
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>

      <AddUserDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={reload}
      />
      <ChangePasswordDialog
        target={pwdTarget}
        me={me}
        onOpenChange={(open) => { if (!open) setPwdTarget(null); }}
      />
    </AdminShell>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void | Promise<void>;
}) {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setUsername("");
      setPassword("");
      setIsAdmin(true);
    }
  }, [open]);

  const submit = async () => {
    if (username.trim().length === 0 || password.length < 8) {
      toast({
        title: "Username required, password must be 8+ chars",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}api/admin/users`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, isAdmin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast({ title: `Created ${username.trim()}` });
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      toast({ title: "Could not create user", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add admin user</DialogTitle>
          <DialogDescription>
            Create a new account. The user can sign in immediately at <code>/admin/login</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-username">Username</Label>
            <Input
              id="new-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              data-testid="input-new-username"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              data-testid="input-new-password"
            />
            <p className="text-[11px] text-muted-foreground">Minimum 8 characters.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              data-testid="checkbox-new-isadmin"
            />
            Grant admin access
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="button-create-user">
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordDialog({
  target,
  me,
  onOpenChange,
}: {
  target: UserRow | null;
  me: AdminUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const apiBase = import.meta.env.BASE_URL;
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) {
      setCurrentPassword("");
      setNewPassword("");
    }
  }, [target]);

  if (!target) return null;
  const isSelf = me?.id === target.id;

  const submit = async () => {
    if (newPassword.length < 8) {
      toast({ title: "Password must be 8+ chars", variant: "destructive" });
      return;
    }
    if (isSelf && currentPassword.length === 0) {
      toast({ title: "Enter your current password", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}api/admin/users/${target.id}/password`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isSelf ? { newPassword, currentPassword } : { newPassword },
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast({ title: "Password updated" });
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Could not change password", description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password — {target.username}</DialogTitle>
          <DialogDescription>
            {isSelf
              ? "Confirm your current password to set a new one."
              : "Set a new password for this user. They will need to sign in again."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isSelf && (
            <div className="space-y-1.5">
              <Label htmlFor="cur-password">Current password</Label>
              <Input
                id="cur-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="input-current-password"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="new-pwd">New password</Label>
            <Input
              id="new-pwd"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              data-testid="input-new-password-change"
            />
            <p className="text-[11px] text-muted-foreground">Minimum 8 characters.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="button-save-password">
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Update password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
