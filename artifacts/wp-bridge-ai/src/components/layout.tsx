import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, Plus, Settings, Blocks, Download, Zap, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

interface SidebarProps {
  className?: string;
}

function SidebarContent() {
  const [location] = useLocation();

  const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "New Project", href: "/projects/new", icon: Plus },
  ];

  return (
    <div className="flex h-full flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 font-mono font-bold text-sidebar-primary tracking-tight">
          <Zap className="h-5 w-5 fill-current" />
          <span>WP_BRIDGE_AI</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-2">
          <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Overview
          </div>
          {navigation.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`group flex items-center rounded-md px-2 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                }`}
              >
                <item.icon
                  className={`mr-3 h-4 w-4 shrink-0 ${
                    isActive ? "text-sidebar-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/70"
                  }`}
                />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-sidebar-accent flex items-center justify-center text-xs font-medium text-sidebar-foreground">
            DEV
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-sidebar-foreground">Developer Mode</span>
            <span className="text-[10px] text-sidebar-foreground/50">v0.1.0-beta</span>
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
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-x-4 border-b bg-background/80 backdrop-blur-md px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8 md:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="-m-2.5 p-2.5 text-foreground md:hidden">
                <span className="sr-only">Open sidebar</span>
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64 bg-sidebar border-r-sidebar-border">
              <SidebarContent />
            </SheetContent>
          </Sheet>
          <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6 items-center">
            <div className="flex items-center gap-2 font-mono font-bold text-primary tracking-tight">
              <Zap className="h-5 w-5 fill-current" />
              <span>WP_BRIDGE_AI</span>
            </div>
          </div>
        </header>

        <main className="flex-1">
          <div className="py-8 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
