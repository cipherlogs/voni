"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

const MIGRATION_FLAG = "voni-theme-migrated-v1"

/**
 * One-time migrate-all to System default.
 *
 * Legacy profiles may carry an explicit next-themes `theme` value
 * ("light"/"dark") from before System became the default. On first mount,
 * clear that stale override and switch to "system" so the OS preference
 * applies. The flag ensures this runs exactly once — later user picks via
 * ModeToggle (Light/Dark/System) persist untouched through next-themes.
 */
function ThemeMigration({ storageKey }: { storageKey: string }) {
  const { setTheme } = useTheme()
  React.useEffect(() => {
    try {
      if (localStorage.getItem(MIGRATION_FLAG)) return
      // Cleanup legacy explicit override, then flip to System.
      // setTheme re-persists theme="system"; missing key would also resolve
      // to defaultTheme="system", so either way the OS preference wins.
      localStorage.removeItem(storageKey)
      setTheme("system")
      localStorage.setItem(MIGRATION_FLAG, "1")
    } catch {
      // Private-mode storage denial: in-memory theme still flips to system.
    }
  }, [setTheme, storageKey])
  return null
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const storageKey =
    (props as { storageKey?: string }).storageKey ?? "theme"
  // The public landing is light-only (DESIGN.md §10c): forced, not persisted,
  // so every other route keeps the visitor's own pick.
  const forcedTheme = usePathname() === "/" ? "light" : props.forcedTheme
  return (
    <NextThemesProvider {...props} forcedTheme={forcedTheme}>
      <ThemeMigration storageKey={storageKey} />
      {children}
    </NextThemesProvider>
  )
}
