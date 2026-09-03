"use client";

import { useCallback, useEffect, useState } from "react";
import { Chip } from "./ui";
import { api } from "@/lib/basePath";

interface Group {
  id: number;
  name: string;
  active: boolean;
  message_count: number;
  load_count: number;
}

interface Message {
  id: number;
  body: string;
  author_name: string | null;
  status: string;
  skip_reason: string | null;
  error: string | null;
  extractor: string | null;
  attempts: number;
  sent_at: string;
  processed_at: string | null;
  group_name: string | null;
  load_count: number;
}

interface TryResult {
  status: string;
  reason?: string;
  loadsCreated: number;
  duplicates: number;
  extractor: string | null;
  loads: Array<{
    id: number;
    pickup_label: string;
    delivery_label: string;
    pickup_date: string | null;
    contact_name: string | null;
    contact_phone: string | null;
    load_type: string | null;
    weight_lbs: number | null;
    pallets: number | null;
    confidence: number;
    needs_review: boolean;
    is_canonical: boolean;
  }>;
}

const STATUS_FILTERS = ["", "pending", "done", "skipped", "error"];

export function AdminConsole({ groups }: { groups: Group[] }) {
  const [tab, setTab] = useState<"messages" | "try" | "groups">("try");

  return (
    <div className="mx-auto max-w-[1400px] p-5">
      <h1 className="text-[19px] font-bold tracking-tight">Pipeline admin</h1>
      <p className="mt-1 text-[13px] text-muted">
        Everything on the board is derived from <code>raw_messages</code>, so any message can be
        replayed after a prompt or alias change without re-ingesting it.
      </p>

      <div className="mt-4 flex gap-1 border-b border-border">
        {(
          [
            ["try", "Try a message"],
            ["messages", "Message feed"],
            ["groups", "WhatsApp groups"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="px-3 py-2 text-[13px] font-semibold"
            style={
              tab === key
                ? { color: "var(--accent)", borderBottom: "2px solid var(--accent)" }
                : { color: "var(--muted)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "try" && <TryMessage />}
        {tab === "messages" && <MessageFeed />}
        {tab === "groups" && <Groups groups={groups} />}
      </div>
    </div>
  );
}

/* ------------------------- paste-a-message harness ------------------------ */

const EXAMPLES = [
  "Tomorrow NJ → PA, pickup Newark, delivery Pittsburgh, 2 pallets, call Peter 973-555-1234",
  "Need someone for Philly to Miami tomorrow. 44,000 lbs dry van. $3200. Rosa 908-555-7788",
  "3 loads all tmrw, call me 267-555-8833:\nnewark -> boston 12 plts\nedison nj -> pitt 44k lbs\ncarteret -> richmond va reefer",
  "north jersey to south florida, pickup mon, 22 pallets, reefer preferred. Tony 856-555-3311",
  "empty in Newark, looking for loads to the midwest",
];

function TryMessage() {
  const [text, setText] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await fetch(api("/api/admin/ingest"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, group: "Manual entry" }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) setError(json.error ?? "Failed");
    else setResult(json as TryResult);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-4">
        <label className="label">WhatsApp message</label>
        <textarea
          className="field font-mono"
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex, i) => (
            <button
              key={i}
              className="chip cursor-pointer"
              style={{ background: "var(--surface-2)", color: "var(--muted)" }}
              onClick={() => setText(ex)}
            >
              example {i + 1}
            </button>
          ))}
        </div>
        <button className="btn btn-primary mt-3" onClick={run} disabled={busy || !text.trim()}>
          {busy ? "Extracting…" : "Run the pipeline"}
        </button>
        <p className="mt-2 text-[11px] text-muted">
          Runs extraction, location normalization, geocoding and duplicate detection exactly as
          webhook traffic does — then writes the result to the live board.
        </p>
      </div>

      <div className="card p-4">
        <label className="label">Result</label>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!result && !error && <p className="text-[13px] text-muted">Run a message to see the output.</p>}

        {result && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={result.status === "done" ? "ok" : result.status === "error" ? "warn" : "neutral"}>
                {result.status}
              </Chip>
              {result.extractor && <Chip>{result.extractor}</Chip>}
              {result.reason && <Chip tone="warn">{result.reason}</Chip>}
            </div>

            {result.loads.length === 0 ? (
              <p className="text-[13px] text-muted">
                No loads produced — this is the correct outcome for chatter, driver availability
                posts, and anything without both an origin and a destination.
              </p>
            ) : (
              result.loads.map((l) => (
                <div key={l.id} className="card p-3" style={{ background: "var(--surface-2)" }}>
                  <div className="flex items-center gap-2 font-semibold">
                    {l.pickup_label} → {l.delivery_label}
                    {!l.is_canonical && <Chip tone="warn">duplicate</Chip>}
                    {l.needs_review && <Chip tone="warn">needs review</Chip>}
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                    <Pair k="Pickup date" v={l.pickup_date ?? "—"} />
                    <Pair k="Contact" v={[l.contact_name, l.contact_phone].filter(Boolean).join(" · ") || "—"} />
                    <Pair k="Equipment" v={l.load_type ?? "—"} />
                    <Pair
                      k="Freight"
                      v={
                        [l.weight_lbs && `${l.weight_lbs.toLocaleString()} lbs`, l.pallets && `${l.pallets} plt`]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      }
                    />
                    <Pair k="Confidence" v={l.confidence.toFixed(2)} />
                  </dl>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="nums">{v}</dd>
    </>
  );
}

/* ----------------------------- message feed ------------------------------ */

function MessageFeed() {
  const [status, setStatus] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(api(`/api/admin/messages?${status ? `status=${status}` : ""}`));
    const json = await res.json();
    setMessages(json.messages ?? []);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function reprocess(id: number) {
    setBusyId(id);
    await fetch(api(`/api/admin/messages/${id}/reprocess`), { method: "POST" });
    setBusyId(null);
    load();
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className="chip cursor-pointer"
            style={
              status === s
                ? { background: "var(--accent)", color: "#fff" }
                : { background: "var(--surface-2)", color: "var(--muted)" }
            }
          >
            {s || "all"}
          </button>
        ))}
        <button className="btn ml-auto" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="card divide-y divide-[color:var(--border)]">
        {messages.map((m) => (
          <div key={m.id} className="flex gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  tone={
                    m.status === "done" ? "ok" : m.status === "error" ? "warn" : m.status === "pending" ? "accent" : "neutral"
                  }
                >
                  {m.status}
                </Chip>
                {m.load_count > 0 && <Chip tone="ok">{m.load_count} load{m.load_count === 1 ? "" : "s"}</Chip>}
                {m.skip_reason && <Chip tone="warn">{m.skip_reason}</Chip>}
                <span className="text-[11px] text-muted">
                  {m.author_name ?? "unknown"} · {m.group_name ?? "no group"} ·{" "}
                  {new Date(m.sent_at).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[13px]">{m.body}</p>
              {m.error && (
                <p className="mt-1 text-[12px]" style={{ color: "var(--danger)" }}>
                  {m.error} (attempt {m.attempts})
                </p>
              )}
              {m.extractor && <p className="mt-1 text-[11px] text-muted">{m.extractor}</p>}
            </div>
            <button className="btn shrink-0" onClick={() => reprocess(m.id)} disabled={busyId === m.id}>
              {busyId === m.id ? "…" : "Re-run"}
            </button>
          </div>
        ))}
        {!loading && messages.length === 0 && (
          <p className="p-6 text-center text-[13px] text-muted">No messages with that status.</p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- groups --------------------------------- */

function Groups({ groups }: { groups: Group[] }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2">Group</th>
            <th className="px-3 py-2 text-right">Messages</th>
            <th className="px-3 py-2 text-right">Loads</th>
            <th className="px-3 py-2 text-right">Yield</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id} className="border-b border-border">
              <td className="px-3 py-2 font-medium">{g.name}</td>
              <td className="nums px-3 py-2 text-right">{g.message_count}</td>
              <td className="nums px-3 py-2 text-right">{g.load_count}</td>
              <td className="nums px-3 py-2 text-right">
                {g.message_count ? `${Math.round((g.load_count / g.message_count) * 100)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border p-3 text-[12px] text-muted">
        Yield is loads per message. A group sitting near zero is either social chatter or is posting
        in a format the extractor is missing — worth reading a few of its skipped messages.
      </p>
    </div>
  );
}
