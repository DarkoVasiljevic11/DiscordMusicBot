const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('../config');

const PORT = 8888;
const REDIRECT_URI = config.spotify.redirectUri;

const TOKEN_FILE = path.join(process.cwd(), 'spotify-token.json');

const SCOPES = 'playlist-read-private';

// Generate the state ONCE when this process starts.
const state = crypto.randomBytes(32).toString('hex');

console.log('Spotify redirect URI:', REDIRECT_URI);
console.log('OAuth state:', state);

const authorizeUrl = new URL('https://accounts.spotify.com/authorize');

authorizeUrl.searchParams.set('client_id', config.spotify.clientId);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('scope', SCOPES);
authorizeUrl.searchParams.set('state', state);

console.log('\nOpen this URL in your browser:\n');
console.log(authorizeUrl.toString());
console.log('\nWaiting for Spotify callback...\n');

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url,
      `http://127.0.0.1:${PORT}`
    );

    if (requestUrl.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const returnedState = requestUrl.searchParams.get('state');
    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');

    console.log('Returned state:', returnedState);
    console.log('Expected state:', state);

    if (error) {
      res.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
      });

      res.end(`
        <h1>Spotify authorization failed</h1>
        <p>${error}</p>
      `);

      server.close();
      return;
    }

    if (!returnedState) {
      res.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
      });

      res.end(`
        <h1>Missing OAuth state</h1>
        <p>Spotify did not return a state parameter.</p>
      `);

      server.close();
      return;
    }

    if (returnedState !== state) {
      res.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
      });

      res.end(`
        <h1>Invalid auth state</h1>
        <p>The OAuth state returned by Spotify does not match.</p>
        <p>Close this page and run the authorization command again.</p>
      `);

      server.close();
      return;
    }

    if (!code) {
      res.writeHead(400, {
        'Content-Type': 'text/html; charset=utf-8',
      });

      res.end(`
        <h1>No authorization code</h1>
        <p>Spotify did not return an authorization code.</p>
      `);

      server.close();
      return;
    }

    console.log('State verified successfully.');
    console.log('Exchanging authorization code for tokens...');

    const credentials = Buffer.from(
      `${config.spotify.clientId}:${config.spotify.clientSecret}`
    ).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }).toString();

    const tokenResponse = await fetch(
      'https://accounts.spotify.com/api/token',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('Spotify token error:', tokenData);

      res.writeHead(500, {
        'Content-Type': 'text/html; charset=utf-8',
      });

      res.end(`
        <h1>Spotify token exchange failed</h1>
        <pre>${JSON.stringify(tokenData, null, 2)}</pre>
      `);

      server.close();
      return;
    }

    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(tokenData, null, 2),
      'utf8'
    );

    console.log('\nSpotify authorization successful!');
    console.log(`Token saved to: ${TOKEN_FILE}`);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
    });

    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Spotify Authorization</title>
        </head>
        <body>
          <h1>Spotify authorization successful!</h1>
          <p>You can close this browser tab.</p>
        </body>
      </html>
    `);

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 500);
  } catch (err) {
    console.error('Callback error:', err);

    res.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });

    res.end('Internal server error.');

    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OAuth callback server listening on ${REDIRECT_URI}`);
});