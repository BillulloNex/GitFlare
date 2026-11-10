import { Hono } from 'hono';
import type { Env, UserRecord } from '../env.ts';
import { createSession, validateSession, deleteSession } from '../lib/session.ts';

const app = new Hono<{ Bindings: Env }>();

type UserRole = UserRecord['role'];

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, user: 2, admin: 3 };

/** Parse a comma-separated env list into lowercase, trimmed, non-empty entries. */
function parseList(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
}

/** Lowercased domain part of an email (after the last '@'), or '' if malformed. */
function emailDomain(email: string): string {
    const at = email.lastIndexOf('@');
    return at > 0 ? email.slice(at + 1).toLowerCase() : '';
}

type LoginDecision = { allowed: false; error: string } | { allowed: true; role: UserRole };

/**
 * Login policy. Runs on EVERY login, for existing and new users alike,
 * BEFORE the user row is created or updated. Order matters:
 *
 *   1. verified email  — unverified emails are rejected outright, so an
 *                        unverified address can never match ADMIN_EMAILS
 *                        or ALLOWED_DOMAINS.
 *   2. ALLOWED_DOMAINS — when set, non-matching domains are rejected.
 *   3. ADMIN_EMAILS    — matching emails get `admin`.
 *   4. otherwise       — `user` if ALLOWED_DOMAINS is set (and matched),
 *                        `viewer` (read-only) if it is unset.
 */
function decideLogin(env: Env, email: string, verified: boolean): LoginDecision {
    if (!verified || !email) {
        return { allowed: false, error: 'email_not_verified' };
    }

    const normalized = email.trim().toLowerCase();
    const allowedDomains = parseList(env.ALLOWED_DOMAINS);
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain(normalized))) {
        return { allowed: false, error: 'domain_not_allowed' };
    }

    if (parseList(env.ADMIN_EMAILS).includes(normalized)) {
        return { allowed: true, role: 'admin' };
    }

    return { allowed: true, role: allowedDomains.length > 0 ? 'user' : 'viewer' };
}

/**
 * Login never demotes: an existing user keeps a higher role (e.g. one granted
 * manually), but is promoted if policy now grants more (ADMIN_EMAILS, or a
 * domain newly added to ALLOWED_DOMAINS). Bulk downgrades are done in SQL —
 * see scripts/1h-downgrade.sql. Unknown stored roles are replaced.
 */
function effectiveRole(existing: string | null | undefined, granted: UserRole): UserRole {
    const current = existing && Object.hasOwn(ROLE_RANK, existing) ? (existing as UserRole) : null;
    return current && ROLE_RANK[current] > ROLE_RANK[granted] ? current : granted;
}

// ─── Google OAuth: Start ────────────────────────────────────────
app.get('/login', (c) => {
    const state = crypto.randomUUID();
    const redirectUri = `${c.env.APP_URL}/api/auth/callback`;
    const returnToStation = c.req.query('next') === '/station';

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
        headers: [
            ['Location', `https://accounts.google.com/o/oauth2/v2/auth?${params}`],
            ['Set-Cookie', stateCookie],
            ['Set-Cookie', returnToStation
                ? 'gf_oauth_next=station; Path=/; HttpOnly; SameSite=Lax; Max-Age=600'
                : 'gf_oauth_next=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'],
        ],
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
        verified_email?: boolean;
        name: string;
        picture?: string;
    }>();

    // ── Login policy: runs before ANY user write, for existing and new users ──
    const decision = decideLogin(c.env, googleUser.email ?? '', googleUser.verified_email === true);
    if (!decision.allowed) {
        console.warn(`Login rejected (${decision.error}) for ${googleUser.email}`);
        return c.redirect(`${c.env.APP_URL}/?error=${decision.error}`);
    }

    // Upsert user
    let user = await c.env.DB.prepare(
        'SELECT * FROM users WHERE google_id = ?'
    ).bind(googleUser.id).first<UserRecord>();

    if (user) {
        const role = effectiveRole(user.role, decision.role);
        // Update profile info (and role, if policy changed it) on each login
        await c.env.DB.prepare(
            `UPDATE users SET name = ?, avatar_url = ?, email = ?, role = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(googleUser.name, googleUser.picture ?? null, googleUser.email, role, user.id).run();
        user = { ...user, role };
    } else {
        // Create new user
        const userId = crypto.randomUUID();
        const role = decision.role;
        await c.env.DB.prepare(
            `INSERT INTO users (id, google_id, email, name, avatar_url, role)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(userId, googleUser.id, googleUser.email, googleUser.name, googleUser.picture ?? null, role).run();

        user = {
            id: userId,
            google_id: googleUser.id,
            email: googleUser.email,
            name: googleUser.name,
            avatar_url: googleUser.picture ?? null,
            role,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
    }

    // Create session
    const sessionCookie = await createSession(c.env.DB, user.id, c.env.APP_URL);
    // Clear the OAuth state cookie
    const clearStateCookie = 'gf_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    const clearNextCookie = 'gf_oauth_next=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    const nextPath = parseCookieValue(cookieHeader, 'gf_oauth_next') === 'station' ? '/station' : '/';

    return new Response(null, {
        status: 302,
        headers: [
            ['Location', c.env.APP_URL + nextPath],
            ['Set-Cookie', sessionCookie],
            ['Set-Cookie', clearStateCookie],
            ['Set-Cookie', clearNextCookie],
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
