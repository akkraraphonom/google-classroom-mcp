import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OAuth2Client } from 'google-auth-library';

const stateDirectory = join(process.env.LOCALAPPDATA || homedir(), 'GoogleClassroomMcp');
const sessionFile = join(stateDirectory, 'session.json');
const scopes = [
  'classroom.courses.readonly',
  'classroom.coursework.me.readonly',
  'classroom.courseworkmaterials.readonly',
  'classroom.announcements.readonly',
  'drive.readonly',
].map(name => `https://www.googleapis.com/auth/${name}`);
const courseworkScope = 'https://www.googleapis.com/auth/classroom.coursework.me.readonly';
const courseworkAlias = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';

export async function authorize(credentialsPath) {
  if (!credentialsPath) throw new Error('Usage: node login.mjs <path to Google Desktop OAuth client JSON>');
  const { installed } = JSON.parse(await readFile(credentialsPath, 'utf8'));
  if (!installed?.client_id || !installed.client_secret) throw new Error('Use a Google OAuth client of type Desktop app.');

  const client = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('base64url');

  let redirectUri;
  let timeout;
  const callback = createServer();
  const authorizationCode = new Promise((resolve, reject) => {
    callback.once('error', reject);
    callback.on('request', (request, response) => {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) {
        response.writeHead(400).end('Invalid OAuth callback.');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        response.writeHead(400).end('Google authorization did not complete.');
        reject(new Error('Google authorization did not complete. Check the browser and try again.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization received. Return to PowerShell to verify setup.');
      resolve(code);
    });
    callback.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${callback.address().port}/oauth2callback`;
      const url = client.generateAuthUrl({
        redirect_uri: redirectUri, access_type: 'offline', prompt: 'consent',
        scope: scopes, state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      });
      console.log('Open this URL in your browser and choose the Google account you use for Classroom:\n' + url);
    });
    timeout = setTimeout(() => reject(new Error('Google authorization timed out. Run login again.')), 5 * 60_000);
  });

  try {
    const code = await authorizationCode;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    const granted = new Set(tokens.scope ? tokens.scope.split(/\s+/) : scopes);
    const missing = scopes.filter(scope => !granted.has(scope) &&
      !(scope === courseworkScope && granted.has(courseworkAlias)));
    if (missing.length) {
      throw new Error(`Google did not grant: ${missing.map(scope => scope.split('/').at(-1)).join(', ')}. Select all requested permissions and try again.`);
    }
    if (!tokens.refresh_token) throw new Error('Google did not issue a refresh token. Run login again and confirm the consent screen.');
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const temporaryFile = join(stateDirectory, `session-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporaryFile, JSON.stringify({
        clientId: installed.client_id, clientSecret: installed.client_secret, refreshToken: tokens.refresh_token,
      }), { mode: 0o600, flag: 'wx' });
      await rename(temporaryFile, sessionFile);
    } finally {
      await rm(temporaryFile, { force: true });
    }
    console.log('Google authorization saved for the local Classroom MCP.');
  } finally {
    clearTimeout(timeout);
    callback.close();
  }
}

let authorization;
export async function googleRead(url, headers) {
  if (!authorization) {
    try {
      const session = JSON.parse(await readFile(sessionFile, 'utf8'));
      authorization = new OAuth2Client({ clientId: session.clientId, clientSecret: session.clientSecret });
      authorization.setCredentials({ refresh_token: session.refreshToken });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Google account is not connected. Follow README.md and run node login.mjs first.');
      throw error;
    }
  }
  let token;
  try {
    ({ token } = await authorization.getAccessToken());
  } catch (error) {
    if (error.response?.data?.error === 'invalid_grant') throw new Error('Google authorization expired or was revoked. Run node login.mjs again and restart Codex.');
    throw new Error('Could not refresh Google authorization. Verify connectivity and try signing in again.');
  }
  return fetch(url, {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(90_000),
  });
}
