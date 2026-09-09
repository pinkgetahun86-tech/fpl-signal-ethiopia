import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { MiniApp } from '@/components/mini-app';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { configureTelegramAuth } from '@/lib/telegram';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

configureTelegramAuth();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={MiniApp} />
        <Route path="/challenge" component={MiniApp} />
        <Route path="/team" component={MiniApp} />
        <Route path="/leaderboard" component={MiniApp} />
        <Route path="/points" component={MiniApp} />
        <Route path="/signal" component={MiniApp} />
        <Route path="/about" component={MiniApp} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;