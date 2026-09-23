/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/grid-list-02` (https://blocks.so/r/grid-list-02.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: remote blocks.so avatar PNGs cut —
 * AvatarFallback initials only (no AvatarImage, no external fetch);
 * upstream documenso sample people replaced with neutral placeholder
 * entries; CardContent spaced stack rebuilt as flex+gap; shadow-2xs base +
 * hover:shadow-sm replaced with default token shadows (shadow-sm /
 * hover:shadow-md); avatar h-10 w-10 unified to size-10.
 */

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';

const people = [
  {
    name: 'Amara Okafor',
    email: 'amara@example.com',
    role: 'Operations Lead',
  },
  {
    name: 'Jonas Weber',
    email: 'jonas@example.com',
    role: 'Sales Manager',
  },
  {
    name: 'Priya Nair',
    email: 'priya@example.com',
    role: 'Support Specialist',
  },
  {
    name: 'Diego Fuentes',
    email: 'diego@example.com',
    role: 'Account Executive',
  },
];

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function GridList02() {
  return (
    <div className="flex items-center justify-center p-8">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {people.map((person) => (
          <Card
            className="relative border py-0 shadow-sm transition-[border-color,box-shadow] duration-[var(--motion-standard)] ease-out focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 hover:border-muted-foreground hover:shadow-md"
            key={person.email}
          >
            <CardContent className="flex items-center gap-4 p-4">
              <Avatar className="size-10">
                <AvatarFallback>{initials(person.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <a className="focus:outline-none" href="#">
                  <span aria-hidden="true" className="absolute inset-0" />
                  <p className="text-pretty font-medium text-foreground text-sm">
                    {person.name}
                  </p>
                  <p className="truncate text-pretty text-muted-foreground text-sm">
                    {person.role}
                  </p>
                </a>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
