import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiRequest } from "./api";
import type { Email, PageKey, RecipientPreview, Sender } from "./types";

type EmailResponse = { emails: Email[]; total: number; page: number; pageSize: number };

export default function WorkspacePage({ page, composeRequest, onNavigate, onCountsChange, onOpenSenders, senderManagerOpen, onCloseSenders }: {
  page: PageKey;
  composeRequest: number;
  onNavigate: (page: PageKey) => void;
  onCountsChange: (counts: { scheduled: number; sent: number }) => void;
  onOpenSenders: () => void;
  senderManagerOpen: boolean;
  onCloseSenders: () => void;
}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [scheduledCount, setScheduledCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [composer, setComposer] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<(Email & { body: string }) | null>(null);
  const [query, setQuery] = useState("");
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [notice, setNotice] = useState<{ emailId: string; action: "archive" | "trash" } | null>(null);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [current, scheduled, sent] = await Promise.all([
        apiGet<EmailResponse>(`/api/emails/${page}?page=1&pageSize=100`),
        apiGet<EmailResponse>("/api/emails/scheduled?page=1&pageSize=1"),
        apiGet<EmailResponse>("/api/emails/sent?page=1&pageSize=1"),
      ]);
      setEmails(current.emails);
      setTotal(current.total);
      setScheduledCount(scheduled.total);
      setSentCount(sent.total);
      onCountsChange({ scheduled: scheduled.total, sent: sent.total });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your mailbox");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSenders() {
    try {
      const result = await apiGet<{ senders: Sender[] }>("/api/senders");
      setSenders(result.senders);
      return result.senders;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load senders");
      return [];
    }
  }

  useEffect(() => { void refresh(); }, [page]);
  useEffect(() => {
    if (!composeRequest) return;
    void refreshSenders().then(() => { setSelectedEmail(null); setComposer(true); });
  }, [composeRequest]);

  async function search(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (!query.trim()) {
        await refresh();
        return;
      }
      const params = new URLSearchParams({ q: query.trim(), status: page === "sent" ? "SENT" : "SCHEDULED" });
      const result = await apiGet<EmailResponse>(`/api/emails/search?${params}`);
      setEmails(result.emails);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search is unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function openEmail(email: Email) {
    setError("");
    try {
      const result = await apiGet<{ email: Email & { body: string } }>(`/api/emails/${email.id}`);
      setSelectedEmail(result.email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this email");
    }
  }

  async function toggleStar(email: Email & { body?: string }) {
    setError("");
    const nextIsStarred = !email.isStarred;
    setEmails(current => current.map(item => item.id === email.id ? { ...item, isStarred: nextIsStarred } : item));
    setSelectedEmail(current => current?.id === email.id ? { ...current, isStarred: nextIsStarred } : current);
    try {
      const result = await apiRequest<{ email: Email & { body?: string } }>(`/api/emails/${email.id}/star`, {
        method: "PATCH",
        body: JSON.stringify({ isStarred: nextIsStarred }),
      });
      setEmails(current => current.map(item => item.id === email.id ? { ...item, ...result.email } : item));
      setSelectedEmail(current => current?.id === email.id ? { ...current, ...result.email, body: current.body } : current);
    } catch (cause) {
      setEmails(current => current.map(item => item.id === email.id ? { ...item, isStarred: email.isStarred } : item));
      setSelectedEmail(current => current?.id === email.id ? { ...current, isStarred: email.isStarred } : current);
      setError(cause instanceof Error ? cause.message : "Could not update the star");
    }
  }

  async function moveEmail(email: Email, action: "archive" | "trash") {
    setError("");
    try {
      await apiPost(`/api/emails/${email.id}/${action}`);
      setSelectedEmail(null);
      setNotice({ emailId: email.id, action });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this email");
    }
  }

  async function restoreEmail() {
    if (!notice) return;
    try {
      await apiPost(`/api/emails/${notice.emailId}/restore`);
      setNotice(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this email");
    }
  }

  return <div className="mail-workspace">
    {error && <div className="mail-error" role="alert">{error}</div>}
    {composer ? <Composer senders={senders} onBack={() => setComposer(false)} onOpenSenders={onOpenSenders} onScheduled={() => { setComposer(false); setSelectedEmail(null); onNavigate("scheduled"); }}/>
      : selectedEmail ? <EmailDetail email={selectedEmail} onBack={() => setSelectedEmail(null)} onStar={() => void toggleStar(selectedEmail)} onArchive={() => void moveEmail(selectedEmail, "archive")} onTrash={() => void moveEmail(selectedEmail, "trash")}/>
        : <>
          <div className="mail-tools">
            <form className="mail-search" onSubmit={search}>
              <button aria-label="Search" type="submit">⌕</button>
              <input type="search" aria-label="Search emails" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search"/>
            </form>
            <div className="mail-tool-actions">
              <div className="filter-wrap"><button className={`plain-icon filter-icon ${onlyStarred ? "is-active" : ""}`} aria-label="Filter emails" title="Filter emails" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.25 3.25h11.5L9.25 8.5v4l-2.5 1v-5L2.25 3.25Z" /></svg></button>
                {filterOpen && <div className="filter-menu"><button onClick={() => { setOnlyStarred(false); setFilterOpen(false); }}>All emails</button><button onClick={() => { setOnlyStarred(true); setFilterOpen(false); }}>Starred only</button></div>}
              </div>
              <button className="plain-icon" aria-label="Refresh inbox" title="Refresh" onClick={() => void refresh()}>⟳</button>
            </div>
          </div>
          <div className="email-list" aria-label={`${page} email list`}>
            {loading ? <div className="mail-empty">Loading emails…</div> : (onlyStarred ? emails.filter(email => email.isStarred) : emails).length ? (onlyStarred ? emails.filter(email => email.isStarred) : emails).map(email => <EmailRow key={email.id} email={email} page={page} starred={email.isStarred} onOpen={() => void openEmail(email)} onStar={() => void toggleStar(email)}/>)
              : <div className="mail-empty">{onlyStarred ? "No starred emails" : `No ${page} emails yet`}</div>}
          </div>
          <div className="mail-list-footer">{page === "scheduled" ? scheduledCount : sentCount} {page} {total > 0 ? "· refreshed just now" : ""}</div>
          {notice && <div className="mailbox-toast" role="status"><span>{notice.action === "archive" ? "Email archived" : "Moved to Recycle Bin"}</span><button onClick={() => void restoreEmail()}>Undo</button><button className="toast-close" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button></div>}
        </>}
    {senderManagerOpen && <SenderManager onClose={onCloseSenders} onUpdated={() => void refreshSenders()}/>}
  </div>;
}

function EmailRow({ email, page, starred, onOpen, onStar }: { email: Email; page: PageKey; starred: boolean; onOpen: () => void; onStar: () => void }) {
  return <article className="email-row">
    <button className="email-row-main" onClick={onOpen}>
      <span className="row-to">To: <strong>{email.recipient}</strong></span>
      <span className={`row-status ${page === "scheduled" ? "row-scheduled" : "row-sent"}`}>{page === "sent" ? "Sent" : `◷ ${formatShortDate(email.scheduledAt)}`}</span>
      <span className="row-subject">{email.subject}</span>
      <span className="row-snippet">— {email.status === "FAILED" ? email.errorMessage ?? "Delivery failed" : "Open to view message…"}</span>
    </button>
    <button className={`row-star ${starred ? "starred" : ""}`} aria-label={starred ? "Remove star" : "Star email"} onClick={onStar}>{starred ? "★" : "☆"}</button>
  </article>;
}

function EmailDetail({ email, onBack, onStar, onArchive, onTrash }: { email: Email & { body: string }; onBack: () => void; onStar: () => void; onArchive: () => void; onTrash: () => void }) {
  return <article className="email-detail">
    <header className="detail-toolbar"><button className="plain-icon back-button" aria-label="Back to emails" onClick={onBack}>←</button><h1>{email.subject} <span>| {email.id.slice(0, 10).toUpperCase()}</span></h1><div className="detail-actions"><button className={`plain-icon ${email.isStarred ? "starred" : ""}`} aria-label={email.isStarred ? "Remove star" : "Star email"} onClick={onStar}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.55 4.45 1.08 6.28L12 17.36l-5.63 2.97 1.08-6.28L2.9 9.6l6.3-.9L12 3Z"/></svg></button><button className="plain-icon" aria-label="Archive email" title="Archive" onClick={onArchive}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5h16v4H4zM5.5 8.5v11h13v-11M9 12h6"/></svg></button><button className="plain-icon" aria-label="Move to recycle bin" title="Move to recycle bin" onClick={onTrash}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 10v6M14 10v6"/></svg></button><span className="detail-avatar">{email.senderEmail[0]?.toUpperCase() ?? "S"}</span></div></header>
    <div className="detail-message">
      <div className="detail-sender"><span className="detail-sender-avatar">{email.senderEmail[0]?.toUpperCase() ?? "S"}</span><div><strong>{email.senderEmail}</strong><small>to me <span>⌄</span></small></div><time>{formatDate(email.sentAt ?? email.scheduledAt)}</time></div>
      <div className="detail-body">{email.body}</div>
    </div>
  </article>;
}

function Composer({ senders, onBack, onOpenSenders, onScheduled }: { senders: Sender[]; onBack: () => void; onOpenSenders: () => void; onScheduled: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [senderId, setSenderId] = useState(senders.find(sender => sender.isActive)?.id ?? "");
  const [toInput, setToInput] = useState("");
  const [manualRecipients, setManualRecipients] = useState<string[]>([]);
  const [fileRecipients, setFileRecipients] = useState<string[]>([]);
  const [preview, setPreview] = useState<RecipientPreview | null>(null);
  const [startTime, setStartTime] = useState(localDateTimeDefault());
  const [sendLater, setSendLater] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const recipients = [...fileRecipients, ...manualRecipients];

  function addRecipient(value = toInput) {
    const candidates = value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
    if (!candidates.length) return;
    const valid = candidates.filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
    if (valid.length !== candidates.length) setError("Enter a valid email address for each recipient.");
    setManualRecipients(current => Array.from(new Set([...current, ...valid])));
    setToInput("");
  }

  function recipientKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addRecipient(); }
    if (event.key === "Backspace" && !toInput && manualRecipients.length) setManualRecipients(current => current.slice(0, -1));
  }

  async function uploadList(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Choose a CSV smaller than 2 MB."); return; }
    setUploading(true);
    setError("");
    try {
      const content = await file.text();
      const result = await apiPost<RecipientPreview>("/api/campaigns/validate-recipients", { recipientCsv: content });
      setPreview(result);
      setFileRecipients(result.recipients);
    } catch (cause) {
      setFileRecipients([]);
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Could not read that recipient list");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function setTomorrow(hour: number) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hour, 0, 0, 0);
    setStartTime(toLocalDateTime(date));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const allRecipients = Array.from(new Set(recipients));
    if (!allRecipients.length) { setError("Add a recipient or upload a recipient list."); setSaving(false); return; }
    if (!senderId) { setError("Choose a sender before scheduling this email."); setSaving(false); return; }
    if (preview?.invalidCount) { setError("Fix or remove invalid email addresses from your uploaded list."); setSaving(false); return; }
    const recipientCsv = allRecipients.join("\n");
    try {
      await apiPost("/api/campaigns", {
        senderId,
        subject: String(form.get("subject")),
        body: String(form.get("body")),
        startTime: sendLater ? new Date(startTime).toISOString() : new Date(Date.now() + 2000).toISOString(),
        delayBetweenEmails: Number(form.get("delayBetweenEmails")),
        hourlyLimit: Number(form.get("hourlyLimit")),
        recipientCsv,
      });
      onScheduled();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not schedule this email");
    } finally {
      setSaving(false);
    }
  }

  return <form className="compose-screen" onSubmit={submit}>
    <header className="compose-header"><button type="button" className="compose-back" aria-label="Back to mailbox" onClick={onBack}>←</button><h1 className="compose-title">Compose New Email</h1><div className="compose-actions"><input ref={inputRef} className="hidden-file-input" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={event => void uploadList(event.target.files?.[0])}/><button type="button" className="plain-icon upload-list-icon" title="Upload recipient list" aria-label="Upload recipient list" onClick={() => inputRef.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 6.8-6.8a3.5 3.5 0 0 1 5 5l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2"/><path d="m6.4 14.6 9.2-9.2"/></svg></button><button type="button" className="plain-icon" title="Send later" aria-label="Choose send time" onClick={() => { setSendLater(true); setScheduleOpen(value => !value); }}>◷</button><button className="outline-send" disabled={saving || uploading}>{saving ? "Scheduling…" : sendLater ? "Send Later" : "Send"}</button></div></header>
    {error && <div className="compose-error" role="alert">{error}</div>}
    {senders.filter(sender => sender.isActive).length === 0 && <div className="sender-required"><span>No sender connected yet.</span><button type="button" onClick={onOpenSenders}>Add a sender</button></div>}
    <div className="compose-fields">
      <div className="compose-field from-field"><span className="field-caption">From</span><select aria-label="From sender" value={senderId} onChange={event => setSenderId(event.target.value)}><option value="">Select sender</option>{senders.filter(sender => sender.isActive).map(sender => <option key={sender.id} value={sender.id}>{sender.email}</option>)}</select><button type="button" className="add-sender-link" onClick={onOpenSenders}>＋ Add sender</button></div>
      <div className="compose-field to-field"><span className="field-caption">To</span><div className="recipient-input-wrap">{recipients.slice(0, 3).map(email => <span className="recipient-chip" key={email}>{email}<button type="button" aria-label={`Remove ${email}`} onClick={() => { setFileRecipients(list => list.filter(item => item !== email)); setManualRecipients(list => list.filter(item => item !== email)); }}>×</button></span>)}{recipients.length > 3 && <span className="recipient-chip more-chip">+{recipients.length - 3}</span>}<input aria-label="Add recipient" value={toInput} onChange={event => setToInput(event.target.value)} onKeyDown={recipientKey} onBlur={() => { if (toInput.trim()) addRecipient(); }} placeholder={recipients.length ? "Add another recipient" : "recipient@example.com"}/><button type="button" className="upload-list-button" onClick={() => inputRef.current?.click()}>{uploading ? "Reading…" : "↥ Upload List"}</button></div></div>
      <label className="compose-field subject-field"><span className="field-caption">Subject</span><input required name="subject" maxLength={255} placeholder="Subject"/></label>
      <div className="compose-sending-options"><label>Delay between 2 emails<input required name="delayBetweenEmails" aria-label="Delay between emails in seconds" type="number" min="0" defaultValue="60"/></label><label>Hourly Limit<input required name="hourlyLimit" aria-label="Hourly limit" type="number" min="1" defaultValue="100"/></label><span className="recipient-total">{recipients.length ? `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}` : ""}</span></div>
      {preview && <div className={`upload-summary ${preview.invalidCount ? "upload-summary-error" : ""}`}><strong>{preview.validCount} email addresses detected</strong><span>{preview.duplicateCount} duplicates · {preview.invalidCount} invalid</span></div>}
      <div className="editor-wrap"><div className="editor-placeholder">Type Your Reply...</div><div className="editor-toolbar" aria-label="Message formatting"><span>↶</span><span>↷</span><i/><span>Tt⌄</span><i/><strong>B</strong><em>I</em><u>U</u><i/><span>≡</span><span>↕</span><i/><span>1.</span><span>☷</span><span>⇤</span><span>⇥</span><span>❝</span><span>▣</span><span>＄</span></div><textarea aria-label="Message body" name="body" required placeholder=""/></div>
      {scheduleOpen && <aside className="schedule-popover"><h2>Send Later</h2><label className="schedule-date-label">Pick date &amp; time<input aria-label="Send date and time" type="datetime-local" value={startTime} onChange={event => setStartTime(event.target.value)}/></label><button type="button" onClick={() => setTomorrow(9)}>Tomorrow</button><button type="button" onClick={() => setTomorrow(10)}>Tomorrow, 10:00 AM</button><button type="button" onClick={() => setTomorrow(11)}>Tomorrow, 11:00 AM</button><button type="button" onClick={() => setTomorrow(15)}>Tomorrow, 3:00 PM</button><div className="schedule-popover-actions"><button type="button" onClick={() => setScheduleOpen(false)}>Cancel</button><button type="button" className="outline-send" onClick={() => { setSendLater(true); setScheduleOpen(false); }}>Done</button></div></aside>}
    </div>
  </form>;
}

function SenderManager({ onClose, onUpdated }: { onClose: () => void; onUpdated: () => void }) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"ethereal" | "smtp" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void apiGet<{ senders: Sender[] }>("/api/senders").then(result => setSenders(result.senders)).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to load senders")).finally(() => setLoading(false)); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const ethereal = mode === "ethereal";
    const payload = ethereal ? {
      email: form.get("email"), hourlyLimit: Number(form.get("hourlyLimit")), minDelaySeconds: Number(form.get("minDelaySeconds")),
    } : {
      email: form.get("email"), smtpHost: form.get("smtpHost"), smtpPort: Number(form.get("smtpPort")), smtpUsername: form.get("smtpUsername"), smtpPassword: form.get("smtpPassword"), hourlyLimit: Number(form.get("hourlyLimit")), minDelaySeconds: Number(form.get("minDelaySeconds")),
    };
    try {
      await apiPost(ethereal ? "/api/senders/ethereal" : "/api/senders", payload);
      const result = await apiGet<{ senders: Sender[] }>("/api/senders");
      setSenders(result.senders);
      setMode(null);
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add sender");
    } finally {
      setSaving(false);
    }
  }

  async function remove(sender: Sender) {
    try {
      await apiDelete(`/api/senders/${sender.id}`);
      const result = await apiGet<{ senders: Sender[] }>("/api/senders");
      setSenders(result.senders);
      onUpdated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove sender"); }
  }

  return <div className="sender-modal-backdrop" role="presentation"><section className="sender-modal" role="dialog" aria-modal="true" aria-labelledby="sender-manager-title">
    <header><div><p className="sender-kicker">MAILBOX SETTINGS</p><h2 id="sender-manager-title">Manage senders</h2></div><button className="plain-icon" aria-label="Close sender settings" onClick={onClose}>×</button></header>
    {error && <div className="compose-error" role="alert">{error}</div>}
    {mode ? <form className="sender-form" onSubmit={save}><h3>{mode === "ethereal" ? "Add Ethereal test sender" : "Add SMTP sender"}</h3><label>From email<input required type="email" name="email" placeholder="you@example.com"/></label>{mode === "smtp" && <><label>SMTP host<input required name="smtpHost" placeholder="smtp.example.com"/></label><div className="sender-form-row"><label>Port<input required name="smtpPort" type="number" defaultValue="587"/></label><label>Username<input required name="smtpUsername"/></label></div><label>Password<input required name="smtpPassword" type="password" autoComplete="new-password"/></label></>}<div className="sender-form-row"><label>Hourly limit<input required name="hourlyLimit" type="number" min="1" defaultValue="100"/></label><label>Delay (seconds)<input required name="minDelaySeconds" type="number" min="0" defaultValue={mode === "ethereal" ? "2" : "30"}/></label></div><div className="sender-form-actions"><button type="button" onClick={() => setMode(null)}>Cancel</button><button className="outline-send" disabled={saving}>{saving ? "Saving…" : "Save sender"}</button></div></form> : <>
      {loading ? <p className="sender-empty">Loading senders…</p> : senders.length ? <div className="managed-senders">{senders.map(sender => <div className="managed-sender" key={sender.id}><span className="sender-mail-icon">✉</span><span><strong>{sender.email}</strong><small>{sender.smtpHost}:{sender.smtpPort} · {sender.isActive ? "Active" : "Paused"}</small></span><button aria-label={`Remove ${sender.email}`} onClick={() => void remove(sender)}>Remove</button></div>)}</div> : <p className="sender-empty">Add a sender to compose and schedule email.</p>}
      <div className="sender-manager-actions"><button className="sender-secondary" onClick={() => setMode("ethereal")}>Add Ethereal test sender</button><button className="outline-send" onClick={() => setMode("smtp")}>Add SMTP sender</button></div>
    </>}
  </section></div>;
}

function formatShortDate(value: string) { return new Date(value).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit" }); }
function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function localDateTimeDefault() { return toLocalDateTime(new Date(Date.now() + 60 * 60 * 1000)); }
function toLocalDateTime(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
