import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = { title: "Privacy Policy · Voni" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="September 30, 2026">
      <p>
        Voni (&ldquo;we&rdquo;) runs voni.cc and app.voni.cc, an AI voice agent that places and answers
        phone calls for businesses. This policy explains what we collect, why, and your choices.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account data:</strong> when you sign in with Google, your name, email address and profile picture.</li>
        <li><strong>Workspace data:</strong> the agents, campaigns, leads and phone numbers you add to Voni.</li>
        <li><strong>Call data:</strong> audio, transcripts, summaries and outcomes of calls placed or answered by your agents.</li>
        <li><strong>Live demo:</strong> your voice during the demo call, its transcript, and any email address or website you share with the demo agent.</li>
        <li><strong>Technical data:</strong> IP address, browser type and logs needed to run, secure and rate-limit the service.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To provide and improve the service: sign you in, run your calls, show results in your dashboard,
        answer support requests, prevent abuse, and meet legal obligations. We do not sell personal data
        and we do not use it for advertising.
      </p>

      <h2>Google user data</h2>
      <p>
        Google sign-in is used only to identify you. Voni reads Gmail only for its own demo inbox
        (test@voni.cc), to confirm that an email a demo visitor sent has arrived. We never access the
        Gmail of users who sign in. Voni&rsquo;s use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>

      <h2>Service providers</h2>
      <p>
        We share data only with providers that run parts of the service for us, under their own privacy
        terms: Cloudflare (hosting), Neon (database), Google (sign-in and email), Telnyx (phone calls),
        AssemblyAI and Cartesia (speech recognition and voice), and AI model providers reached through our
        AI gateway (generating the agent&rsquo;s replies).
      </p>

      <h2>Retention and deletion</h2>
      <p>
        We keep your data while your account is active. You can delete agents, campaigns, leads and calls
        in the dashboard at any time, or email us to delete your account and its data.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, export or delete your
        personal data, or to object to its processing. Email us and we will respond within 30 days.
      </p>

      <h2>Changes</h2>
      <p>We will post changes here and update the date above.</p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:hi@voni.cc">hi@voni.cc</a>
      </p>
    </LegalPage>
  );
}
