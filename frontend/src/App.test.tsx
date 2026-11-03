import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const testUser = { id: "u1", name: "Oliver Brown", email: "oliver@example.com", avatar: null, createdAt: "2026-01-01T00:00:00.000Z" };
const testSender = { id: "s1", userId: "u1", email: "oliver@example.com", smtpHost: "smtp.ethereal.email", smtpPort: 587, smtpUsername: "test", hourlyLimit: 100, minDelaySeconds: 2, isActive: true, createdAt: "2026-01-01T00:00:00.000Z" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("ReachInbox screenshot-led mailbox", () => {
  it("shows the compact Google login design when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "AUTH_REQUIRED", message: "Sign in required" } }, 401)));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Login" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /login with google/i })).toHaveAttribute("href", "/auth/google");
    expect(screen.getByPlaceholderText("Email ID")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("shows the mailbox, status counts, search, filter, and refresh controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path.startsWith("/api/emails/scheduled")) return json({ emails: [], total: 12, page: 1, pageSize: 100 });
      if (path.startsWith("/api/emails/sent")) return json({ emails: [], total: 785, page: 1, pageSize: 1 });
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    }));
    render(<App />);
    expect(await screen.findByRole("button", { name: /scheduled\s*12/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sent\s*785/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compose" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search emails" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter emails" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh inbox" })).toBeInTheDocument();
  });

  it("shows setup instructions when Slack OAuth is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path === "/api/slack/status") return json({ connected: false, configured: false, teamId: null });
      if (path.startsWith("/api/emails/scheduled") || path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 100 });
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Oliver Brown/ }));
    const connect = await screen.findByRole("link", { name: "Connect Slack" });
    expect(connect).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText(/Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET/)).toBeInTheDocument();
  });

  it("disconnects Slack and exposes the OAuth reconnect link", async () => {
    let connected = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path === "/api/slack/status") return json({ connected, configured: true, teamId: connected ? "team-1" : null });
      if (path === "/api/slack/disconnect" && init?.method === "DELETE") { connected = false; return new Response(null, { status: 204 }); }
      if (path.startsWith("/api/emails/scheduled") || path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 100 });
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Oliver Brown/ }));
    expect(await screen.findByText("Slack · Connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    expect(await screen.findByRole("link", { name: "Connect Slack" })).toHaveAttribute("href", "/api/slack/connect");
    expect(fetchMock).toHaveBeenCalledWith("/api/slack/disconnect", expect.objectContaining({ method: "DELETE" }));
  });

  it("opens an email in the screenshot-led message detail view", async () => {
    const email = { id: "e1", campaignId: "c1", senderId: "s1", senderEmail: testSender.email, recipient: "john@example.com", subject: "Meeting follow-up", scheduledAt: "2026-11-03T03:45:00.000Z", sentAt: null, status: "SCHEDULED", isStarred: false, archivedAt: null, trashedAt: null, retryCount: 0, errorMessage: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path.startsWith("/api/emails/scheduled")) return json({ emails: [email], total: 1, page: 1, pageSize: 100 });
      if (path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 1 });
      if (path === "/api/emails/e1") return json({ email: { ...email, body: "Hi John,\n\nJust following up." } });
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /to: john@example.com/i }));
    expect(await screen.findByText(/Hi John,/)).toHaveTextContent("Just following up.");
    expect(screen.getByRole("button", { name: "Back to emails" })).toBeInTheDocument();
  });

  it("persists star, archive, trash, and undo actions", async () => {
    let isStarred = false;
    let hiddenAction: "archive" | "trash" | null = null;
    const email = { id: "e2", campaignId: "c1", senderId: "s1", senderEmail: testSender.email, recipient: "jane@example.com", subject: "Project update", scheduledAt: "2026-11-03T03:45:00.000Z", sentAt: null, status: "SCHEDULED", isStarred: false, archivedAt: null, trashedAt: null, retryCount: 0, errorMessage: null };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path.startsWith("/api/emails/scheduled")) return json({ emails: hiddenAction ? [] : [{ ...email, isStarred }], total: hiddenAction ? 0 : 1, page: 1, pageSize: 100 });
      if (path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 1 });
      if (path === "/api/emails/e2") return json({ email: { ...email, isStarred, body: "Hello Jane" } });
      if (path === "/api/emails/e2/star" && init?.method === "PATCH") {
        isStarred = (JSON.parse(String(init.body)) as { isStarred: boolean }).isStarred;
        return json({ email: { ...email, isStarred, body: "Hello Jane" } });
      }
      if (path === "/api/emails/e2/archive" && init?.method === "POST") { hiddenAction = "archive"; return json({ email }); }
      if (path === "/api/emails/e2/trash" && init?.method === "POST") { hiddenAction = "trash"; return json({ email }); }
      if (path === "/api/emails/e2/restore" && init?.method === "POST") { hiddenAction = null; return json({ email }); }
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /to: jane@example.com/i }));
    await screen.findByText("Hello Jane");
    fireEvent.click(await screen.findByRole("button", { name: "Star email" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/emails/e2/star", expect.objectContaining({ method: "PATCH" })));
    expect(await screen.findByRole("button", { name: "Remove star" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive email" }));
    expect(await screen.findByText("Email archived")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /to: jane@example.com/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /to: jane@example.com/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to recycle bin" }));
    expect(await screen.findByText("Moved to Recycle Bin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /to: jane@example.com/i })).toBeInTheDocument();
  });

  it("composes and schedules an email to typed recipients", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path === "/api/senders") return json({ senders: [testSender] });
      if (path.startsWith("/api/emails/scheduled")) return json({ emails: [], total: 0, page: 1, pageSize: 100 });
      if (path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 1 });
      if (path === "/api/campaigns" && init?.method === "POST") return json({ campaign: { id: "c1" }, recipientCount: 1 }, 201);
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Compose" }));
    expect(await screen.findByRole("heading", { name: "Compose New Email" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Add recipient" }), { target: { value: "john@example.com" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Add recipient" }), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Meeting follow-up" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), { target: { value: "Hello John" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/campaigns", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("No scheduled emails yet")).toBeInTheDocument();
  });

  it("opens the Send Later picker and supports preset delivery times", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ user: testUser });
      if (path === "/api/senders") return json({ senders: [testSender] });
      if (path.startsWith("/api/emails/scheduled") || path.startsWith("/api/emails/sent")) return json({ emails: [], total: 0, page: 1, pageSize: 1 });
      return json({ emails: [], total: 0, page: 1, pageSize: 1 });
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Compose" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose send time" }));
    expect(await screen.findByRole("heading", { name: "Send Later" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow, 10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Send Later" })).toBeInTheDocument();
  });
});
