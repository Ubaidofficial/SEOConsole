import { describe, expect, it } from 'vitest';
import { healthScore } from '../src/lib/health';
import { splitFollowUps } from '../src/lib/chat';
import type { ActionItem } from '../src/lib/actions';

const item = (type: ActionItem['type'], blocking = false, impact: number | null = null) => ({ type, title: type, blocking, impact, href: '/x' });

describe('technical health score', () => {
	it('is 100 with no technical findings; content opportunities do not count', () => {
		expect(healthScore([item('striking', false, 500), item('decay', false, 80)]).score).toBe(100);
	});
	it('takes 20 per blocking finding and about 4 per other, more when clicks are at stake', () => {
		const h = healthScore([item('blocked', true), item('sitemap'), item('onpage', false, 999)]);
		expect(h.findings[0]).toMatchObject({ type: 'blocked', penalty: 20 });
		expect(h.findings.find((f) => f.type === 'sitemap')!.penalty).toBe(4);
		expect(h.findings.find((f) => f.type === 'onpage')!.penalty).toBeGreaterThan(4);
		expect(h.score).toBe(Math.round(100 - 20 - 4 - h.findings.find((f) => f.type === 'onpage')!.penalty));
		expect(h.grade).toBe('poor'); // 100 - 20 - 4 - 8 = 68
	});
	it('never goes below 0', () => expect(healthScore(Array.from({ length: 8 }, () => item('deindexed', true))).score).toBe(0));
});

describe('follow-up suggestions', () => {
	it('takes the last Follow-ups line off the answer and splits it', () => {
		const r = splitFollowUps('Clicks fell 12%.\n\nFollow-ups: Which pages lost the most? | Chart it by week | What should I fix first?');
		expect(r.body).toBe('Clicks fell 12%.');
		expect(r.followUps).toEqual(['Which pages lost the most?', 'Chart it by week', 'What should I fix first?']);
	});
	it('accepts bold and a singular label; leaves text without one alone; keeps at most three', () => {
		expect(splitFollowUps('x\n**Follow-up:** a b c | d e f').followUps).toEqual(['a b c', 'd e f']);
		expect(splitFollowUps('No suggestions here.')).toEqual({ body: 'No suggestions here.', followUps: [] });
		expect(splitFollowUps('y\nFollow-ups: one1 | two2 | three | four4').followUps).toHaveLength(3);
	});
	it('a "Follow-ups:" in the middle of an answer is not taken', () => {
		const t = 'Follow-ups: later\nThe real answer continues here.';
		expect(splitFollowUps(t).followUps).toEqual([]);
	});
});

describe('content brief topic words', () => {
	it('drops years and the words that describe the whole site', async () => {
		const { topicWords, mainWords } = await import('../src/lib/server/brief');
		const site = [...Array.from({ length: 30 }, (_, i) => `topic${i} books 2024`), 'sailing books', 'best sailing books', 'cryptography books 2024', 'leadership books', ...Array.from({ length: 10 }, (_, i) => `misc${i} novel`)];
		expect(topicWords(mainWords('sailing books 2024'), site)).toEqual(['sailing']);
		expect(topicWords(mainWords('sailing books 2024'), ['a', 'b'])).toEqual(['sailing', 'book']); // too few searches to judge "book"
	});
});
