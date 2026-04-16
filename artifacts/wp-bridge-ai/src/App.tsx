import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { MainLayout } from "./components/layout";
import Dashboard from "./pages/dashboard";
import NewProject from "./pages/project-new";
import ProjectWorkspace from "./pages/project-workspace";
import ProjectPreview from "./pages/project-preview";
import ProjectPlugin from "./pages/project-plugin";

const queryClient = new QueryClient();

function Router() {
  return (
    <MainLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/projects/new" component={NewProject} />
        <Route path="/projects/:id" component={ProjectWorkspace} />
        <Route path="/projects/:id/preview" component={ProjectPreview} />
        <Route path="/projects/:id/plugin" component={ProjectPlugin} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
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
