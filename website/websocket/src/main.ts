import { Server } from 'socket.io';
import { jwtVerify } from 'jose';
import postgres from 'postgres';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Redis from 'ioredis';
import { checkHardcore } from './moderation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../../website/.env') });

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    console.error("REDIS_URL is not defined in environment variables.");
    process.exit(1);
}
const redis = new Redis(REDIS_URL);

redis.on('error', (err) => console.error('Redis Client Error', err));
redis.on('connect', () => console.log('Connected to Redis'));

function checkVocabulary(text: string, iq: number): { isValid: boolean; limit: number | null } {
    // let maxWordLength: number;

    // if (iq < 90) maxWordLength = 3;
    // else if (iq < 100) maxWordLength = 4;
    // else if (iq < 120) maxWordLength = 5;
    // else if (iq < 130) maxWordLength = 6;
    // else if (iq < 140) maxWordLength = 7;
    // else return { isValid: true, limit: null };

    // const words = text.split(/\s+/);
    // for (const word of words) {
    //     const cleanedWord = word.replace(/[.,!?;:"']/g, '');
    //     if (cleanedWord.length > maxWordLength) {
    //         return { isValid: false, limit: maxWordLength };
    //     }
    // }
    // return { isValid: true, limit: maxWordLength };
    return { isValid: true, limit: null };
}

const RATE_LIMIT = {
    messages: 4,
    window: 2000
};

const SIMILARITY_THRESHOLD = 0.8;
const RECENT_MESSAGES_TO_KEEP = 5;
const REDIS_KEY_BANNED_USERS = 'banned_users_set';
const REDIS_USER_TIMESTAMPS_PREFIX = 'user_timestamps_zset:';
const REDIS_USER_RECENT_MSGS_PREFIX = 'user_recent_msgs:';
const REDIS_DEFAULT_TTL_SECONDS = {
    rateLimit: Math.ceil(RATE_LIMIT.window / 1000) + 60,
    recentMessages: 5 * 60
};

function levenshteinDistance(a: string, b: string): number {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const substitute = matrix[j - 1][i - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0);
            matrix[j][i] = Math.min(
                matrix[j - 1][i] + 1,
                matrix[j][i - 1] + 1,
                substitute
            );
        }
    }
    return matrix[b.length][a.length];
}

function similarity(a: string, b: string): number {
    const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLength = Math.max(a.length, b.length);
    return 1 - distance / maxLength;
}

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

const io = new Server({
    cors: {
        origin: [`https://${process.env.PUBLIC_DOMAIN}`, "http://localhost:5173"],
        credentials: true
    },
    transports: ['websocket']
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

        const isBannedInDb = user.is_banned;
        const isBannedInRedis = await redis.sismember(
            REDIS_KEY_BANNED_USERS,
            user.id.toString()
        );

        if (isBannedInDb || isBannedInRedis) {
            if (isBannedInDb && !isBannedInRedis) {
                await redis.sadd(REDIS_KEY_BANNED_USERS, user.id.toString());
            }
            await sql`
                 DELETE FROM user_secret_codes 
                 WHERE code = ${payload.code as string}
             `;
            return next(new Error('User is banned'));
        }

        socket.data.user = user;
        next();
    } catch (error) {
        console.error('Socket auth error:', error);
        next(new Error('Authentication failed'));
    }
});

let connectedUsers = new Set();

const ipTimestampsMap = new Map<string, number[]>();
const ipRecentMessagesMap = new Map<string, string[]>();
const ipConnectionCount = new Map<string, number>();

function getClientIp(socket: any): string {
    const headers = socket.handshake.headers;
    if (headers['cf-connecting-ip']) {
        return headers['cf-connecting-ip'];
    }
    const xff = headers['x-forwarded-for'];
    if (xff) {
        if (Array.isArray(xff)) {
            return xff[0].split(',')[0].trim();
        } else {
            return xff.split(',')[0].trim();
        }
    }
    return socket.handshake.address;
}

