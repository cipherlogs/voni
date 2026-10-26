"use client"

import * as React from "react"
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
 *
 * Storage note (ticket 07): the `theme` key itself stays library-owned
 * (next-themes reads/writes the bare value; versioning it would break the
 * library). The migration flag is versioned by name (`...-v1`); reads accept
 * both the legacy bare `"1"` and the `{version: 1, data: 1}` envelope, and
 * writes store the envelope. Safe fallback: any unreadable storage still
 * flips the in-memory theme to system.
 */
function ThemeMigration({ storageKey }: { storageKey: string }) {
  const { setTheme } = useTheme()
  React.useEffect(() => {
    try {
      const flagRaw = localStorage.getItem(MIGRATION_FLAG)
      if (flagRaw) {
        // Accept legacy bare "1" plus the versioned envelope; any truthy
        // flag means the one-time migration already ran.
        if (flagRaw === "1") return
        try {
          const parsed: unknown = JSON.parse(flagRaw)
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { version?: unknown }).version === 1
          )
            return
        } catch {
          // Non-JSON truthy flag: treat as migrated (safe fallback).
          return
        }
        // Truthy but unrecognized: still migrated — never re-run.
        return
      }
      // Cleanup legacy explicit override, then flip to System.
      // setTheme re-persists theme="system"; missing key would also resolve
      // to defaultTheme="system", so either way the OS preference wins.
      localStorage.removeItem(storageKey)
      setTheme("system")
      localStorage.setItem(MIGRATION_FLAG, JSON.stringify({ version: 1, data: 1 }))
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
  return (
    // NextThemesProvider injects an inline <script> (no-FOUC init); keep it
    // outside any Suspense boundary (React 19 rejects client-rendered
    // scripts). The light-only landing is pure CSS: see `.landing-page` in
    // globals.css.
    <NextThemesProvider {...props}>
      <ThemeMigration storageKey={storageKey} />
      {children}
    </NextThemesProvider>
  )
}
