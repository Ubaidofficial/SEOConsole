import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/lib/server/db';

/** Two processes on one database file (old and new container during a deploy) wait for each other's write lock instead of failing. */
let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe('openDb', () => {
	it('waits up to 5 seconds for a busy database, on every connection to the same file', () => {
		dir = mkdtempSync(join(tmpdir(), 'osc-busy-'));
		const path = join(dir, 'app.db');
		const a = openDb(path);
		const b = openDb(path);
		try {
			expect(a.pragma('busy_timeout', { simple: true })).toBe(5000);
			expect(b.pragma('busy_timeout', { simple: true })).toBe(5000);
			expect(b.pragma('journal_mode', { simple: true })).toBe('wal');
		} finally {
			a.close();
			b.close();
		}
	});
});