io.on('connection', (socket) => {
    const user = socket.data.user as User;
    const ip = getClientIp(socket);

    const currentIpConnections = ipConnectionCount.get(ip) || 0;
    if (currentIpConnections >= 5) {
        socket.emit('error', { message: 'Connection limit exceeded for this IP.' });
        socket.disconnect(true);
        return;
    }
    ipConnectionCount.set(ip, currentIpConnections + 1);

    connectedUsers.add(user.id);

    io.emit('users_count', connectedUsers.size);

    console.log(`User connected: ${user.username}#${user.domain}`);

    socket.emit('recent_messages', messages.slice(-200));

    socket.on('message', async (text_: unknown) => {
        const isUserBanned = await redis.sismember(
            REDIS_KEY_BANNED_USERS,
            user.id.toString()
        );
        if (isUserBanned) {
            socket.emit('error', {
                message: 'You are banned from sending messages.'
            });
            socket.disconnect(true);
            return;
        }

        if (typeof text_ !== 'string') {
            socket.emit('error', { message: 'Invalid message format' });
            return;
        }

        const text = text_.trim().slice(0, 500);
        if (!text) return;

        if (checkHardcore(text)) {
            socket.emit('error', {
                message: 'Your message was blocked due to inappropriate content.'
            });
            return;
        }

        const ip = getClientIp(socket);
        const now = Date.now();
        const windowStart = now - RATE_LIMIT.window;
        let timestamps = ipTimestampsMap.get(ip) || [];
        timestamps = timestamps.filter(ts => ts > windowStart);
        ipTimestampsMap.set(ip, timestamps);
        const countInWindow = timestamps.length;
        if (countInWindow >= RATE_LIMIT.messages) {
            socket.emit('error', {
                message: `You're sending messages too quickly. Please wait ${RATE_LIMIT.window / 1000} seconds.`
            });
            return;
        }
        timestamps.push(now);
        ipTimestampsMap.set(ip, timestamps);

        // let recentMessages = ipRecentMessagesMap.get(ip) || [];
        // for (const prevMessage of recentMessages) {
        //     if (similarity(text, prevMessage) > SIMILARITY_THRESHOLD) {
        //         socket.emit('error', {
        //             message: 'Your message is too similar to a recent message you sent.'
        //         });
        //         return;
        //     }
        // }

        const { isValid, limit } = checkVocabulary(text, user.iq);
        if (!isValid) {
            socket.emit('error', {
                message: `Message contains words longer than your ${limit}-character limit.`
            });
            return;
        }

        let recentMessages = ipRecentMessagesMap.get(ip) || [];
        recentMessages.push(text);
        if (recentMessages.length > RECENT_MESSAGES_TO_KEEP) {
            recentMessages = recentMessages.slice(-RECENT_MESSAGES_TO_KEEP);
        }
        ipRecentMessagesMap.set(ip, recentMessages);

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

        await redis.sadd(REDIS_KEY_BANNED_USERS, userToBanId.toString());

        const redisKeyUserTimestamps = `${REDIS_USER_TIMESTAMPS_PREFIX}${userToBanId}`;
        const redisKeyUserRecentMessages = `${REDIS_USER_RECENT_MSGS_PREFIX}${userToBanId}`;
        await redis.del(redisKeyUserTimestamps, redisKeyUserRecentMessages);

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
        connectedUsers.delete(user.id);
        io.emit('users_count', connectedUsers.size);
        const currentIpConnections = ipConnectionCount.get(ip);
        if (currentIpConnections) {
            if (currentIpConnections <= 1) {
                ipConnectionCount.delete(ip);
            } else {
                ipConnectionCount.set(ip, currentIpConnections - 1);
            }
        }
        console.log(`User disconnected: ${user.username}#${user.domain}`);
    });
});

console.log(`WebSocket server starting on port ${PORT}...`);
io.listen(Number(PORT));