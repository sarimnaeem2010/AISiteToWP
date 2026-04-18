import { useState } from "react";
import { Check, CreditCard, FileText, Sparkles, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Tier = {
  id: "free" | "pro" | "team";
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
  highlight?: boolean;
  cta: string;
};

const tiers: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "forever",
    blurb: "Try the full conversion flow on a single project.",
    features: ["1 active project", "100 pages converted / month", "Community support"],
    cta: "Current plan",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$29",
    cadence: "/ month",
    blurb: "For freelancers shipping client sites every week.",
    features: ["Unlimited projects", "5,000 pages / month", "Priority parser queue", "Email support"],
    highlight: true,
    cta: "Upgrade to Pro",
  },
  {
    id: "team",
    name: "Team",
    price: "$99",
    cadence: "/ month",
    blurb: "Shared workspace for agencies with multiple operators.",
    features: ["Everything in Pro", "Up to 10 seats", "Shared project library", "SSO (coming soon)"],
    cta: "Upgrade to Team",
  },
];

export default function BillingPage() {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [chosenTier, setChosenTier] = useState<Tier | null>(null);

  const openUpgrade = (tier: Tier) => {
    if (tier.id === "free") return;
    setChosenTier(tier);
    setUpgradeOpen(true);
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your subscription and review invoices.</p>
      </div>

      {/* Current plan */}
      <Card>
        <CardContent className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">Free plan</h2>
                <Badge variant="outline" className="text-[10px]">Current</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                You're on the Free plan. Upgrade to remove project limits and unlock priority parsing.
              </p>
            </div>
          </div>
          <Button onClick={() => openUpgrade(tiers[1])} data-testid="button-upgrade-current">
            <Zap className="h-4 w-4" />
            Upgrade
          </Button>
        </CardContent>
      </Card>

      {/* Plan tiers */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Plans</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {tiers.map((tier) => (
            <Card
              key={tier.id}
              className={tier.highlight ? "border-primary/50 shadow-md ring-1 ring-primary/20" : ""}
              data-testid={`card-tier-${tier.id}`}
            >
              <CardContent className="p-6 flex flex-col h-full">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold tracking-tight">{tier.name}</h3>
                  {tier.highlight && (
                    <Badge className="bg-primary/15 text-primary border-primary/20" variant="outline">
                      Popular
                    </Badge>
                  )}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-3xl font-bold tracking-tight">{tier.price}</span>
                  <span className="text-sm text-muted-foreground">{tier.cadence}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{tier.blurb}</p>
                <ul className="mt-5 space-y-2">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 pt-4 border-t border-border">
                  <Button
                    className="w-full"
                    variant={tier.highlight ? "default" : "outline"}
                    disabled={tier.id === "free"}
                    onClick={() => openUpgrade(tier)}
                    data-testid={`button-choose-${tier.id}`}
                  >
                    {tier.cta}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Invoices */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Recent invoices</h2>
        <Card>
          <CardContent className="p-10 flex flex-col items-center justify-center text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground mb-3">
              <FileText className="h-5 w-5" />
            </span>
            <h3 className="text-base font-semibold tracking-tight mb-1">No invoices yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              You're on the Free plan, so there's nothing to invoice. Upgrade to a paid plan and your receipts will appear here.
            </p>
          </CardContent>
        </Card>
      </section>

      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              Payments coming soon
            </DialogTitle>
            <DialogDescription className="pt-2">
              {chosenTier
                ? `We're not charging cards for the ${chosenTier.name} plan just yet. Email us and we'll set you up manually until self-serve checkout ships.`
                : "We're finalising payment processing. Email us and we'll set you up manually."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between gap-2">
            <Button variant="outline" onClick={() => setUpgradeOpen(false)}>
              Close
            </Button>
            <a href="mailto:hello@wpbridge.ai">
              <Button data-testid="button-contact-sales">Contact us</Button>
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
