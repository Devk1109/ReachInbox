import { useEffect, useState, type FormEvent } from "react";
import { ApiError, apiDelete, apiGet, apiPost } from "./api";
import type { PageKey, User } from "./types";
import WorkspacePage from "./WorkspacePage";

type AuthState = "loading" | "signed-out" | "signed-in" | "error";
type SlackStatus = { connected: boolean; configured: boolean; teamId: string | null };

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<PageKey>("scheduled");
  const [counts, setCounts] = useState({ scheduled: 0, sent: 0 });
  const [composeRequest, setComposeRequest] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [sendersOpen, setSendersOpen] = useState(false);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [slackError, setSlackError] = useState("");
  const [error, setError] = useState("");

  async function refreshSlackStatus() {
    try {
      setSlackStatus(await apiGet<SlackStatus>("/api/slack/status"));
    } catch {
      setSlackStatus({ connected: false, configured: false, teamId: null });
    }
  }

  async function loadUser() {
    setAuthState("loading");
    setError("");
    try {
      const result = await apiGet<{ user: User }>("/api/auth/me");
      setUser(result.user);
      setAuthState("signed-in");
      void refreshSlackStatus();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUser(null);
        setAuthState("signed-out");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not connect to ReachInbox");
        setAuthState("error");
      }
    }
  }

  useEffect(() => { void loadUser(); }, []);

  async function signOut() {
    try {
      await apiPost("/api/auth/logout");
      setUser(null);
      setAuthState("signed-out");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out");
    }
  }

  async function disconnectSlack() {
    setSlackError("");
    try {
      await apiDelete("/api/slack/disconnect");
      await refreshSlackStatus();
    } catch (cause) {
      setSlackError(cause instanceof Error ? cause.message : "Could not disconnect Slack");
    }
  }

  if (authState === "loading") return <main className="loading-screen"><span className="loader-mark">OWB</span><p>Loading your workspace…</p></main>;
  if (authState === "signed-out" || authState === "error") return <LoginScreen authState={authState} error={error} onRetry={() => void loadUser()}/>;

  return <main className="mail-app">
    <aside className="mail-sidebar">
      <a className="mail-logo" href="#scheduled" aria-label="ReachInbox home" onClick={() => setPage("scheduled")}>OWB</a>
      <button className="profile-switcher" onClick={() => setProfileOpen(value => !value)} aria-expanded={profileOpen}>
        <span className="profile-avatar">{user?.avatar ? <img src={user.avatar} alt=""/> : user?.name?.[0]?.toUpperCase() ?? "U"}</span>
        <span className="profile-switcher-text"><strong>{user?.name ?? "Your account"}</strong><small>{user?.email}</small></span><span className="chevron">⌄</span>
      </button>
      {profileOpen && <div className="profile-menu">
        <button onClick={() => { setSendersOpen(true); setProfileOpen(false); }}>Manage senders</button>
        <div className="profile-menu-status">Slack · {slackStatus?.connected ? "Connected" : slackStatus?.configured ? "Not connected" : "Setup required"}</div>
        {slackStatus?.connected
          ? <button onClick={() => void disconnectSlack()}>Disconnect Slack</button>
          : <a className={!slackStatus?.configured ? "disabled" : ""} href={slackStatus?.configured ? "/api/slack/connect" : "#"} aria-disabled={!slackStatus?.configured} title={!slackStatus?.configured ? "Configure Slack OAuth in backend/.env" : "Connect Slack"} onClick={event => { if (!slackStatus?.configured) event.preventDefault(); }}>Connect Slack</a>}
        {!slackStatus?.configured && !slackStatus?.connected && <small className="profile-menu-help">Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in backend/.env.</small>}
        {slackError && <small className="profile-menu-error" role="alert">{slackError}</small>}
        <button onClick={() => void signOut()}>Log out</button>
      </div>}
      <button className="compose-sidebar" onClick={() => { setSendersOpen(false); setComposeRequest(value => value + 1); }}>Compose</button>
      <p className="sidebar-label">CORE</p>
      <nav className="mail-nav" aria-label="Mailbox">
        <button className={page === "scheduled" ? "selected" : ""} onClick={() => setPage("scheduled")}><span>◷</span>Scheduled<small>{counts.scheduled}</small></button>
        <button className={page === "sent" ? "selected" : ""} onClick={() => setPage("sent")}><span>➤</span>Sent<small>{counts.sent}</small></button>
      </nav>
    </aside>
    <section className="mail-content">
      <WorkspacePage page={page} composeRequest={composeRequest} onNavigate={setPage} onCountsChange={setCounts} onOpenSenders={() => setSendersOpen(true)} senderManagerOpen={sendersOpen} onCloseSenders={() => setSendersOpen(false)}/>
    </section>
  </main>;
}

function LoginScreen({ authState, error, onRetry }: { authState: AuthState; error: string; onRetry: () => void }) {
  const [emailMessage, setEmailMessage] = useState("");
  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailMessage("Email and password sign-in isn’t enabled yet. Continue with Google to open your workspace.");
  }
  return <main className="login-screen">
    <form className="login-card" onSubmit={submitEmail}>
      <h1>Login</h1>
      {(error || emailMessage) && <div className="login-message" role="alert">{error || emailMessage}</div>}
      <a className="google-login" href="/auth/google"><span className="google-g">G</span>Login with Google</a>
      <div className="login-divider"><span>or sign up through email</span></div>
      <input aria-label="Email ID" type="email" placeholder="Email ID" autoComplete="email"/>
      <input aria-label="Password" type="password" placeholder="Password" autoComplete="current-password"/>
      <button className="email-login" type="submit">Login</button>
      {authState === "error" && <button className="retry-login" type="button" onClick={onRetry}>Try again</button>}
    </form>
  </main>;
}
