import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Terms of Service · Voni" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="September 30, 2026">
      <p>
        These terms govern your use of Voni at voni.cc and app.voni.cc. By using Voni you agree to them.
      </p>

      <h2>The service</h2>
      <p>
        Voni lets businesses create AI voice agents that place and answer phone calls. Features may change
        as the product develops.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with Google and are responsible for activity under your account. Keep your Google
        account secure and tell us if you suspect unauthorized use.
      </p>

      <h2>Acceptable use</h2>
      <p>You agree to follow all laws that apply to your calls, including telemarketing, consent and call-recording laws. You will not use Voni to:</p>
      <ul>
        <li>call people who have not consented to be contacted, or who are on a do-not-call list;</li>
        <li>deceive, harass or defraud anyone, or impersonate a real person or organization;</li>
        <li>send spam, or interfere with or overload the service.</li>
      </ul>
      <p>
        You are responsible for the leads and numbers you upload and for disclosing, where required, that
        calls are made by an AI and may be recorded.
      </p>

      <h2>Your content</h2>
      <p>
        You own the data you add and the call records your agents create. You give us permission to process
        it only to run the service, as described in our <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>AI output</h2>
      <p>
        Agents generate speech with AI and can make mistakes. Review important outcomes before relying on them.
      </p>

      <h2>Suspension and termination</h2>
      <p>
        You can stop using Voni at any time. We may suspend or end access if you break these terms or put
        the service or others at risk.
      </p>

      <h2>Disclaimer and liability</h2>
      <p>
        Voni is provided &ldquo;as is&rdquo;, without warranties of any kind. To the extent the law allows, we are not
        liable for indirect or consequential damages, and our total liability is limited to the amount you
        paid us in the 12 months before the claim.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms. We will post changes here and update the date above.</p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:hi@voni.cc">hi@voni.cc</a>
      </p>
    </LegalPage>
  );
}
