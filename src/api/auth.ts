import { Hono } from 'hono';
import type { Env, UserRecord } from '../env.ts';
import { createSession, validateSession, deleteSession } from '../lib/session.ts';

const app = new Hono<{ Bindings: Env }>();

// ─── Google OAuth: Start ────────────────────────────────────────
app.get('/login', (c) => {
    const state = crypto.randomUUID();
    const redirectUri = `${c.env.APP_URL}/api/auth/callback`;

    const params = new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
    });

    // Store state in a short-lived cookie for CSRF protection
    const stateCookie = `gf_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;

    return new Response(null, {
        status: 302,
        headers: {
            Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
            'Set-Cookie': stateCookie,
        },
    });
});

// ─── Google OAuth: Callback ─────────────────────────────────────
app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
        return c.redirect(`${c.env.APP_URL}/?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
        return c.redirect(`${c.env.APP_URL}/?error=missing_params`);
    }

    // Verify CSRF state
    const cookieHeader = c.req.header('Cookie') ?? '';
    const storedState = parseCookieValue(cookieHeader, 'gf_oauth_state');
    if (state !== storedState) {
        return c.redirect(`${c.env.APP_URL}/?error=invalid_state`);
    }

    // Exchange code for tokens
    const redirectUri = `${c.env.APP_URL}/api/auth/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: c.env.GOOGLE_CLIENT_ID,
            client_secret: c.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    });

    if (!tokenRes.ok) {
        console.error('Token exchange failed:', await tokenRes.text());
        return c.redirect(`${c.env.APP_URL}/?error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json<{ id_token?: string; access_token?: string }>();

    // Get user info from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoRes.ok) {
        return c.redirect(`${c.env.APP_URL}/?error=userinfo_failed`);
    }

    const googleUser = await userInfoRes.json<{
        id: string;
        email: string;
        name: string;
        picture?: string;
    }>();

    // Upsert user
    let user = await c.env.DB.prepare(
        'SELECT * FROM users WHERE google_id = ?'
    ).bind(googleUser.id).first<UserRecord>();

    if (user) {
        // Update profile info on each login
        await c.env.DB.prepare(
            `UPDATE users SET name = ?, avatar_url = ?, email = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(googleUser.name, googleUser.picture ?? null, googleUser.email, user.id).run();
    } else {
        // Create new user
        const userId = crypto.randomUUID();
        await c.env.DB.prepare(
            `INSERT INTO users (id, google_id, email, name, avatar_url, role)
             VALUES (?, ?, ?, ?, ?, 'user')`
        ).bind(userId, googleUser.id, googleUser.email, googleUser.name, googleUser.picture ?? null).run();

        user = {
            id: userId,
            google_id: googleUser.id,
            email: googleUser.email,
            name: googleUser.name,
            avatar_url: googleUser.picture ?? null,
            role: 'user',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
    }

    // Create session
    const sessionCookie = await createSession(c.env.DB, user.id, c.env.APP_URL);
    // Clear the OAuth state cookie
    const clearStateCookie = 'gf_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

    return new Response(null, {
        status: 302,
        headers: [
            ['Location', c.env.APP_URL + '/'],
            ['Set-Cookie', sessionCookie],
            ['Set-Cookie', clearStateCookie],
        ],
    });
});

// ─── Logout ─────────────────────────────────────────────────────
app.post('/logout', async (c) => {
    const clearCookie = await deleteSession(c.env.DB, c.req.header('Cookie'));
    return c.json({ ok: true }, 200, { 'Set-Cookie': clearCookie });
});

// ─── Current User ───────────────────────────────────────────────
app.get('/me', async (c) => {
    const user = await validateSession(c.env.DB, c.req.header('Cookie'));
    if (!user) {
        return c.json({ authenticated: false }, 401);
    }
    return c.json({
        authenticated: true,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatar_url: user.avatar_url,
            role: user.role,
        },
    });
});

/** Parse a single cookie value. */
function parseCookieValue(header: string, name: string): string | null {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? match[1] : null;
}

export default app;
