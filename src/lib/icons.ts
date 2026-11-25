/**
 * One icon per page, so a tab, the "More" menu, a page's header and its empty state all show the same picture. Icons come from
 * Lucide (bundled with the app; nothing is fetched). Source tabs (GA4, Bing, Tag Manager, Clarity, Web vitals) show the product's
 * own logo instead, see SRC_LOGO.
 */
import type { Component } from 'svelte';
import {
	Bell,
	Bot,
	ChartLine,
	Compass,
	FileText,
	FlaskConical,
	FolderTree,
	Gauge,
	Globe,
	HeartPulse,
	Layers,
	LayoutDashboard,
	Lightbulb,
	Link,
	ListChecks,
	Map as MapIcon,
	Plug,
	RadioTower,
	ScanSearch,
	Search,
	Send,
	Settings,
	Shapes,
	Sparkles,
	Stethoscope,
	Swords,
	Target,
	Telescope,
	TrendingDown,
	TrendingUp,
	UserCog,
	Users,
	Zap,
	FileCheck,
	Hand,
	Blocks,
	Megaphone,
	MousePointerClick,
	Tag,
	LayoutGrid
} from '@lucide/svelte';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Icon = Component<any>;

/** Site tabs by path under /sites/<id>. Every tab in SITE_TABS has one (a test checks it). */
export const TAB_ICON: Record<string, Icon> = {
	'': LayoutDashboard,
	'/dashboard': Blocks,
	'/insights': LayoutGrid,
	'/quickwins': Zap,
	'/actions': ListChecks,
	'/queries': Search,
	'/rank': Target,
	'/pages': FileText,
	'/trends': TrendingUp,
	'/groups': FolderTree,
	'/opportunities': Lightbulb,
	'/cannibalization': Swords,
	'/decay': TrendingDown,
	'/segments': Globe,
	'/types': Shapes,
	'/vitals': Gauge,
	'/alerts': Bell,
	'/tests': FlaskConical,
	'/submit': Send,
	'/request': Hand,
	'/indexing': FileCheck,
	'/indexnow': RadioTower,
	'/onpage': ScanSearch,
	'/diagnose': Stethoscope,
	'/health': HeartPulse,
	'/research': Telescope,
	'/links': Link,
	'/sitemaps': MapIcon,
	'/inspect': ScanSearch,
	'/bing': Search,
	'/analytics': ChartLine,
	'/tags': Tag,
	'/ai': Sparkles,
	'/clarity': MousePointerClick,
	'/settings': Settings
};

/** Top-level pages. */
export const PAGE_ICON: Record<string, Icon> = {
	'/': LayoutDashboard,
	'/chat': Sparkles,
	'/actions': ListChecks,
	'/alerts': Bell,
	'/portfolio': Layers,
	'/sitemaps': MapIcon,
	'/connect': Plug,
	'/agent': Compass,
	'/agents': Bot,
	'/accounts': Users,
	'/team': UserCog,
	'/digest': Megaphone,
	'/updates': ChartLine
};

/** The colour family of each "More" group and of the page headers under it, so a page's badge says where it lives. */
export const TAB_TONE: Record<string, string> = { Traffic: 'blue', Findings: 'amber', Indexing: 'green', Sources: 'violet', Site: 'gray' };
