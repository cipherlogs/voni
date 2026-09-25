"use client"

import * as React from "react"
import { Suspense } from "react"
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
  return (
    // NextThemesProvider injects an inline <script> (no-FOUC init). It must
    // render unconditionally: a provider inside a Suspense fallback renders
    // its <script> on the client, which React 19 rejects ("Encountered a
    // script tag while rendering React component"). So the provider stays
    // outside and only the usePathname() leaf suspends — same pattern as
    // app-sidebar and copilot-provider. The fallback is null (no script).
    <NextThemesProvider {...props}>
      <ThemeMigration storageKey={storageKey} />
      <Suspense fallback={null}>
        <LandingLightEnforcer />
      </Suspense>
      {children}
    </NextThemesProvider>
  )
}

/**
 * Light-only public landing (DESIGN.md §10c), ephemeral — never persisted.
 *
 * The previous `forcedTheme` prop needed `usePathname()` in the provider
 * itself, which forced the provider inside a Suspense boundary (see above).
 * Instead this leaf strips the `dark` class while on "/" and restores it on
 * navigation away, so every other route keeps the visitor's own pick and
 * nothing is written to storage. Attribute mode is `class`, so light is the
 * absence of `dark` (root vars in globals.css).
 */
function LandingLightEnforcer() {
  const pathname = usePathname()
  React.useEffect(() => {
    if (pathname !== "/") return
    const root = document.documentElement
    const hadDark = root.classList.contains("dark")
    const prevColorScheme = root.style.colorScheme
    root.classList.remove("dark")
    root.style.colorScheme = "light"
    return () => {
      if (hadDark) root.classList.add("dark")
      root.style.colorScheme = prevColorScheme
    }
  }, [pathname])
  return null
}
