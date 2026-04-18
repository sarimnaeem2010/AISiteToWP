import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Plus, Zap, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

function SidebarContent() {
  const [location] = useLocation();

  const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "New Project", href: "/projects/new", icon: Plus },
  ];

  return (
    <div className="flex h-full flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-16 items-center px-5 border-b border-sidebar-border">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Zap className="h-4 w-4 fill-current" />
          </span>
          <span className="text-base font-semibold tracking-tight text-foreground">WP Bridge AI</span>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto py-5">
        <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Workspace
        </div>
        <nav className="space-y-1 px-2">
          {navigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`group flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                }`}
              >
                <item.icon
                  className={`mr-2.5 h-4 w-4 shrink-0 ${
                    isActive ? "text-sidebar-primary" : "text-muted-foreground group-hover:text-sidebar-accent-foreground"
                  }`}
                />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
            DV
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold text-foreground">Developer</span>
            <span className="text-[10px] text-muted-foreground">v0.1.0 • Beta</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <div className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 z-20">
        <SidebarContent />
      </div>

      <div className="flex flex-1 flex-col md:pl-64">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-x-4 border-b border-border bg-background/80 backdrop-blur-md px-4 sm:px-6 lg:px-8 md:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-m-2.5 p-2.5 text-foreground md:hidden">
                <span className="sr-only">Open sidebar</span>
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 bg-sidebar">
              <SidebarContent />
            </SheetContent>
          </Sheet>
          <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6 items-center">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="h-4 w-4 fill-current" />
              </span>
              <span className="text-sm font-semibold tracking-tight">WP Bridge AI</span>
            </div>
          </div>
        </header>

        <main className="flex-1">
          <div className="py-8 px-4 sm:px-6 lg:px-10 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
