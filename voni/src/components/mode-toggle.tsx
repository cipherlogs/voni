"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ModeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  // Mounted via the house `useSyncExternalStore` idiom (see
  // `appearance-tile.tsx`): false on the server, true after hydration.
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  // Token-only theme icon: resolved theme picks one icon, so no dark-mode
  // variant classes and no arbitrary sizes (DESIGN.md §5).
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon">
            {isDark ? (
              <Moon className="size-5" aria-hidden />
            ) : (
              <Sun className="size-5" aria-hidden />
            )}
            <span className="sr-only">Toggle theme</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setTheme("light")}>
            Light
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("dark")}>
            Dark
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("system")}>
            System
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
