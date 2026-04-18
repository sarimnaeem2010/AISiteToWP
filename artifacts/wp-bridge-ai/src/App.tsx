import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { MainLayout } from "./components/layout";
import Landing from "./pages/landing";
import Dashboard from "./pages/dashboard";
import NewProject from "./pages/project-new";
import ProjectWorkspace from "./pages/project-workspace";
import ProjectPreview from "./pages/project-preview";
import ProjectPlugin from "./pages/project-plugin";
import AdminLogin from "./pages/admin-login";
import AdminForbidden from "./pages/admin-forbidden";
import AdminAiSettings from "./pages/admin-ai-settings";
import AdminNotFound from "./pages/admin-not-found";

const queryClient = new QueryClient();

// Stub: until real auth is wired, treat all visitors as signed-out on the
// landing page. Replace with real session check when auth lands.
function useIsAuthenticated() {
  return false;
}

function LandingRoute() {
  const isAuthed = useIsAuthenticated();
  if (isAuthed) return <Redirect to="/app" />;
  return <Landing />;
}

function AppRoutes() {
  const [location] = useLocation();

  // Scroll to top on route change inside the app shell
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  return (
    <MainLayout>
      <Switch>
        <Route path="/app" component={Dashboard} />
        <Route path="/projects/new" component={NewProject} />
        <Route path="/projects/:id" component={ProjectWorkspace} />
        <Route path="/projects/:id/preview" component={ProjectPreview} />
        <Route path="/projects/:id/plugin" component={ProjectPlugin} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function Router() {
  // Admin routes are intentionally a separate tree — no MainLayout, no
  // user sidebar, no shared nav state. Visiting /admin while signed out
  // shows the admin login screen, never the user app.
  return (
    <Switch>
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin/forbidden" component={AdminForbidden} />
      <Route path="/admin" component={AdminAiSettings} />
      <Route path="/admin/ai-settings" component={AdminAiSettings} />
      {/* Catch-all for /admin/* keeps every admin path inside the admin
          portal boundary — never falls through to the user app routes. */}
      <Route path="/admin/:rest*" component={AdminNotFound} />
      <Route path="/" component={LandingRoute} />
      <Route component={AppRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
