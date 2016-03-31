#!/usr/bin/env node

// Wikipedia telnet server
//
// To install dependencies:
// npm install mw-ocg-texter

var fs = require('fs');
var net = require( 'net' );
var path = require( 'path' );

var texter = require('mw-ocg-texter/lib/standalone');

var port = parseInt(process.argv[2]) || 1081;

var domain = 'en.wikipedia.org';
var ps1 = '\n>>> ';

// Cache siteinfo requests for some extra efficiency.
var cachedSiteinfo = Object.create(null);
var siteinfoCacher = function(bundler, wikis, log) {
	var key = '$' + wikis.map( function( w ) { return w.baseurl; } ).join( '|' );
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
var logoP = (function() {
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
	return fs.readFileSync( path.join( __dirname, 'wiki-logo.txt' ) );
});

function recv( socket, data ) {
	data = data.toString().replace( /(\r\n?|\n)/gm, '' );

	var m = /^(host|use)\s+(\S+\.org)\s*$/i.exec( data );
	if (m) {
		domain = m[2];
		socket.write( 'Using '+domain+' for future articles.\n' );
		socket.write( ps1 );
		return;
	}

	if ( data === 'quit' ) {
		socket.end( 'Bye!\n' );
		return;
	}

	texter.convert({
		domain: domain,
		title: data,
		stream: socket,
		// siteinfo cacher is optional, but it speeds things up
		// by eliminating an unnecessary action API request for each article
		siteinfo: siteinfoCacher,
	}).catch(function( e ) {
		socket.write( 'Error: ' + String( e ).trim() + '\n' );
	}).then(function() { socket.write( ps1 ); });
}

console.log('Listening on port', port);
net.createServer( function ( socket ) {
	logoP.then( function( logo ) {
		socket.write( logo );
		socket.write( ps1 );
		socket.on( 'data', recv.bind( null, socket ) );
	} );
} ).listen( port );
