#!/usr/bin/env node

// Wikipedia telnet server
//
// To install dependencies:
// npm install mw-ocg-texter

var Promise = require('babybird');

var fs = require('fs');
var path = require('path');
var querystring = require('querystring');
var readline = require('readline');
var request = require('request');
var telnet = require('telnet');

var texter = require('mw-ocg-texter/lib/standalone');

var port = parseInt(process.argv[2]) || 1081;

var domain = 'en.wikipedia.org';
var separator = '\x1b[46;1m\x1b[K\n\x1b[44;1m\x1b[K\n\x1b[0m\x1b[K';
var ps1 = '>>> ';

// Cache siteinfo requests for some extra efficiency.
var cachedSiteinfo = Object.create(null);
var siteinfoCacher = function(bundler, wikis, log) {
	var key = '$' + wikis.map(function(w) { return w.baseurl; } ).join('|');
	if (!cachedSiteinfo[key]) {
		cachedSiteinfo[key] = new bundler.siteinfo(
			wikis,
			function () { /* don't log request retries */ }
		);
	}
	return cachedSiteinfo[key];
};

// Attempt to render welcome message from :en:User:cscott/Telnet,
// but fall back to the contents of wiki-logo.txt if there is a
// problem.
var getLogoP = function() {
	return (function() {
		console.log('Fetching logo...');
		var cachedLogo = '';
		return texter.convert({
			domain: 'en.wikipedia.org',
			title: 'User:cscott/Telnet',
			siteinfo: siteinfoCacher,
			stream: {
				write: function(chunk, cb) {
					cachedLogo += chunk.toString();
					return cb();
				}
			}
		}).then(function() {
			// Remove initial "title" line from output.
			return cachedLogo.replace(/^\S+[\n\r]+/, '');
		});
	})().catch(function() {
		return fs.readFileSync(path.join(__dirname, 'wiki-logo.txt'));
	});
};
var logoP = getLogoP();
// Refresh this every six hours.
setInterval(function() { logoP = getLogoP(); }, 6*60*60*1000 );

var tabCompleteQuery = function(domain, search_term) {
	var apiURL = 'https://' + domain + '/w/api.php';
	var queryobj = {
		action: 'query',
		format: 'json',
		prop: 'pageprops',
		generator: 'prefixsearch',
		ppprop: 'displaytitle',
		gpssearch: search_term,
		gpsnamespace: 0,
		gpslimit: 6
	};
	apiURL += '?' + querystring.stringify(queryobj);
	var user = process.env.USER || process.env.LOGNAME || process.env.HOME ||
		'unknown';
	return new Promise(function(resolve, reject) {
		request({
			url: apiURL,
			encoding: 'utf8',
			headers: {
				'User-Agent': 'wikipedia-telnet/1.0.0/' + user
			},
			pool: false
		}, function(error, response, body) {
			if (error || response.statusCode !== 200) {
				return reject(error || new Error("Unexpected HTTP status: " + response.statusCode));
			}
			return resolve(body);
		});
	}).then(function(body) { return JSON.parse(body); });
};

function completer(linePartial, callback) {
	var basicCmds = 'quit|use en.wikipedia.org|use es.wikipedia.org|use ja.wikipedia.org|use de.wikipedia.org|use ru.wikipedia.org|use fr.wikipedia.org|use it.wikipedia.org|use pt.wikipedia.org|use zh.wikipedia.org|use pl.wikipedia.org'.split('|');
	var hits = basicCmds.filter(function(c) {
		return c.slice(0, linePartial.length) === linePartial;
	});
	// Also do an API query with the title suggester:
	//return callback(null,  [hits.length ? hits : basicCmds, linePartial]);
	tabCompleteQuery(domain, linePartial).then(function(resp) {
		var result = [];
		Object.keys(resp.query.pages).forEach(function(pageid) {
			var page = resp.query.pages[pageid];
			result[page.index - 1] = page.title;
		});
		hits = hits.concat(result);
	}, function(e) { /* some error occurred, ignore it. */ }).then(function() {
		callback(null, [hits.length ? hits : basicCmds, linePartial]);
	});
}

function recv(rl, client, line) {
	rl.pause();
	line = line.trim();

	var m = /^(host|use)\s+(\S+\.org)$/i.exec(line);
	if (m) {
		domain = m[2];
		client.write('Using '+domain+' for future articles.\n');
		rl.prompt();
		return;
	}

	if (line === 'quit') {
		client.write('Bye!\n');
		rl.close();
		return;
	}

	texter.convert({
		domain: domain,
		title: line,
		stream: client,
		// siteinfo cacher is optional, but it speeds things up
		// by eliminating an unnecessary action API request for each article
		siteinfo: siteinfoCacher,
	}).catch(function(e) {
		client.write('Sorry! Could not fetch "' + line + '" for you.\n' +
					 'No worries. There are lots of other pages to read.\n' +
					 'Pick a different title.\n');
	}).then(function() {
		client.write(separator);
		rl.prompt();
	});
}

var server = telnet.createServer(function (client) {
	client.on('window size', function(e) {
		if (e.command === 'sb') {
			// A real "resize" event; readline listens for this.
			client.columns = e.columns;
			client.rows = e.rows;
			client.emit('resize');
		}
	});
	// 'readline' will call `setRawMode` when it is a function
	client.setRawMode = setRawMode;
	// Make unicode characters work properly
	client.do.transmit_binary();
	// Make the client emit 'window size' events
	client.do.window_size();

	// Create a read line interface.
	var rl = readline.createInterface({
		input: client,
		output: client,
		terminal: true,
		completer: completer
	});
	rl.setPrompt(ps1); rl.pause();
	rl.on('close', function() { client.end(); });

	logoP.then(function(logo) {
		client.write(logo);
		rl.prompt();
		rl.on('line', recv.bind(null, rl, client));
	} );
});

server.on('error', function (err) {
	if (err.code === 'EACCES') {
		console.error(
			'%s: You must be "root" to bind to port %d', err.code, port
		);
	} else {
		throw err;
	}
});

server.on('listening', function () {
	console.log(
		'wikipedia telnet server listening on port %d', this.address().port
	);
	console.log('  $ telnet localhost' + (port != 23 ? ' ' + port : ''));
});

server.listen(port);

/**
 * The equivalent of "raw mode" via telnet option commands.
 * Set this function on a telnet `client` instance.
 */

function setRawMode (mode) {
	if (mode) {
		this.do.suppress_go_ahead();
		this.will.suppress_go_ahead();
		this.will.echo();
	} else {
		this.dont.suppress_go_ahead();
		this.wont.suppress_go_ahead();
		this.wont.echo();
	}
}
