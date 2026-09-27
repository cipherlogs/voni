# Demo email test: find the visitor's email by a Test tag, not a spoken address

The demo's email test first found the visitor's email by asking "which address did you use?" and matching the spoken answer against the shared inbox, with Jev forgiving speech-to-text near misses. The owner's first real call showed the cost: Voni invented an address, looked up a placeholder before the visitor answered, and a near miss could only be settled by reading another tester's address aloud. We now give each visitor a **Test tag** (a short word and two digits, in the call's language) to put in the subject. Voni finds the email by the tag, and the sender's own address, authenticated by Gmail's DMARC/SPF verdict, is the claim.

## Considered Options

- **Spoken claim + Jev matcher (replaced):** needs no setup, but speech-to-text errors, privacy (near misses expose other senders) and a whole extra beat of the call.
- **Test tag only:** a visitor who types the email by hand and drops the tag is never found. So the spoken address stays as a fallback, used only when the visitor raises it ("I forgot the tag").
- **Tag per call vs per visitor:** the owner chose per visitor. A tag lives 24 hours in the visitor's browser and in a server registry. A visitor who ran out of time and sent the email afterwards is recognised on their next call, and one whose sender already matched an earlier tag is greeted as returning.

## Consequences

- Tags are issued against the `demo_test_tags` registry rather than generated statelessly. A tag is never reissued within 48 hours of its last issue: a holder's late email must never reach a new holder. Word + 2 digits holds the ~60 calls/day ceiling comfortably. A longer lifetime would need longer tags.
- Voni asks for the tag in the subject, but it is matched in the subject or the start of the body. In the owner's first real test the tag went in the body. Case and spacing don't matter ("Lemon93", "lemon 9 3"). An email naming more than one distinct tag from the call's language matches no one, so one email cannot claim every visitor it lists.
- The provisional extension is earned by an arrived business-domain email, never by a spoken claim.
