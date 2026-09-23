import { MessageCircle, Phone, Wrench } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Landing feature grid on the grid-list-01 idiom (DESIGN.md §4) translated
 * into the editorial Tile grammar (ticket 02): flat card tokens with ring
 * hairlines, generous padding, and bottom-anchored descriptions so the row
 * reads as one document. Vendored pattern from Blocks `@blocks-so/grid-list-01`
 * (https://blocks.so/r/grid-list-01.json, MIT ©2025 Ephraim Duncan —
 * see voni/THIRD-PARTY-NOTICES.md), content rewritten for Voni.
 * Adaptations: static icon tiles replace the initials block + dropdown
 * menu (no per-card actions on a marketing grid); ring + padding + hover
 * breath follow the bento Tile language (§10b) without scenes or CTAs.
 */

const features = [
  {
    icon: Phone,
    title: 'Goal-pursuing, not scripted',
    description:
      'Your agent tracks Intent, Blocker, State, and Next Action for every lead — and picks up exactly where it left off on the next call.',
  },
  {
    icon: MessageCircle,
    title: 'One conversation, every channel',
    description:
      'Phone and WhatsApp feed the same lead timeline. A reply on WhatsApp is remembered on the next call — not a separate silo.',
  },
  {
    icon: Wrench,
    title: 'Reasoning you can see',
    description:
      'Every Blocker and Next Action is traced back to the tool call or transcript moment that produced it — not a black box.',
  },
];

export function GridListShowcase() {
  return (
    <ul
      className="grid grid-cols-1 gap-6 md:grid-cols-3"
      role="list"
    >
      {features.map((feature) => (
        <li className="col-span-1" key={feature.title}>
          <Card className="h-full w-full rounded-xl bg-card py-0 ring-1 ring-foreground/10 transition-shadow duration-[var(--motion-standard)] hover:shadow-md">
            <CardContent className="flex flex-1 flex-col gap-3 p-8">
              <div className="bg-muted text-foreground flex size-8 items-center justify-center rounded-md">
                <feature.icon className="size-4" />
              </div>
              <p className="font-medium">{feature.title}</p>
              <p className="text-muted-foreground mt-auto text-sm leading-relaxed">
                {feature.description}
              </p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
