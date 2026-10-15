import { useNavigate } from 'react-router-dom'
import './App.css'
import './ProfilePage.css'
import './LegalPage.css'

const LAST_UPDATED = '[DATE — fill in on publish]'
const COMPANY_NAME = '[Company / sole-proprietor legal name]'
const CONTACT_EMAIL = '[support email, e.g. privacy@yourdomain.com]'
const JURISDICTION = '[governing law / country-state]'

function Header({ navigate }) {
  return (
    <header className="app-header">
      <div className="app-title">ToneSense</div>
      <div className="header-right">
        <button className="header-profile-btn" onClick={() => navigate('/')}>
          ← Back to Studio
        </button>
      </div>
    </header>
  )
}

function DraftNotice() {
  return (
    <div className="legal-draft-notice">
      <strong>Draft — not yet reviewed by a lawyer.</strong> This page accurately
      describes what the product's code actually does as of this writing, but the
      bracketed fields (company name, contact, governing law, refund policy) must
      be filled in, and the whole document should get a legal review for your
      jurisdiction(s) before it's relied on as a real policy.
    </div>
  )
}

function PrivacyPolicy() {
  return (
    <>
      <h1 className="legal-title">Privacy Policy</h1>
      <p className="legal-meta">Last updated: {LAST_UPDATED}</p>
      <DraftNotice />

      <section className="legal-section">
        <h2>1. What this covers</h2>
        <p>
          This Privacy Policy explains what information ToneSense ("we", "us",
          operated by {COMPANY_NAME}) collects when you use the app, why, and
          who we share it with. It applies whether you use ToneSense signed in
          or as a guest.
        </p>
      </section>

      <section className="legal-section">
        <h2>2. Information we collect</h2>
        <ul>
          <li><strong>Account info.</strong> If you sign up, your email address and account identifier are managed by our authentication provider, Clerk.</li>
          <li><strong>Your guitar recordings.</strong> When you record a take for analysis, the audio is uploaded to our server and stored so you can play it back later and track your progress over time.</li>
          <li><strong>Practice data.</strong> Tempo, detected notes, timing and pitch-accuracy metrics, your stated practice goals/problems, and chat messages you send to the AI coach.</li>
          <li><strong>Guest usage data.</strong> If you use ToneSense without an account, we set an anonymous cookie and record your IP address to apply the free daily usage limit fairly.</li>
          <li><strong>Product analytics.</strong> Through PostHog, we collect which pages/features you use, how you reached the app (e.g. which link or campaign), and funnel events like starting a recording or hitting a usage limit — not the contents of your recordings or chat messages.</li>
          <li><strong>Billing info.</strong> If you subscribe to the paid plan, payments are handled by Stripe. We do not see or store your full card number — we keep only your Stripe customer/subscription reference.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>3. How we use your audio recordings</h2>
        <p>
          Your recording is processed locally on our server to detect notes,
          timing, and pitch accuracy. To generate your AI coaching feedback,
          <strong> the recording is also uploaded to Google's Gemini API</strong>.
          Google processes it to produce the written feedback and the file is
          then deleted from Google's temporary storage once processing
          completes. We do not use your recordings to train our own models
          without separately asking you first.
        </p>
      </section>

      <section className="legal-section">
        <h2>4. Who we share data with</h2>
        <ul>
          <li><strong>Clerk</strong> — authentication and account management.</li>
          <li><strong>Stripe</strong> — payment processing and subscription billing.</li>
          <li><strong>Google (Gemini API)</strong> — AI analysis of your recordings, as described above.</li>
          <li><strong>PostHog</strong> — product analytics (which pages and features get used, where visitors come from) so we know what to fix and build next. It doesn't see your recordings.</li>
          <li><strong>Our hosting provider</strong> — to run the servers and store data; they process data on our behalf and don't use it for their own purposes.</li>
        </ul>
        <p>We do not sell your personal data.</p>
      </section>

      <section className="legal-section">
        <h2>5. How long we keep your data</h2>
        <p>
          We currently keep your recordings, session history, and account data
          until you ask us to delete them — we don't have an automatic
          deletion schedule yet. If you'd like your data (or a specific
          recording) deleted, email {CONTACT_EMAIL} and we'll remove it
          within [X] days. We're working on a self-service delete option; this
          section will be updated once that ships.
        </p>
      </section>

      <section className="legal-section">
        <h2>6. Cookies and similar storage</h2>
        <p>
          We use a small number of functional cookies: a session cookie from
          Clerk (if you're signed in) and an anonymous guest-ID cookie used
          only to apply the free daily usage limit fairly. PostHog, our
          analytics provider, also sets a cookie/local-storage identifier to
          recognize repeat visits and measure how people move through the
          app. We don't use advertising or cross-site tracking cookies, and
          we don't sell or share this data with ad networks.
        </p>
      </section>

      <section className="legal-section">
        <h2>7. Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access,
          correct, export, or delete your personal data, or to object to
          certain processing. To exercise any of these, contact{' '}
          {CONTACT_EMAIL}.
        </p>
      </section>

      <section className="legal-section">
        <h2>8. Children</h2>
        <p>
          ToneSense isn't directed at children under 13 (or the minimum age
          required in your country), and we don't knowingly collect data from
          them.
        </p>
      </section>

      <section className="legal-section">
        <h2>9. Changes to this policy</h2>
        <p>
          If we materially change how we handle your data, we'll update this
          page and update the "Last updated" date above.
        </p>
      </section>

      <section className="legal-section">
        <h2>10. Contact</h2>
        <p>Questions about this policy: {CONTACT_EMAIL}</p>
      </section>
    </>
  )
}

