import { Server } from 'socket.io';
import { jwtVerify } from 'jose';
import postgres from 'postgres';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { checkHardcore } from './moderation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../../website/.env') });

function checkVocabulary(text: string, iq: number): { isValid: boolean; limit: number | null } {
    let maxWordLength: number;

    if (iq < 90) maxWordLength = 3;
    else if (iq < 100) maxWordLength = 4;
    else if (iq < 120) maxWordLength = 5;
    else if (iq < 130) maxWordLength = 6;
    else if (iq < 140) maxWordLength = 7;
    else return { isValid: true, limit: null };

    const words = text.split(/\s+/);
    for (const word of words) {
        const cleanedWord = word.replace(/[.,!?;:"']/g, '');
        if (cleanedWord.length > maxWordLength) {
            return { isValid: false, limit: maxWordLength };
        }
    }
    return { isValid: true, limit: maxWordLength };
}

const RATE_LIMIT = {
    messages: 3,
    window: 2000
};

interface User {
    id: number;
    username: string;
    domain: string;
    iq: number;
    is_banned: boolean;
    is_admin?: boolean;
}

interface UserSecretCode {
    user_id: number;
}

const JWT_SECRET = process.env.JWT_SECRET!;
const DATABASE_URL = process.env.DATABASE_URL!;
const PORT = process.env.WS_PORT || 8080;

const sql = postgres(DATABASE_URL);

const secret = new TextEncoder().encode(JWT_SECRET);
const alg = 'HS256';

const messages: Array<{
    id: string;
    text: string;
    fromUser: string;
    fromIQ: number;
    timestamp: string;
}> = [];

const bannedUserIds = new Set<number>();

const io = new Server({
    cors: {
        origin: [`https://${process.env.PUBLIC_DOMAIN}`, "http://localhost:5173"],
        credentials: true
    }
});

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
        const { payload } = await jwtVerify(token, secret, { algorithms: [alg] });

        const codes = await sql<UserSecretCode[]>`
            SELECT user_id FROM user_secret_codes 
            WHERE code = ${payload.code as string}
        `;

        if (codes.length === 0) {
            console.warn(`JWT verification failed: Code ${payload.code} not found`);
            return next(new Error('Invalid authentication'));
        }

        const users = await sql<User[]>`
            SELECT id, username, domain, iq, is_admin, is_banned
            FROM users 
            WHERE id = ${payload.userId as number}
        `;

        const user = users[0];
        if (!user) {
            return next(new Error('User not found'));
        }

        if (user.is_banned) {
            bannedUserIds.add(user.id);
            await sql`
                 DELETE FROM user_secret_codes 
                 WHERE code = ${payload.code as string}
             `;
            return next(new Error('User is banned'));
        } else {
            if (bannedUserIds.has(user.id)) {
                console.log(`User ${user.id} is no longer banned, removing from bannedUserIds set.`);
                bannedUserIds.delete(user.id);
            }
        }

        socket.data.user = user;
        next();
    } catch (error) {
        console.error('Socket auth error:', error);
        next(new Error('Authentication failed'));
    }
});

const userMessageTimestamps: Map<number, number[]> = new Map();
let connectedUsers = new Set();

io.on('connection', (socket) => {
    const user = socket.data.user as User;
    connectedUsers.add(user.id);

    io.emit('users_count', connectedUsers.size);

    console.log(`User connected: ${user.username}#${user.domain}`);

    socket.emit('recent_messages', messages.slice(-200));

    socket.on('message', async (text: string) => {
        if (bannedUserIds.has(user.id)) {
            socket.emit('error', { message: 'You are banned from sending messages.' });
            socket.disconnect(true);
            return;
        }
        const trimtext = text?.trim().slice(0, 2000);
        if (!trimtext) return;

        if (checkHardcore(trimtext)) {
            socket.emit('error', {
                message: 'Your message was blocked due to inappropriate content.'
            });
            return;
        }

        const now = Date.now();
        const userTimestamps = userMessageTimestamps.get(user.id) || [];
        const recentMessages = userTimestamps.filter(ts => now - ts < RATE_LIMIT.window);

        if (recentMessages.length >= RATE_LIMIT.messages) {
            socket.emit('error', {
                message: `You're sending messages too quickly. Please wait ${RATE_LIMIT.window / 1000} seconds.`
            });
            return;
        }

        userTimestamps.push(now);
        userMessageTimestamps.set(user.id, userTimestamps);

        const { isValid, limit } = checkVocabulary(text, user.iq);
        if (!isValid) {
            socket.emit('error', {
                message: `Message contains words longer than your ${limit}-character limit.`
            });
            return;
        }

        const message = {
            id: crypto.randomUUID(),
            text,
            fromUser: `${user.username}#${user.domain}`,
            fromIQ: user.iq,
            timestamp: new Date().toISOString()
        };

        messages.push(message);
        if (messages.length > 200) messages.shift();

        io.emit('message', message);
    });

    socket.on('ban_user', async (userIdentifier: string) => {
        const adminUser = socket.data.user as User;
        if (!adminUser.is_admin) return;

        const adminIdentifier = `${adminUser.username}#${adminUser.domain}`;
        if (userIdentifier === adminIdentifier) {
            socket.emit('error', { message: 'You cannot ban yourself.' });
            return;
        }

        const [username, domain] = userIdentifier.split('#');

        const usersToBan = await sql<{ id: number }[]>`
            SELECT id FROM users 
            WHERE username = ${username} AND domain = ${domain}
        `;

        if (usersToBan.length === 0) return;

        const userToBanId = usersToBan[0].id;

        bannedUserIds.add(userToBanId);

        await sql`
            UPDATE users 
            SET is_banned = true 
            WHERE id = ${userToBanId}
        `;

        await sql`
            DELETE FROM user_secret_codes 
            WHERE user_id = ${userToBanId}
        `;

        const filteredMessages = messages.filter(m => m.fromUser !== userIdentifier);
        messages.length = 0;
        messages.push(...filteredMessages);

        io.emit('user_banned', userIdentifier);

        for (const [id, socket] of io.sockets.sockets) {
            if (socket.data.user?.username === username && socket.data.user?.domain === domain) {
                socket.disconnect(true);
            }
        }
    });

    socket.on('disconnect', () => {
        userMessageTimestamps.delete(user.id);
        connectedUsers.delete(user.id);
        io.emit('users_count', connectedUsers.size);
        console.log(`User disconnected: ${user.username}#${user.domain}`);
    });
});

console.log(`WebSocket server starting on port ${PORT}...`);
io.listen(Number(PORT));
