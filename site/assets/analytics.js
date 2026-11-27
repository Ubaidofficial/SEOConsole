// Google Tag Manager for seoconsole.app, loaded from this file because the page's policy (script-src 'self') blocks inline scripts.
// The container ID comes from <meta name="gtm-id"> in index.html. While it is empty, or not a GTM-… ID, nothing is loaded.
// Visitors whose browser sends Global Privacy Control are not tracked.
(function () {
	var meta = document.querySelector('meta[name="gtm-id"]');
	var id = meta ? meta.getAttribute('content') : '';
	if (!id || !/^GTM-[A-Z0-9]{4,12}$/.test(id)) return;
	if (navigator.globalPrivacyControl === true) return;
	window.dataLayer = window.dataLayer || [];
	window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
	var s = document.createElement('script');
	s.async = true;
	s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id);
	document.head.appendChild(s);
})();
