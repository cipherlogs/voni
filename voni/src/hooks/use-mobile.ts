import { useSharedMatchMedia } from "@/lib/client/shared-listeners"

const MOBILE_BREAKPOINT = 768

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

export function useIsMobile() {
  // Shared matchMedia: one cached query + one native change listener per query.
  return useSharedMatchMedia(MOBILE_QUERY, false)
}
