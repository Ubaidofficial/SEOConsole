import { db } from './db';
import { decrypt, encrypt } from './crypto';

export type LinkKind = 'bing' | 'ga4' | 'gtm' | 'clarity' | 'openseo';

export interface IntegrationRow { id: number; kind: string; label: string; secret_enc: string | null; meta: string; status: string; is_demo: number; created_at: number }
export interface LinkRow {
	site_id: number; kind: LinkKind; integration_id: number | null; account_id: number | null;
	external_id: string; label: string | null; last_sync_at: number | null; sync_status: string; sync_message: string | null; created_at: number;
}

export function saveIntegration(kind: string, label: string, secret: object, meta: object = {}, isDemo = false): number {
	return Number(
		db()
			.prepare('INSERT INTO integrations (kind, label, secret_enc, meta, is_demo, created_at) VALUES (?,?,?,?,?,?)')
			.run(kind, label, encrypt(JSON.stringify(secret)), JSON.stringify(meta), isDemo ? 1 : 0, Date.now()).lastInsertRowid
	);
}

export const getIntegration = (id: number) => db().prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined;
export const listIntegrations = (kind: string) => db().prepare('SELECT * FROM integrations WHERE kind = ? ORDER BY id').all(kind) as IntegrationRow[];
export const removeIntegration = (id: number) => void db().prepare('DELETE FROM integrations WHERE id = ?').run(id);
export const integrationMeta = (i: IntegrationRow) => JSON.parse(i.meta) as Record<string, string>;
export const integrationSecret = <T = Record<string, string>>(i: IntegrationRow) => (i.secret_enc ? (JSON.parse(decrypt(i.secret_enc)) as T) : ({} as T));

export function setLink(siteId: number, kind: LinkKind, o: { integrationId?: number | null; accountId?: number | null; externalId: string; label?: string | null }) {
	db()
		.prepare(
			`INSERT INTO site_links (site_id, kind, integration_id, account_id, external_id, label, created_at) VALUES (?,?,?,?,?,?,?)
			 ON CONFLICT(site_id, kind) DO UPDATE SET integration_id = excluded.integration_id, account_id = excluded.account_id,
			   external_id = excluded.external_id, label = excluded.label, sync_status = 'idle', sync_message = NULL`
		)
		.run(siteId, kind, o.integrationId ?? null, o.accountId ?? null, o.externalId, o.label ?? null, Date.now());
	// Linked now (by hand or automatically): an earlier "leave it alone" and any pending choice no longer apply.
	db().prepare('DELETE FROM link_skips WHERE site_id = ? AND kind = ?').run(siteId, kind);
	db().prepare('DELETE FROM link_candidates WHERE site_id = ? AND kind = ?').run(siteId, kind);
}

export const removeLink = (siteId: number, kind: LinkKind) => void db().prepare('DELETE FROM site_links WHERE site_id = ? AND kind = ?').run(siteId, kind);

/** Unlinked on purpose: automatic matching (on connect, nightly, after Sync all) will not link this source for the site again. Linking by hand undoes it. */
export const skipAutoLink = (siteId: number, kind: LinkKind) => void db().prepare('INSERT OR REPLACE INTO link_skips VALUES (?,?,?)').run(siteId, kind, Date.now());

/** May automatic matching link this source for this site? Not when it is already linked or someone unlinked it on purpose. */
export const autoLinkable = (siteId: number, kind: LinkKind) =>
	!db().prepare('SELECT 1 FROM site_links WHERE site_id = ? AND kind = ?').get(siteId, kind) && !db().prepare('SELECT 1 FROM link_skips WHERE site_id = ? AND kind = ?').get(siteId, kind);

export interface LinkCandidate { site_id: number; kind: 'ga4' | 'gtm'; external_id: string; label: string | null; account_id: number | null }

/** Replace the choices offered for a site and source (an empty list clears them). */
export function saveCandidates(siteId: number, kind: 'ga4' | 'gtm', list: { externalId: string; label: string | null; accountId: number | null }[]) {
	const d = db();
	d.transaction(() => {
		d.prepare('DELETE FROM link_candidates WHERE site_id = ? AND kind = ?').run(siteId, kind);
		const ins = d.prepare('INSERT OR IGNORE INTO link_candidates VALUES (?,?,?,?,?,?)');
		for (const c of list) ins.run(siteId, kind, c.externalId, c.label, c.accountId, Date.now());
	})();
}

export const allCandidates = () => db().prepare('SELECT site_id, kind, external_id, label, account_id FROM link_candidates ORDER BY site_id, kind, label').all() as LinkCandidate[];

export function linksFor(siteId: number): Partial<Record<LinkKind, LinkRow>> {
	const rows = db().prepare('SELECT * FROM site_links WHERE site_id = ?').all(siteId) as LinkRow[];
	return Object.fromEntries(rows.map((r) => [r.kind, r]));
}

export const allLinks = () => db().prepare('SELECT * FROM site_links').all() as LinkRow[];

export function markLink(siteId: number, kind: LinkKind, status: 'idle' | 'running' | 'error' | 'queued', message: string | null = null, done = false) {
	db()
		.prepare('UPDATE site_links SET sync_status = ?, sync_message = ?, last_sync_at = CASE WHEN ? THEN ? ELSE last_sync_at END WHERE site_id = ? AND kind = ?')
		.run(status, message, done ? 1 : 0, Date.now(), siteId, kind);
}
