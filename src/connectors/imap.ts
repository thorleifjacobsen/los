// IMAP connector. Incremental: remembers the last UID per mailbox, so each sync only fetches new mail.
import { ImapFlow } from "imapflow";
import type { App } from "../app.js";
import type { SourceConfig } from "../config.js";
import { parseMail, type RawItem } from "../knowledge/extract.js";

export async function* imapConnector(app: App, src: SourceConfig): AsyncGenerator<RawItem> {
  const { db } = app;
  db.exec(`CREATE TABLE IF NOT EXISTS sync_state (source TEXT PRIMARY KEY, uid_validity TEXT, last_uid INTEGER)`);
  const user = process.env[src.user_env], pass = process.env[src.pass_env];
  if (!user || !pass) throw new Error(`${src.id}: set ${src.user_env} and ${src.pass_env}`);

  const client = new ImapFlow({ host: src.host, port: src.port ?? 993, secure: src.secure ?? true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(src.mailbox ?? "INBOX");
  try {
    const mailbox = client.mailbox as { uidValidity: bigint };
    const validity = String(mailbox.uidValidity);
    const state = db.prepare("SELECT * FROM sync_state WHERE source = ?").get(src.id) as any;
    const since = new Date(Date.now() - (src.since_days ?? 365) * 86_400_000);
    const criteria = state?.uid_validity === validity ? { uid: `${state.last_uid + 1}:*` } : { since };
    const uids = ((await client.search(criteria, { uid: true })) || []).filter((u) => !state || u > state.last_uid || state.uid_validity !== validity);

    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && msg.source) yield await parseMail(msg.source, `${src.mailbox ?? "INBOX"}:${uid}`);
      db.prepare("INSERT INTO sync_state (source, uid_validity, last_uid) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid")
        .run(src.id, validity, uid);
    }
  } finally {
    lock.release();
    await client.logout();
  }
}
