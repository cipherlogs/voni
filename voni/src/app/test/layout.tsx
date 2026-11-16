import { FingerprintTestProvider } from "@/components/fingerprint-test-provider";

/**
 * Scoped to `/test` on purpose — see the provider's comment. Everything else
 * (fonts, theme, toaster) still comes from the root layout, so the page sits
 * in the normal app shell.
 */
export default function TestLayout({ children }: LayoutProps<"/test">) {
  return <FingerprintTestProvider>{children}</FingerprintTestProvider>;
}
