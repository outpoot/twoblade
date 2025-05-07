import { fail, redirect } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import type { Actions } from './$types';
import { sql } from '$lib/server/db';
import { createAuthJWT, storeCode } from '$lib/server/jwt';

export type ActionData = {
    success?: boolean;
    error?: string;
    username?: string;
};

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress, request: { headers } }) => {
        const data = await request.formData();
        const username = data.get('username');
        const password = data.get('password');

        if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
            return fail(400, { success: false, error: 'Invalid input.', username: username?.toString() });
        }

        try {
            const users = await sql`
                SELECT id, username, password_hash, is_banned, iq
                FROM users
                WHERE username = ${username}
            `;

            const user = users[0];

            if (!user) {
                return fail(400, { success: false, error: 'Invalid username or password.', username });
            }

            if (user.is_banned) {
                 return fail(403, { success: false, error: 'Your account is banned.', username });
            }

            if (user.password_hash === 'DELETED_ACCOUNT') {
                return fail(400, { success: false, error: 'Invalid username or password.', username });
            }

            const passwordMatch = await bcrypt.compare(password, user.password_hash);

            if (!passwordMatch) {
                return fail(400, { success: false, error: 'Invalid username or password.', username });
            }

            const { token, code } = await createAuthJWT({ userId: user.id });

            const ip = getClientAddress();
            const userAgent = headers.get('user-agent') ?? undefined;
            await storeCode(user.id, code, ip, userAgent);

            cookies.set('auth_token', token, {
                path: '/',
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'none',
                maxAge: 60 * 60 * 24 * 7
            });

            throw redirect(303, '/inbox');
        } catch (error: any) {
             if (error.status && error.status >= 300 && error.status < 400) {
                 throw error;
             }
            console.error('Login error:', error);

            if (error.message === 'User is banned and cannot create a new token.') {
                 return fail(403, { success: false, error: 'Your account is banned.', username });
            }
            return fail(500, { success: false, error: 'Internal server error. Please try again later.', username });
        }
    }
};