function TermsOfService() {
  return (
    <>
      <h1 className="legal-title">Terms of Service</h1>
      <p className="legal-meta">Last updated: {LAST_UPDATED}</p>
      <DraftNotice />

      <section className="legal-section">
        <h2>1. What ToneSense is</h2>
        <p>
          ToneSense ("the Service") analyzes recordings of your guitar playing
          and gives you automated, AI-generated feedback on timing, pitch, and
          technique to help you practice.
        </p>
      </section>

      <section className="legal-section">
        <h2>2. AI feedback isn't professional instruction</h2>
        <p>
          The feedback you receive, including pitch/timing scores and written
          coaching notes, is generated automatically by signal-processing
          algorithms and an AI model. It's meant as a practice aid, not a
          substitute for a qualified music teacher, and it can be wrong —
          especially while the detection accuracy is actively being improved.
          Don't treat it as authoritative, and please tell us (
          {CONTACT_EMAIL}) if feedback looks clearly off, so we can fix it.
        </p>
      </section>

      <section className="legal-section">
        <h2>3. Accounts and guest use</h2>
        <p>
          You can try ToneSense without an account, subject to a daily usage
          limit. Creating an account (via Clerk) removes that limit on the
          free tier's terms and lets you keep a history of your sessions.
          You're responsible for keeping your account credentials secure and
          for all activity under your account.
        </p>
      </section>

      <section className="legal-section">
        <h2>4. Subscriptions and billing</h2>
        <p>
          The paid "Pro" plan is billed through Stripe on a recurring
          subscription basis. You can cancel anytime from the billing portal
          in your profile; cancellation takes effect at the end of the current
          billing period. [Refund policy: fill in — e.g. "no refunds for
          partial periods except where required by law."]
        </p>
      </section>

      <section className="legal-section">
        <h2>5. Your recordings</h2>
        <p>
          You keep ownership of the audio you record and upload. By using the
          Service, you give us a limited license to store, process, and
          transmit your recordings (including to our AI/analysis providers,
          as described in the Privacy Policy) solely to provide the Service to
          you. Don't upload recordings you don't have the right to use, or
          recordings of other people without their consent.
        </p>
      </section>

      <section className="legal-section">
        <h2>6. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>circumvent or try to bypass usage limits, rate limits, or authentication;</li>
          <li>reverse-engineer, scrape, or interfere with the Service's normal operation;</li>
          <li>upload unlawful, infringing, or abusive content;</li>
          <li>use the Service in a way that violates applicable law.</li>
        </ul>
        <p>We may suspend or terminate accounts that violate this section.</p>
      </section>

      <section className="legal-section">
        <h2>7. No warranty / limitation of liability</h2>
        <p>
          The Service is provided "as is," without warranties of any kind,
          including accuracy of the analysis or feedback. To the maximum
          extent permitted by law, {COMPANY_NAME} isn't liable for indirect,
          incidental, or consequential damages arising from your use of the
          Service.
        </p>
      </section>

      <section className="legal-section">
        <h2>8. Changes to the Service or these Terms</h2>
        <p>
          We may update the Service or these Terms over time. We'll update
          the "Last updated" date above when we make material changes, and
          continued use after that means you accept the updated Terms.
        </p>
      </section>

      <section className="legal-section">
        <h2>9. Governing law</h2>
        <p>These Terms are governed by the laws of {JURISDICTION}.</p>
      </section>

      <section className="legal-section">
        <h2>10. Contact</h2>
        <p>Questions about these Terms: {CONTACT_EMAIL}</p>
      </section>
    </>
  )
}

export default function LegalPage({ doc }) {
  const navigate = useNavigate()

  return (
    <div className="profile-page">
      <Header navigate={navigate} />
      <div className="profile-content legal-content">
        {doc === 'terms' ? <TermsOfService /> : <PrivacyPolicy />}
      </div>
    </div>
  )
}
