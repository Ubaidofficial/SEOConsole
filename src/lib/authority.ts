/**
 * Colour bands for the 0 to 100 authority scores (Ahrefs Domain Rating, Moz Domain Authority): higher is better, so red is low, orange is
 * in the middle and green is high. Neither Ahrefs nor Moz publishes bands like these: they are this app's own, chosen so most new sites
 * read red and an established one reads green. Change them here and the circles, tooltips, the legend and the tests all follow.
 */
export const ORANGE_FROM = 30;
export const GREEN_FROM = 60;

export type AuthorityBand = 'low' | 'medium' | 'high';
export const authorityBand = (value: number): AuthorityBand => (value >= GREEN_FROM ? 'high' : value >= ORANGE_FROM ? 'medium' : 'low');

/** The theme's own red, amber and green, so dark mode follows. */
export const BAND_COLOR: Record<AuthorityBand, string> = { low: 'var(--bad)', medium: 'var(--warn)', high: 'var(--good)' };
export const BAND_NAME: Record<AuthorityBand, string> = { low: 'red', medium: 'orange', high: 'green' };

export const BANDS_TEXT = `red under ${ORANGE_FROM}, orange ${ORANGE_FROM} to ${GREEN_FROM - 1}, green ${GREEN_FROM} or more`;
